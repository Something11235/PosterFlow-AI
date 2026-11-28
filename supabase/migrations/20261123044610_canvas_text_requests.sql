-- Keep the canvas in its own metered product; PPT and Tavern reporting use their own tables.
set local lock_timeout = '5s';

create table private.canvas_text_requests (
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  fingerprint text not null,
  kind text not null check (kind in ('storyboard','prompt')),
  requested_model text not null,
  model text,
  attempts jsonb not null default '[]',
  status text not null default 'processing' check (status in ('processing','succeeded','failed')),
  reserved numeric(18,4) not null check (reserved>0),
  charged numeric(18,4),
  model_rates jsonb not null,
  result jsonb,
  usage jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  primary key(user_id,request_id)
);
alter table private.canvas_text_requests enable row level security;
revoke all on private.canvas_text_requests from public,anon,authenticated,service_role;
create index canvas_text_processing_idx on private.canvas_text_requests(created_at) where status='processing';

create function private.canvas_text_view(j private.canvas_text_requests) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_strip_nulls(jsonb_build_object('request_id',j.request_id,'kind',j.kind,'requested_model',j.requested_model,
    'model',case when j.status='processing' then j.requested_model else j.model end,'attempts',j.attempts,
    'status',j.status,'error_code',j.error_code)) || coalesce(j.result,'{}'::jsonb) ||
    jsonb_build_object('billing',jsonb_build_object('status',case when j.status='processing' then 'held'
      when j.error_code is null then 'settled' else 'refunded' end,
      'reserved_credits',j.reserved::text,'charged_credits',j.charged::text,'usage',j.usage));
$$;

