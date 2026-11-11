-- User-approved continuous billing: actual input/output, standard input rate
-- when cache details are not supplied. Existing rates and terminal bills stay.
set local lock_timeout = '5s';
create or replace function private.quote_tavern_credits(p_model text,p_usage jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
declare u jsonb; i numeric; o numeric; t numeric; c numeric; m numeric; r numeric; price numeric;
begin
  if p_model is distinct from 'deepseek-v4.1-flash' then return null; end if;
  u := private.tavern_usage(p_usage);
  if u is null or u->>'status' is distinct from 'confirmed' then return null; end if;
  i := (u->>'input_tokens')::numeric; o := (u->>'output_tokens')::numeric;
  t := (u->>'total_tokens')::numeric; c := (u->>'cache_read_tokens')::numeric;
  m := (u->>'cache_miss_tokens')::numeric; r := (u->>'reasoning_tokens')::numeric;
  -- Missing cache details mean standard input pricing, not unknown usage.
  -- Preserve null cache fields in stored usage; never claim a measured zero.
  if c is null then
    if m is not null and (m<0 or m>i) then return null; end if;
    c := case when m is null then 0 else i-m end;
  end if;
  if i is null or o is null or t is null or i+o > 9007199254740991 or t <> i+o
     or c > i or (m is not null and m <> i-c) or (r is not null and r > o) then return null; end if;
  price := ceil(((i-c)*6 + o*24 + c*0.12) / 1000000 * 10000) / 10000;
  if price > 100000 then return null; end if;
  return price;
end; $$;

create or replace function private.finish_tavern_request(p_user_id uuid,p_request_id uuid,p_outcome text,
  p_usage jsonb,p_response_text text,p_error_code text,p_actor_id uuid default null,p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.tavern_requests; b numeric; charge numeric; refund numeric; meta jsonb; u jsonb;
begin
  if p_user_id is null or p_request_id is null or p_outcome is null
     or p_outcome not in ('completed','not_submitted','rejected','unknown')
     or char_length(p_response_text)>65536
     or (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,100}$') then
    return jsonb_build_object('ok',false,'code','TAVERN_EVENT_INVALID'); end if;
  select balance into b from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'code','TAVERN_NOT_FOUND'); end if;
  select * into j from public.tavern_requests where user_id=p_user_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'code','TAVERN_NOT_FOUND'); end if;
  -- Terminal accounting never repeats or changes, including a late failure event.
  if j.billing_status in ('settled','refunded') then
    return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text); end if;
  if p_actor_id is not null and j.status='reserved' and j.created_at > now()-interval '5 minutes' then
    return jsonb_build_object('ok',false,'code','TAVERN_REVIEW_NOT_READY'); end if;
  -- Only an explicitly authorized administrator can change a completed review.
  if j.billing_status='awaiting_review' and p_actor_id is null
     and not (p_outcome='completed' and private.quote_tavern_credits(j.model,p_usage) is not null
       and private.quote_tavern_credits(j.model,p_usage)<=j.reserved_credits) then
    return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text); end if;
  meta := jsonb_build_object('media_type','tavern','kind',j.kind,'request_id',j.request_id,
    'model',j.model,'pricing_version',j.pricing_version,'reserved_credits',j.reserved_credits::text);
  if p_actor_id is not null then
    if not exists(select 1 from public.profiles p join auth.users a on a.id=p.id
      where p.id=p_actor_id and p.role='admin' and p.status='active' and p.deleted_at is null
        and a.email_confirmed_at is not null) then
      return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED'); end if;
    meta := meta || jsonb_build_object('admin_user_id',p_actor_id,'reason',p_reason);
  end if;
  if p_outcome='completed' then
    u := private.tavern_usage(p_usage);
    charge := private.quote_tavern_credits(j.model,p_usage);
    if charge is null or charge > j.reserved_credits then
      if p_actor_id is not null then return jsonb_build_object('ok',false,'code','TAVERN_USAGE_UNSETTLEABLE'); end if;
      update public.tavern_requests set status='completed',billing_status='awaiting_review',usage=u,
        response_text=p_response_text,response_expires_at=case when p_response_text is not null then now()+interval '12 hours' end,
        error_code=case when charge is null then 'TAVERN_USAGE_UNCONFIRMED' else 'TAVERN_RESERVE_EXCEEDED' end,
        updated_at=now() where id=j.id returning * into j;
      return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text);
    end if;
    refund := j.reserved_credits-charge;
    update public.credit_accounts set balance=balance+refund,total_spent=total_spent+charge,
      total_refunded=total_refunded+refund,updated_at=now() where user_id=p_user_id returning balance into b;
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(p_user_id,'spend',0,'tavern-spend:'||j.id::text,meta||jsonb_build_object('charged_credits',charge::text,'usage',u));
    if refund>0 then
      insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
        values(p_user_id,'refund',refund,'tavern-refund:'||j.id::text,meta||jsonb_build_object('reason',coalesce(p_reason,'unused_reservation')));
    end if;
    update public.tavern_requests set status='completed',billing_status='settled',charged_credits=charge,usage=u,
      response_text=case when p_actor_id is null then p_response_text else response_text end,
      response_expires_at=case when p_actor_id is null and p_response_text is not null then now()+interval '12 hours' else response_expires_at end,
      error_code=null,settled_at=now(),updated_at=now(),
      review_resolution=case when p_actor_id is not null then jsonb_build_object('actor_id',p_actor_id,'action','settle','reason',p_reason,'resolved_at',now()) end
      where id=j.id returning * into j;
  elsif p_outcome in ('not_submitted','rejected') then
    update public.credit_accounts set balance=balance+j.reserved_credits,total_refunded=total_refunded+j.reserved_credits,
      updated_at=now() where user_id=p_user_id returning balance into b;
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(p_user_id,'refund',j.reserved_credits,'tavern-refund:'||j.id::text,
        meta||jsonb_build_object('reason',coalesce(p_reason,p_outcome)));
    update public.tavern_requests set status=case when status='completed' then status else 'failed' end,
      billing_status='refunded',charged_credits=0,error_code=p_error_code,settled_at=now(),updated_at=now(),
      review_resolution=case when p_actor_id is not null then jsonb_build_object('actor_id',p_actor_id,'action','refund','reason',p_reason,'resolved_at',now()) end
      where id=j.id returning * into j;
  else
    update public.tavern_requests set status='unknown',error_code=p_error_code,updated_at=now()
      where id=j.id returning * into j;
  end if;
  return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text);
