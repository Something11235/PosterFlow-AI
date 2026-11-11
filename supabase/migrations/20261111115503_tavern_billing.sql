-- Local preparation only. This migration does not enable a model or supply a Key.
-- Independent ledger: never apply the image-job timeout refund policy to chat.
set local lock_timeout = '5s';

create table public.tavern_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  model text not null check (model = 'deepseek-v4.1-flash'),
  kind text not null check (kind in ('chat','summary')),
  pricing_version integer not null default 1 check (pricing_version = 1),
  status text not null default 'reserved' check (status in ('reserved','completed','failed','unknown')),
  billing_status text not null default 'held' check (billing_status in ('held','settled','refunded','awaiting_review')),
  reserved_credits numeric(18,4) not null check (reserved_credits > 0 and reserved_credits <= 100000),
  charged_credits numeric(18,4) check (charged_credits >= 0 and charged_credits <= reserved_credits),
  usage jsonb,
  response_text text check (char_length(response_text) <= 65536),
  response_expires_at timestamptz,
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,100}$'),
  review_resolution jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  unique (user_id, request_id),
  check ((billing_status in ('settled','refunded')) = (charged_credits is not null)),
  check ((response_text is null) or (response_expires_at is not null))
);
create index tavern_requests_user_created_idx on public.tavern_requests(user_id,created_at desc);
create index tavern_requests_review_idx on public.tavern_requests(billing_status,created_at)
  where billing_status in ('held','awaiting_review');
create index tavern_requests_response_expiry_idx on public.tavern_requests(response_expires_at)
  where response_text is not null;
alter table public.tavern_requests enable row level security;
revoke all on table public.tavern_requests from public, anon, authenticated, service_role;
-- Reads and writes go through the explicit service-only RPCs below.

