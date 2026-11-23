-- Chat uses the same reservation, pricing snapshot and idempotent settlement as deck edits.
set local lock_timeout = '5s';

alter table private.ppt_requests
  drop constraint ppt_requests_kind_check,
  add constraint ppt_requests_kind_check check (kind in ('generate','edit','chat'));

create or replace function private.begin_ppt_request(p_user_id uuid,p_request_id uuid,p_model text,p_kind text,
  p_fingerprint text,p_input_bound integer,p_output_bound integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.ppt_requests; b numeric; hold numeric; ir numeric; outr numeric; cr numeric; wr numeric; stale uuid;
begin
  if p_request_id is null or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_kind is null or p_kind not in ('generate','edit','chat') or p_input_bound is null or p_output_bound is null
     or p_input_bound not between 1 and 250000 or p_output_bound not between 1 and 16000 then
    return jsonb_build_object('code','PPT_INPUT_INVALID'); end if;
  -- Credits per million tokens, 15 credits/RMB. DeepSeek always uses BuyToken's peak rate.
  select r.i,r.o,r.c,r.w into ir,outr,cr,wr from (values
    ('gpt-6.2-astra',48,240,2.4,60),('gpt-6.2-sol',12,60,0.6,15),('deepseek-v4.1-flash',12,48,0.24,null)
  ) as r(model,i,o,c,w) where r.model=p_model;
  if not found then return jsonb_build_object('code','PPT_INPUT_INVALID'); end if;
  perform 1 from public.profiles where id=p_user_id and status='active' and deleted_at is null for update;
  if not found then return jsonb_build_object('code','ACCOUNT_FROZEN'); end if;
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('code','EMAIL_UNVERIFIED'); end if;
  select balance into b from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('code','INSUFFICIENT_CREDITS'); end if;
  for stale in select request_id from private.ppt_requests where user_id=p_user_id and status='processing'
      and created_at<now()-interval '15 minutes' loop
    perform private.finish_ppt_request(p_user_id,stale,null,null,'PPT_RESULT_EXPIRED');
  end loop;
  select * into j from private.ppt_requests where user_id=p_user_id and request_id=p_request_id;
  if found then
    if j.fingerprint<>p_fingerprint or j.model<>p_model or j.kind<>p_kind then
      return jsonb_build_object('code','PPT_REQUEST_CONFLICT'); end if;
    return jsonb_build_object('ok',true,'leader',false,'request',private.ppt_view(j));
  end if;
  if (select count(*) from private.ppt_requests where user_id=p_user_id and status='processing')>=3 then
    return jsonb_build_object('code','PPT_PENDING_LIMIT'); end if;
  hold := ceil((p_input_bound*greatest(ir,wr)+p_output_bound*outr)/100)/10000;
  select balance into b from public.credit_accounts where user_id=p_user_id;
  if b<hold then return jsonb_build_object('code','INSUFFICIENT_CREDITS'); end if;
  insert into private.ppt_requests(user_id,request_id,fingerprint,model,kind,reserved,input_rate,output_rate,cache_rate,cache_write_rate)
    values(p_user_id,p_request_id,p_fingerprint,p_model,p_kind,hold,ir,outr,cr,wr) returning * into j;
  update public.credit_accounts set balance=balance-hold,updated_at=now() where user_id=p_user_id;
  insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
    values(p_user_id,'reserve',-hold,'ppt-reserve:'||p_user_id::text||':'||p_request_id::text,
      jsonb_build_object('media_type','ppt','request_id',p_request_id,'kind',p_kind,'model',p_model,'pricing_version',1));
  return jsonb_build_object('ok',true,'leader',true,'request',private.ppt_view(j));
end; $$;

create or replace function private.finish_ppt_request(p_user_id uuid,p_request_id uuid,p_result jsonb,p_usage jsonb,p_error_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.ppt_requests; u jsonb; i numeric; o numeric; c numeric; m numeric; w numeric := 0; price numeric;
  refund numeric; meta jsonb; reason text := p_error_code; ledger_key text; result_key text;
begin
  perform 1 from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('code','PPT_NOT_FOUND'); end if;
  select * into j from private.ppt_requests where user_id=p_user_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('code','PPT_NOT_FOUND'); end if;
  if j.status <> 'processing' then return jsonb_build_object('ok',true,'request',private.ppt_view(j)); end if;
  if reason is not null and reason !~ '^PPT_[A-Z_]{1,80}$' then raise exception 'invalid outcome'; end if;
  if p_result is not null then
    result_key := case j.kind when 'chat' then 'reply' when 'edit' then 'slide' else 'deck' end;
    if reason is not null or jsonb_typeof(p_result) <> 'object'
       or octet_length(p_result::text)>524288 then raise exception 'invalid PPT result'; end if;
    if p_result - result_key <> '{}'::jsonb or jsonb_typeof(p_result->result_key) is distinct from
       (case when j.kind='chat' then 'string' else 'object' end)
       or (j.kind='chat' and p_result->>'reply' !~ '[^[:space:]]') then
      raise exception 'invalid PPT result';
    end if;
  end if;
  if p_result is null and reason is null then raise exception 'missing PPT outcome'; end if;
  u := private.tavern_usage(p_usage);
  if p_usage->'cache_write_tokens' is not null and p_usage->'cache_write_tokens'<>'null'::jsonb then
    if jsonb_typeof(p_usage->'cache_write_tokens')='number' then w := (p_usage->>'cache_write_tokens')::numeric;
    else w := null; end if;
    if w is null or w<0 or w>9007199254740991 or trunc(w)<>w then
      u := jsonb_set(u,'{status}','"invalid"');
    else
      u := u || jsonb_build_object('cache_write_tokens',w);
    end if;
  end if;
  -- Only deliverable work with consistent measured usage may spend credits. If a
  -- vendor loses its counters, preserve the result at no charge rather than guessing.
  if p_result is not null then
    i := (u->>'input_tokens')::numeric; o := (u->>'output_tokens')::numeric;
    m := (u->>'cache_miss_tokens')::numeric;
    c := coalesce((u->>'cache_read_tokens')::numeric, i-m, 0);
    if u->>'status'='confirmed' and i is not null and o is not null
       and (u->>'total_tokens')::numeric=i+o and c between 0 and i and w between 0 and i-c
       and (w=0 or j.cache_write_rate is not null)
       and (m is null or m=i-c) and coalesce((u->>'reasoning_tokens')::numeric,0)<=o then
      price := ceil(((i-c-w)*j.input_rate + o*j.output_rate + c*j.cache_rate + w*coalesce(j.cache_write_rate,0))/100)/10000;
    end if;
    if price is null or price>j.reserved then reason := 'PPT_USAGE_UNCONFIRMED'; end if;
  end if;
  if reason is not null then price := 0; end if;
  refund := j.reserved-price;
  ledger_key := p_user_id::text || ':' || p_request_id::text;
  meta := jsonb_build_object('media_type','ppt','kind',j.kind,'request_id',p_request_id,
    'model',j.model,'pricing_version',1,'reserved_credits',j.reserved::text);
  update public.credit_accounts set balance=balance+refund,total_spent=total_spent+price,
    total_refunded=total_refunded+refund,updated_at=now() where user_id=p_user_id;
  if reason is null then
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(p_user_id,'spend',0,'ppt-spend:'||ledger_key,meta||jsonb_build_object('charged_credits',price::text,'usage',u));
  end if;
  if refund>0 then
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(p_user_id,'refund',refund,'ppt-refund:'||ledger_key,
        meta || jsonb_build_object('reason',coalesce(reason,'unused_reservation')));
  end if;
  update private.ppt_requests set status=case when p_result is null then 'failed' else 'succeeded' end,
    result=p_result,usage=u,charged=price,error_code=reason,finished_at=now()
    where user_id=p_user_id and request_id=p_request_id returning * into j;
  return jsonb_build_object('ok',true,'request',private.ppt_view(j));
end; $$;
