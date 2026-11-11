-- Add billed user-draft assistance; no price changes or existing ledger updates.
set local lock_timeout = '5s';
alter table public.tavern_requests drop constraint tavern_requests_kind_check;
alter table public.tavern_requests add constraint tavern_requests_kind_check check (kind in ('chat','summary','assist'));

create or replace function private.begin_tavern_request(p_user_id uuid,p_request_id uuid,p_fingerprint text,
  p_model text,p_kind text,p_reserved_credits numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.tavern_requests; b numeric; p public.profiles;
begin
  if p_user_id is null or p_request_id is null or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
     or p_model is distinct from 'deepseek-v4.1-flash' or p_kind is null or p_kind not in ('chat','summary','assist')
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


-- Service-only administration, no prompt or reply text in any result.
create index if not exists tavern_requests_created_idx on public.tavern_requests(created_at desc);
create function private.admin_tavern_overview(p_actor_id uuid,p_days integer default 30) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare since_at timestamptz; stats jsonb; requests jsonb;
begin
 if not exists(select 1 from public.profiles p join auth.users a on a.id=p.id
   where p.id=p_actor_id and p.role='admin' and p.status='active' and p.deleted_at is null and a.email_confirmed_at is not null) then
  return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED'); end if;
 if p_days is null or p_days not in (7,30,90) then return jsonb_build_object('ok',false,'code','TAVERN_INPUT_INVALID'); end if;
 since_at := (date_trunc('day',now() at time zone 'Asia/Shanghai') - (p_days-1)*interval '1 day') at time zone 'Asia/Shanghai';
 select jsonb_build_object('requests',count(*),'users',count(distinct user_id),
   'chat',count(*) filter(where kind='chat'),'summary',count(*) filter(where kind='summary'),'assist',count(*) filter(where kind='assist'),
   'settled',count(*) filter(where billing_status='settled'),'refunded',count(*) filter(where billing_status='refunded'),
   'unresolved',count(*) filter(where billing_status in ('held','awaiting_review')),
   'input_tokens',sum((usage->>'input_tokens')::numeric)::text,
   'output_tokens',sum((usage->>'output_tokens')::numeric)::text,
   'cache_read_tokens',sum((usage->>'cache_read_tokens')::numeric)::text,
   'missing_cache_calls',count(*) filter(where usage is not null and usage->>'cache_read_tokens' is null),
   'credits_spent',coalesce(sum(charged_credits) filter(where billing_status='settled'),0)::text,
   'credits_held',coalesce(sum(reserved_credits) filter(where billing_status in ('held','awaiting_review')),0)::text)
 into stats from public.tavern_requests where created_at>=since_at;
 select coalesce(jsonb_agg(jsonb_build_object('request_id',j.request_id,'user_id',j.user_id,'kind',j.kind,'model',j.model,
   'status',j.status,'billing_status',j.billing_status,'reserved_credits',j.reserved_credits::text,'charged_credits',j.charged_credits::text,
   'usage',j.usage,'error_code',j.error_code,'created_at',j.created_at) order by j.created_at desc),'[]'::jsonb)
 into requests from (select request_id,user_id,kind,model,status,billing_status,reserved_credits,charged_credits,usage,error_code,created_at
   from public.tavern_requests where created_at>=since_at order by created_at desc limit 50) j;
 return jsonb_build_object('ok',true,'days',p_days,'since',since_at,'stats',stats,'requests',requests);
end; $$;
create function public.admin_tavern_overview(p_actor_id uuid,p_days integer default 30) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.admin_tavern_overview(p_actor_id,p_days); $$;
revoke all on function private.admin_tavern_overview(uuid,integer), public.admin_tavern_overview(uuid,integer) from public,anon,authenticated;
grant execute on function private.admin_tavern_overview(uuid,integer), public.admin_tavern_overview(uuid,integer) to service_role;