create function private.tavern_usage(p_usage jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare k text; v numeric; bad boolean := false; result jsonb;
begin
  if p_usage is null or jsonb_typeof(p_usage) <> 'object' then return null; end if;
  result := jsonb_build_object('status',case when p_usage->>'status' in ('confirmed','partial','missing','invalid')
    then p_usage->>'status' else 'invalid' end);
  foreach k in array array['input_tokens','output_tokens','total_tokens','cache_read_tokens','cache_miss_tokens','reasoning_tokens'] loop
    v := null;
    if p_usage ? k and p_usage->k <> 'null'::jsonb then
      if jsonb_typeof(p_usage->k) <> 'number' then bad := true;
      else
        v := (p_usage->>k)::numeric;
        if v < 0 or v > 9007199254740991 or trunc(v) <> v then v := null; bad := true; end if;
      end if;
    end if;
    result := result || jsonb_build_object(k,v);
  end loop;
  if bad then result := jsonb_set(result,'{status}','"invalid"'); end if;
  return result;
end; $$;

-- Independently recompute the fixed website quote; never accept client amounts.
-- Cache reads belong to input, reasoning belongs to output, neither adds tokens.
create function private.quote_tavern_credits(p_model text,p_usage jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
declare u jsonb; i numeric; o numeric; t numeric; c numeric; m numeric; r numeric; price numeric;
begin
  if p_model is distinct from 'deepseek-v4.1-flash' then return null; end if;
  u := private.tavern_usage(p_usage);
  if u is null or u->>'status' is distinct from 'confirmed' then return null; end if;
  i := (u->>'input_tokens')::numeric; o := (u->>'output_tokens')::numeric;
  t := (u->>'total_tokens')::numeric; c := (u->>'cache_read_tokens')::numeric;
  m := (u->>'cache_miss_tokens')::numeric; r := (u->>'reasoning_tokens')::numeric;
  if i is null or o is null or t is null or c is null or i+o > 9007199254740991 or t <> i+o
     or c > i or (m is not null and m <> i-c) or (r is not null and r > o) then return null; end if;
  price := ceil(((i-c)*6 + o*24 + c*0.12) / 1000000 * 10000) / 10000;
  if price > 100000 then return null; end if;
  return price;
end; $$;

create function private.tavern_request_view(p_row public.tavern_requests) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'request_id',p_row.request_id,'user_id',p_row.user_id,'model',p_row.model,'kind',p_row.kind,
    'pricing_version',p_row.pricing_version,'status',p_row.status,'billing_status',p_row.billing_status,
    'reserved_credits',p_row.reserved_credits::text,'charged_credits',p_row.charged_credits::text,
    'usage',p_row.usage,'response_text',case when p_row.response_expires_at > now() then p_row.response_text else null end,
    'response_expires_at',p_row.response_expires_at,'error_code',p_row.error_code,
    'created_at',p_row.created_at,'updated_at',p_row.updated_at,'settled_at',p_row.settled_at,
    'review_resolution',p_row.review_resolution);
$$;

create function private.begin_tavern_request(p_user_id uuid,p_request_id uuid,p_fingerprint text,
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
  if exists(select 1 from public.tavern_requests where user_id=p_user_id and billing_status='awaiting_review') then
    return jsonb_build_object('ok',false,'code','TAVERN_REVIEW_REQUIRED'); end if;
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

-- Internal finalizer: callers already authorize the event. No service-role grant.
create function private.finish_tavern_request(p_user_id uuid,p_request_id uuid,p_outcome text,
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
  if j.billing_status='awaiting_review' and p_actor_id is null then
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

create function private.apply_tavern_request(p_user_id uuid,p_request_id uuid,p_outcome text,
  p_usage jsonb default null,p_response_text text default null,p_error_code text default null) returns jsonb
language sql security definer set search_path = '' as $$
  select private.finish_tavern_request(p_user_id,p_request_id,p_outcome,p_usage,p_response_text,p_error_code);
$$;

create function private.get_tavern_requests(p_user_id uuid,p_request_id uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok',true,'requests',coalesce(jsonb_agg(private.tavern_request_view(j) order by j.created_at desc),'[]'::jsonb))
    from (select * from public.tavern_requests where user_id=p_user_id
      and (p_request_id is null or request_id=p_request_id) order by created_at desc limit 50) j;
$$;

create function private.list_tavern_billing_reviews(p_actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.profiles p join auth.users a on a.id=p.id where p.id=p_actor_id
    and p.role='admin' and p.status='active' and p.deleted_at is null and a.email_confirmed_at is not null) then
    return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED'); end if;
  return (select jsonb_build_object('ok',true,'requests',coalesce(jsonb_agg(private.tavern_request_view(j) order by j.created_at),'[]'::jsonb))
    from (select * from public.tavern_requests where billing_status='awaiting_review'
      or (billing_status='held' and (status='unknown' or created_at <= now()-interval '5 minutes'))
      order by created_at limit 100) j);
end; $$;

create function private.resolve_tavern_request(p_actor_id uuid,p_user_id uuid,p_request_id uuid,
  p_action text,p_usage jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare owners integer; target uuid;
begin
  if not exists(select 1 from public.profiles p join auth.users a on a.id=p.id where p.id=p_actor_id
    and p.role='admin' and p.status='active' and p.deleted_at is null and a.email_confirmed_at is not null) then
    return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED'); end if;
  if p_action is null or p_action not in ('refund','settle') or p_reason is null
     or char_length(trim(p_reason)) not between 5 and 500 or p_request_id is null then
    return jsonb_build_object('ok',false,'code','TAVERN_REVIEW_INVALID'); end if;
  target := p_user_id;
  if target is null then
    select count(*),min(user_id::text)::uuid into owners,target from public.tavern_requests where request_id=p_request_id;
    if owners=0 then return jsonb_build_object('ok',false,'code','TAVERN_NOT_FOUND'); end if;
    if owners>1 then return jsonb_build_object('ok',false,'code','TAVERN_REQUEST_AMBIGUOUS'); end if;
  end if;
  return private.finish_tavern_request(target,p_request_id,
    case when p_action='settle' then 'completed' else 'rejected' end,
    p_usage,null,'TAVERN_ADMIN_RESOLVED',p_actor_id,trim(p_reason));
end; $$;

create function private.prune_tavern_responses() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  update public.tavern_requests set response_text=null where response_text is not null and response_expires_at<=now();
  get diagnostics removed=row_count;
  return removed;
end; $$;

create function public.tavern_billing_ready() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('ok',true,'ready',true,'version',1,'pricing_version',1,'precision','0.0001');
$$;
create function public.begin_tavern_request(p_user_id uuid,p_request_id uuid,p_fingerprint text,p_model text,p_kind text,p_reserved_credits numeric)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.begin_tavern_request(p_user_id,p_request_id,p_fingerprint,p_model,p_kind,p_reserved_credits);
$$;
create function public.apply_tavern_request(p_user_id uuid,p_request_id uuid,p_outcome text,p_usage jsonb default null,p_response_text text default null,p_error_code text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.apply_tavern_request(p_user_id,p_request_id,p_outcome,p_usage,p_response_text,p_error_code);
$$;
create function public.get_tavern_requests(p_user_id uuid,p_request_id uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.get_tavern_requests(p_user_id,p_request_id);
$$;
create function public.list_tavern_billing_reviews(p_actor_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.list_tavern_billing_reviews(p_actor_id);
$$;
create function public.resolve_tavern_request(p_actor_id uuid,p_user_id uuid,p_request_id uuid,p_action text,p_usage jsonb,p_reason text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.resolve_tavern_request(p_actor_id,p_user_id,p_request_id,p_action,p_usage,p_reason);
$$;

-- Explicit ACL on every new function, including helpers; no default PUBLIC execute.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as signature,n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.proname in (
      'tavern_billing_ready','begin_tavern_request','apply_tavern_request','get_tavern_requests',
      'list_tavern_billing_reviews','resolve_tavern_request','prune_tavern_responses',
      'tavern_usage','quote_tavern_credits','tavern_request_view','finish_tavern_request') loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',f.signature);
    if f.proname in ('tavern_billing_ready','begin_tavern_request','apply_tavern_request','get_tavern_requests',
      'list_tavern_billing_reviews','resolve_tavern_request') then
      execute format('grant execute on function %s to service_role',f.signature);
    end if;
  end loop;
end; $$;
grant usage on schema private to service_role;

-- Existing installations use pg_cron. Local runtimes without it need no extension.
-- Read RPCs always mask expired content even if a scheduled cleanup is delayed.
do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('posterflow-tavern-response-retention-12h','7 * * * *','select private.prune_tavern_responses();');
  end if;
end; $$;