create function private.finish_canvas_text_request(p_user_id uuid,p_request_id uuid,p_result jsonb,p_usage jsonb,p_error_code text,
  p_model text,p_attempts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  j private.canvas_text_requests; u jsonb; i numeric; o numeric; c numeric; m numeric; w numeric:=0;
  rates jsonb; attempt_count integer;
  route constant text[]:=array['gpt-6.2-astra','gpt-6.2-sol','deepseek-v4.1-flash'];
  price numeric; refund numeric; reason text:=p_error_code; ledger_key text; meta jsonb;
begin
  perform 1 from public.credit_accounts where user_id=p_user_id for update;
  select * into j from private.canvas_text_requests where user_id=p_user_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','CANVAS_AI_NOT_FOUND'); end if;
  if j.status<>'processing' then return jsonb_build_object('ok',true,'request',private.canvas_text_view(j)); end if;
  if (p_result is null) = (reason is null) or (reason is not null and reason !~ '^CANVAS_AI_[A-Z_]{1,60}$') then
    raise exception 'invalid canvas outcome';
  end if;
  if jsonb_typeof(p_attempts) is distinct from 'array' then raise exception 'invalid canvas attempts'; end if;
  attempt_count:=jsonb_array_length(p_attempts);
  if attempt_count>cardinality(route)
      or p_model is distinct from (p_attempts->-1->>'model')
      or (p_result is not null and attempt_count=0)
      or exists (
        select 1 from jsonb_array_elements(p_attempts) with ordinality as a(attempt,idx)
        where jsonb_typeof(attempt) is distinct from 'object'
          or attempt - 'model' - 'outcome' <> '{}'::jsonb
          or attempt->>'model' is distinct from route[idx]
          or coalesce(attempt->>'outcome','') not in ('timeout','unavailable','succeeded','failed')
          or (idx<attempt_count and attempt->>'outcome' not in ('unavailable','timeout'))
          or (idx=attempt_count and (attempt->>'outcome'='succeeded') <> (p_result is not null))
      ) then raise exception 'invalid canvas attempts'; end if;
  if p_result is not null then
    if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>524288 then
      raise exception 'invalid canvas result';
    elsif j.kind='prompt' then
      if p_result-'prompt'<>'{}'::jsonb or jsonb_typeof(p_result->'prompt') is distinct from 'string'
          or p_result->>'prompt' !~ '[^[:space:]]' or length(p_result->>'prompt')>6000 then raise exception 'invalid canvas prompt'; end if;
    elsif p_result-'shots'<>'{}'::jsonb or jsonb_typeof(p_result->'shots') is distinct from 'array' then
      raise exception 'invalid canvas storyboard';
    elsif jsonb_array_length(p_result->'shots') not between 1 and 16 then raise exception 'invalid shot count';
    elsif exists(
      select 1 from jsonb_array_elements(p_result->'shots') shot
      where jsonb_typeof(shot) is distinct from 'object'
        or jsonb_typeof(shot->'duration') is distinct from 'number'
        or shot->>'duration' !~ '^([1-9]|[12][0-9]|30)$'
        or exists(select 1 from (values ('title',120),('description',2000),('camera',500),
                ('imagePrompt',6000),('videoPrompt',6000)) fields(k,lim)
          where jsonb_typeof(shot->k) is distinct from 'string'
             or shot->>k !~ '[^[:space:]]' or length(shot->>k)>lim)
    ) then raise exception 'invalid canvas shot';
    end if;
  end if;
  u:=private.tavern_usage(p_usage);
  if p_result is not null then
    rates:=j.model_rates->p_model;
    if p_usage->'cache_write_tokens' is not null and p_usage->'cache_write_tokens'<>'null'::jsonb then
      if jsonb_typeof(p_usage->'cache_write_tokens')='number' then w:=(p_usage->>'cache_write_tokens')::numeric;
      else w:=null; end if;
      if w is null or w<0 or w>9007199254740991 or trunc(w)<>w then
        u:=jsonb_set(u,'{status}','"invalid"');
      else u:=u||jsonb_build_object('cache_write_tokens',w); end if;
    end if;
    i:=(u->>'input_tokens')::numeric; o:=(u->>'output_tokens')::numeric;
    m:=(u->>'cache_miss_tokens')::numeric; c:=coalesce((u->>'cache_read_tokens')::numeric,i-m,0);
    if u->>'status'='confirmed' and i is not null and o is not null and (u->>'total_tokens')::numeric=i+o
       and c between 0 and i and w between 0 and i-c and (w=0 or rates->>'cache_write' is not null)
       and (m is null or m=i-c) and coalesce((u->>'reasoning_tokens')::numeric,0)<=o then
      price:=ceil(((i-c-w)*(rates->>'input')::numeric+o*(rates->>'output')::numeric+
        c*(rates->>'cache_read')::numeric+w*coalesce((rates->>'cache_write')::numeric,0))/100)/10000;
    end if;
    if price is null or price>j.reserved then reason:='CANVAS_AI_USAGE_UNCONFIRMED'; end if;
  end if;
  if reason is not null then price:=0; end if;
  refund:=j.reserved-price;
  ledger_key:=p_user_id::text||':'||p_request_id::text;
  meta:=jsonb_build_object('media_type','canvas','kind',j.kind,'request_id',p_request_id,
    'model',p_model,'requested_model',j.requested_model,'attempts',p_attempts,'pricing_version',1,'reserved_credits',j.reserved::text);
  update public.credit_accounts set balance=balance+refund,total_spent=total_spent+price,
    total_refunded=total_refunded+refund,updated_at=now() where user_id=p_user_id;
  if reason is null then
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
    values(p_user_id,'spend',0,'canvas-text-spend:'||ledger_key,meta||jsonb_build_object('charged_credits',price::text,'usage',u));
  end if;
  if refund>0 then
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
    values(p_user_id,'refund',refund,'canvas-text-refund:'||ledger_key,meta||jsonb_build_object('reason',coalesce(reason,'unused_reservation')));
  end if;
  update private.canvas_text_requests set status=case when p_result is null then 'failed' else 'succeeded' end,
    result=p_result,usage=u,charged=price,error_code=reason,model=p_model,attempts=p_attempts
    where user_id=p_user_id and request_id=p_request_id returning * into j;
  return jsonb_build_object('ok',true,'request',private.canvas_text_view(j));
end; $$;

create function private.read_canvas_text_request(p_user_id uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.canvas_text_requests;
begin
  select * into j from private.canvas_text_requests where user_id=p_user_id and request_id=p_request_id;
  if not found then return jsonb_build_object('code','CANVAS_AI_NOT_FOUND'); end if;
  if j.status='processing' and j.created_at<now()-interval '15 minutes' then
    return private.finish_canvas_text_request(p_user_id,p_request_id,null,null,'CANVAS_AI_RESULT_EXPIRED',null,'[]');
  end if;
  return jsonb_build_object('ok',true,'request',private.canvas_text_view(j));
end; $$;

create function private.begin_canvas_text_request(p_user_id uuid,p_request_id uuid,p_model text,p_kind text,
  p_fingerprint text,p_input_bound integer,p_output_bound integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  j private.canvas_text_requests; balance_now numeric; hold numeric; stale uuid;
  -- Same BuyToken group and prices as PPT: credits per million tokens; DeepSeek at its peak tariff.
  -- Snapshot all three choices now so a price change during retries cannot change this request.
  rates constant jsonb:='{
    "gpt-6.2-astra":{"input":48,"output":240,"cache_read":2.4,"cache_write":60},
    "gpt-6.2-sol":{"input":12,"output":60,"cache_read":0.6,"cache_write":15},
    "deepseek-v4.1-flash":{"input":12,"output":48,"cache_read":0.24}
  }';
begin
  if p_request_id is null or p_model is distinct from 'gpt-6.2-astra' or p_kind is null
     or p_kind not in ('prompt','storyboard') or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_input_bound is null or p_input_bound not between 1 and 125000
     or p_output_bound is null or p_output_bound not between 1 and 16000 then
    return jsonb_build_object('code','CANVAS_AI_INPUT_INVALID'); end if;
  perform 1 from public.profiles where id=p_user_id and status='active' and deleted_at is null for update;
  if not found then return jsonb_build_object('code','ACCOUNT_FROZEN'); end if;
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('code','EMAIL_UNVERIFIED'); end if;
  perform 1 from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('code','INSUFFICIENT_CREDITS'); end if;
  for stale in select request_id from private.canvas_text_requests where user_id=p_user_id
    and status='processing' and created_at<now()-interval '15 minutes' loop
    perform private.read_canvas_text_request(p_user_id,stale);
  end loop;
  select * into j from private.canvas_text_requests where user_id=p_user_id and request_id=p_request_id;
  if found then
    if j.kind<>p_kind or j.requested_model<>p_model or j.fingerprint<>p_fingerprint then
      return jsonb_build_object('code','CANVAS_AI_REQUEST_CONFLICT'); end if;
    return jsonb_build_object('ok',true,'leader',false,'request',private.canvas_text_view(j));
  end if;
  if (select count(*) from private.canvas_text_requests where user_id=p_user_id and status='processing')>=3 then
    return jsonb_build_object('code','CANVAS_AI_PENDING_LIMIT'); end if;
  select ceil(max(p_input_bound*greatest((r->>'input')::numeric,(r->>'cache_read')::numeric,(r->>'cache_write')::numeric)
      +p_output_bound*(r->>'output')::numeric)/100)/10000 into hold from jsonb_each(rates) as prices(model,r);
  select balance into balance_now from public.credit_accounts where user_id=p_user_id;
  if balance_now<hold then return jsonb_build_object('code','INSUFFICIENT_CREDITS'); end if;
  insert into private.canvas_text_requests(user_id,request_id,requested_model,kind,fingerprint,reserved,model_rates)
    values(p_user_id,p_request_id,p_model,p_kind,p_fingerprint,hold,rates) returning * into j;
  update public.credit_accounts set balance=balance-hold,updated_at=now() where user_id=p_user_id;
  insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
    values(p_user_id,'reserve',-hold,'canvas-text-reserve:'||p_user_id::text||':'||p_request_id::text,
      jsonb_build_object('media_type','canvas','kind',p_kind,'request_id',p_request_id,'model',p_model,'pricing_version',1));
  return jsonb_build_object('ok',true,'leader',true,'request',private.canvas_text_view(j));
end; $$;

create function public.begin_canvas_text_request(p_user_id uuid,p_request_id uuid,p_model text,p_kind text,
  p_fingerprint text,p_input_bound integer,p_output_bound integer) returns jsonb language sql security invoker set search_path='' as $$
  select private.begin_canvas_text_request(p_user_id,p_request_id,p_model,p_kind,p_fingerprint,p_input_bound,p_output_bound);
$$;
create function public.read_canvas_text_request(p_user_id uuid,p_request_id uuid) returns jsonb language sql security invoker set search_path='' as $$
  select private.read_canvas_text_request(p_user_id,p_request_id);
$$;
create function public.finish_canvas_text_request(p_user_id uuid,p_request_id uuid,p_result jsonb,p_usage jsonb,p_error_code text,
  p_model text,p_attempts jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.finish_canvas_text_request(p_user_id,p_request_id,p_result,p_usage,p_error_code,p_model,p_attempts);
$$;
revoke all on function private.canvas_text_view(private.canvas_text_requests),
  private.begin_canvas_text_request(uuid,uuid,text,text,text,integer,integer),public.begin_canvas_text_request(uuid,uuid,text,text,text,integer,integer),
  private.read_canvas_text_request(uuid,uuid),public.read_canvas_text_request(uuid,uuid),
  private.finish_canvas_text_request(uuid,uuid,jsonb,jsonb,text,text,jsonb),public.finish_canvas_text_request(uuid,uuid,jsonb,jsonb,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function private.begin_canvas_text_request(uuid,uuid,text,text,text,integer,integer),public.begin_canvas_text_request(uuid,uuid,text,text,text,integer,integer),
  private.read_canvas_text_request(uuid,uuid),public.read_canvas_text_request(uuid,uuid),
  private.finish_canvas_text_request(uuid,uuid,jsonb,jsonb,text,text,jsonb),public.finish_canvas_text_request(uuid,uuid,jsonb,jsonb,text,text,jsonb) to service_role;

do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('posterflow-expire-canvas-text-holds','*/5 * * * *',
      $job$select private.read_canvas_text_request(j.user_id,j.request_id)
        from (select user_id,request_id from private.canvas_text_requests where status='processing'
        and created_at<now()-interval '15 minutes' order by user_id,request_id limit 100) j;$job$);
  end if;
end; $$;