end; $$;

create or replace function private.begin_tavern_request(p_user_id uuid,p_request_id uuid,p_fingerprint text,
  p_model text,p_kind text,p_reserved_credits numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.tavern_requests; b numeric; p public.profiles;
begin
  if p_user_id is null or p_request_id is null or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_model is distinct from 'deepseek-v4.1-flash' or p_kind is null or p_kind not in ('chat','summary')
     or p_reserved_credits is null or p_reserved_credits = 'NaN'::numeric or p_reserved_credits <= 0
     or p_reserved_credits > 100000 or trunc(p_reserved_credits,4) <> p_reserved_credits then
    return jsonb_build_object('ok',false,'code','TAVERN_INPUT_INVALID');
  end if;
  -- Same lock order as legacy image reservations: profile, account, request.
  select * into p from public.profiles where id=p_user_id for update;
  if not found or p.status <> 'active' or p.deleted_at is not null then
    return jsonb_build_object('ok',false,'code','ACCOUNT_FROZEN'); end if;
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('ok',false,'code','EMAIL_UNVERIFIED'); end if;
  select balance into b from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'code','INSUFFICIENT_CREDITS'); end if;
  select * into j from public.tavern_requests where user_id=p_user_id and request_id=p_request_id for update;
  if found then
    if j.request_fingerprint <> p_fingerprint or j.model <> p_model or j.kind <> p_kind
       or j.reserved_credits <> p_reserved_credits then
      return jsonb_build_object('ok',false,'code','TAVERN_REQUEST_CONFLICT'); end if;
    return jsonb_build_object('ok',true,'leader',false,'request',private.tavern_request_view(j),'balance',b::text);
  end if;
  if (select count(*) from public.tavern_requests where user_id=p_user_id and billing_status='held') >= 3 then
    return jsonb_build_object('ok',false,'code','TAVERN_PENDING_LIMIT'); end if;
  if b < p_reserved_credits then return jsonb_build_object('ok',false,'code','INSUFFICIENT_CREDITS'); end if;
  insert into public.tavern_requests(user_id,request_id,request_fingerprint,model,kind,reserved_credits)
    values(p_user_id,p_request_id,p_fingerprint,p_model,p_kind,p_reserved_credits) returning * into j;
  update public.credit_accounts set balance=balance-p_reserved_credits,updated_at=now()
    where user_id=p_user_id returning balance into b;
  insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
    values(p_user_id,'reserve',-p_reserved_credits,'tavern-reserve:'||j.id::text,
      jsonb_build_object('media_type','tavern','kind',p_kind,'request_id',p_request_id,'model',p_model,'pricing_version',1));
  return jsonb_build_object('ok',true,'leader',true,'request',private.tavern_request_view(j),'balance',b::text);
end; $$;

-- Resolve only completed, priceable legacy replies. No model calls, no guessed
-- input/output, no repeat charge, and no change to response retention deadlines.
do $$ declare v_request public.tavern_requests; result jsonb; begin
  for v_request in select * from public.tavern_requests where status='completed'
    and billing_status='awaiting_review' and error_code='TAVERN_USAGE_UNCONFIRMED'
    order by user_id,created_at loop
    if private.quote_tavern_credits(v_request.model,v_request.usage) is not null
       and private.quote_tavern_credits(v_request.model,v_request.usage)<=v_request.reserved_credits then
      result := private.finish_tavern_request(v_request.user_id,v_request.request_id,'completed',v_request.usage,v_request.response_text,null);
      if result->>'ok' is distinct from 'true' then raise exception 'Tavern reconciliation failed'; end if;
      update public.tavern_requests set response_expires_at=v_request.response_expires_at where id=v_request.id;
    end if;
  end loop;
end; $$;
