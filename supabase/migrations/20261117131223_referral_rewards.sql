-- Direct invitation rewards: every new voucher redemption grants an additional
-- 10% to its immutable inviter. No historical binding or reward backfill.
set local lock_timeout = '5s';
-- Close the gap between the existing-email snapshot and the registration hook.
lock table auth.users in share row exclusive mode;

create table private.referral_codes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  code text not null unique check (code ~ '^PF[0-9A-F]{12}$'),
  created_at timestamptz not null default now()
);
-- Retain attribution and award facts after account deletion. UUIDs here are
-- historical identifiers, deliberately not cascading foreign keys to profiles.
create table private.referral_bindings (
  invitee_user_id uuid primary key,
  inviter_user_id uuid not null,
  created_at timestamptz not null default now(),
  check (invitee_user_id <> inviter_user_id)
);
create index referral_bindings_inviter_idx on private.referral_bindings(inviter_user_id, created_at desc);
create table private.referral_email_claims (
  email_hash text primary key check (email_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now()
);
create table private.referral_rewards (
  id uuid primary key default gen_random_uuid(),
  code_id uuid not null unique references public.credit_codes(id),
  inviter_user_id uuid not null,
  invitee_user_id uuid not null references private.referral_bindings(invitee_user_id),
  redeemed_credits numeric(18,4) not null check (redeemed_credits > 0 and redeemed_credits <> 'NaN'::numeric),
  reward_credits numeric(18,4) not null check (reward_credits > 0 and reward_credits <> 'NaN'::numeric),
  created_at timestamptz not null default now(),
  check (inviter_user_id <> invitee_user_id),
  check (reward_credits = round(redeemed_credits * 0.1, 4))
);
create index referral_rewards_inviter_idx on private.referral_rewards(inviter_user_id, created_at desc, id desc);
alter table private.referral_codes enable row level security;
alter table private.referral_bindings enable row level security;
alter table private.referral_email_claims enable row level security;
alter table private.referral_rewards enable row level security;
revoke all on private.referral_codes, private.referral_bindings, private.referral_email_claims, private.referral_rewards
  from public, anon, authenticated, service_role;

alter table public.credit_transactions drop constraint credit_transactions_type_check;
alter table public.credit_transactions add constraint credit_transactions_type_check
  check (type in ('signup_bonus', 'reserve', 'spend', 'refund', 'admin_adjustment', 'purchase', 'referral_bonus'));

create function private.ensure_referral_code(p_user_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_code text; v_attempt integer;
begin
  select code into v_code from private.referral_codes where user_id = p_user_id;
  if found then return v_code; end if;
  for v_attempt in 1..100 loop
    v_code := 'PF' || upper(encode(extensions.gen_random_bytes(6), 'hex'));
    insert into private.referral_codes(user_id, code) values(p_user_id, v_code) on conflict do nothing;
    select code into v_code from private.referral_codes where user_id = p_user_id;
    if found then return v_code; end if;
  end loop;
  raise exception 'REFERRAL_CODE_GENERATION_FAILED';
end;
$$;
revoke all on function private.ensure_referral_code(uuid) from public, anon, authenticated, service_role;

create function private.prevent_referral_rebind() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'REFERRAL_BINDING_IMMUTABLE' using errcode = '23514';
end;
$$;
revoke all on function private.prevent_referral_rebind() from public, anon, authenticated, service_role;
create trigger referral_binding_immutable before update or delete on private.referral_bindings
  for each row execute function private.prevent_referral_rebind();

-- Include previously deleted, bonus-claimed emails, without copying raw emails.
insert into private.referral_email_claims(email_hash)
select encode(extensions.digest(lower(btrim(email)), 'sha256'), 'hex')
from auth.users where nullif(btrim(email), '') is not null
on conflict do nothing;
insert into private.referral_email_claims(email_hash)
select email_hash from public.signup_bonus_claims on conflict do nothing;
do $$
declare v_user record;
begin
  for v_user in select id from public.profiles order by id loop
    perform private.ensure_referral_code(v_user.id);
  end loop;
end;
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  display_name text;
  v_code text;
  v_inviter uuid;
  v_hash text;
  v_first_email boolean := false;
begin
  -- Preserve the existing username/profile/account creation behavior.
  display_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'username', '')), '');
  if display_name is null then
    display_name := split_part(coalesce(new.email, 'posterflow-user'), '@', 1);
  end if;
  display_name := left(display_name, 48);
  if exists (select 1 from public.profiles where lower(username) = lower(display_name)) then
    display_name := left(display_name, 40) || '-' || left(new.id::text, 7);
  end if;
  insert into public.profiles(id, username) values(new.id, display_name) on conflict(id) do nothing;
  insert into public.credit_accounts(user_id) values(new.id) on conflict(user_id) do nothing;

  -- Metadata is untrusted, one-time registration input. It is never consulted
  -- on later login, metadata updates, snapshots, or voucher redemption.
  v_code := upper(btrim(coalesce(new.raw_user_meta_data ->> 'referral_code', '')));
  if nullif(btrim(new.email), '') is not null then
    v_hash := encode(extensions.digest(lower(btrim(new.email)), 'sha256'), 'hex');
    insert into private.referral_email_claims(email_hash) values(v_hash) on conflict do nothing;
    v_first_email := found;
  end if;
  if v_code <> '' then
    if v_code !~ '^PF[0-9A-F]{12}$' or not v_first_email then
      raise exception 'REFERRAL_CODE_INVALID' using errcode = '22023';
    end if;
    select c.user_id into v_inviter from private.referral_codes c
      join public.profiles p on p.id = c.user_id
      where c.code = v_code and p.status = 'active' and p.deleted_at is null and p.id <> new.id;
    if not found then raise exception 'REFERRAL_CODE_INVALID' using errcode = '22023'; end if;
    insert into private.referral_bindings(invitee_user_id, inviter_user_id) values(new.id, v_inviter);
  end if;
  perform private.ensure_referral_code(new.id);
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Changing an email does not open another registration attribution opportunity.
create function private.remember_referral_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(btrim(new.email), '') is not null then
    insert into private.referral_email_claims(email_hash)
      values(encode(extensions.digest(lower(btrim(new.email)), 'sha256'), 'hex')) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function private.remember_referral_email() from public, anon, authenticated, service_role;
create trigger referral_remember_changed_email after update of email on auth.users
  for each row when (old.email is distinct from new.email) execute function private.remember_referral_email();

create function private.validate_referral_code(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok', true, 'valid', exists(
    select 1 from private.referral_codes c join public.profiles p on p.id = c.user_id
    where length(p_code) <= 32 and c.code = upper(btrim(p_code))
      and p.status = 'active' and p.deleted_at is null
  ));
$$;
create function public.validate_referral_code(p_code text) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select private.validate_referral_code(p_code);
$$;

create function private.referral_snapshot(p_user_id uuid, p_limit integer default 20, p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_code text; v_count bigint;
begin
  if not exists(select 1 from public.profiles where id = p_user_id and status = 'active' and deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_FROZEN');
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REFERRAL_INPUT');
  end if;
  select code into v_code from private.referral_codes where user_id = p_user_id;
  select count(*) into v_count from private.referral_rewards where inviter_user_id = p_user_id;
  return jsonb_build_object('ok', true, 'code', v_code, 'rate', 0.1,
    'invited_count', (select count(*) from private.referral_bindings where inviter_user_id = p_user_id),
    'total_rewards', (select coalesce(sum(reward_credits), 0) from private.referral_rewards where inviter_user_id = p_user_id),
    'has_more', v_count > p_offset::bigint + p_limit,
    'records', coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc, r.id desc) from (
      select a.id, case when p.deleted_at is null then coalesce(p.username, '已注销用户') else '已注销用户' end as invitee_name,
        a.redeemed_credits, a.reward_credits, a.created_at
      from private.referral_rewards a left join public.profiles p on p.id = a.invitee_user_id
      where a.inviter_user_id = p_user_id order by a.created_at desc, a.id desc limit p_limit offset p_offset
    ) r), '[]'::jsonb));
end;
$$;
create function public.referral_snapshot(p_user_id uuid, p_limit integer default 20, p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.referral_snapshot(p_user_id, p_limit, p_offset);
$$;
revoke all on function private.validate_referral_code(text), public.validate_referral_code(text),
  private.referral_snapshot(uuid,integer,integer), public.referral_snapshot(uuid,integer,integer) from public, anon, authenticated;
grant execute on function private.validate_referral_code(text), public.validate_referral_code(text),
  private.referral_snapshot(uuid,integer,integer), public.referral_snapshot(uuid,integer,integer) to service_role;

create or replace function private.redeem_credit_code(p_user_id uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.credit_codes; b public.credit_code_batches;
  v_balance numeric; v_attempt integer; v_batch uuid; v_inviter uuid; v_reward numeric(18,4);
begin
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then return jsonb_build_object('ok',false,'code','EMAIL_UNVERIFIED');end if;
  if not exists(select 1 from public.profiles where id=p_user_id and status='active' and deleted_at is null) then return jsonb_build_object('ok',false,'code','ACCOUNT_FROZEN');end if;
  insert into private.credit_code_attempts(user_id,window_start,attempts) values(p_user_id,now(),1)
  on conflict(user_id) do update set window_start=case when private.credit_code_attempts.window_start<=now()-interval '10 minutes' then now() else private.credit_code_attempts.window_start end,
  attempts=case when private.credit_code_attempts.window_start<=now()-interval '10 minutes' then 1 else private.credit_code_attempts.attempts+1 end returning attempts into v_attempt;
  if v_attempt>12 then return jsonb_build_object('ok',false,'code','CREDIT_CODE_RATE_LIMIT');end if;
  if coalesce(p_hash,'') !~ '^[a-f0-9]{64}$' then return jsonb_build_object('ok',false,'code','CREDIT_CODE_UNAVAILABLE');end if;
  select batch_id into v_batch from public.credit_codes where code_hash=p_hash;
  if not found then return jsonb_build_object('ok',false,'code','CREDIT_CODE_UNAVAILABLE');end if;
  -- Keep batch/card ordering; lock participating profiles, then accounts, in
  -- UUID order. Profile KEY SHARE must precede account locks so deleting an
  -- inviter cannot invert the profile FK / account cascade lock order.
  select * into b from public.credit_code_batches where id=v_batch for update;
  select * into c from public.credit_codes where code_hash=p_hash for update;
  if c.status='redeemed' and c.redeemed_by=p_user_id then
    select balance into v_balance from public.credit_accounts where user_id=p_user_id;
    return jsonb_build_object('ok',true,'idempotent',true,'credits',b.credits,'balance',v_balance);
  end if;
  if b.status<>'active' or c.status<>'ready' then return jsonb_build_object('ok',false,'code','CREDIT_CODE_UNAVAILABLE');end if;
  select inviter_user_id into v_inviter from private.referral_bindings where invitee_user_id=p_user_id;
  perform 1 from public.profiles where id=p_user_id or id=v_inviter order by id for key share;
  perform 1 from public.credit_accounts where user_id=p_user_id or user_id=v_inviter order by user_id for update;
  select balance into v_balance from public.credit_accounts where user_id=p_user_id;
  if not found then return jsonb_build_object('ok',false,'code','ACCOUNT_FROZEN');end if;
  insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
  values(p_user_id,'purchase',b.credits,'credit-code:'||c.id::text,
    jsonb_build_object('source','credit_code','batch_id',b.id,'code_id',c.id,'package_id',b.package_id,'nominal_amount_fen',b.nominal_amount_fen));
  update public.credit_accounts set balance=balance+b.credits,total_granted=total_granted+b.credits,updated_at=now()
    where user_id=p_user_id returning balance into v_balance;
  update public.credit_codes set status='redeemed',redeemed_by=p_user_id,redeemed_at=now() where id=c.id;
  insert into public.credit_code_events(batch_id,code_id,actor_id,action) values(b.id,c.id,p_user_id,'redeem');

  -- Freeze blocks spending, not earned accrual. A deleted inviter must never
  -- prevent the invited user's full voucher credit from being redeemed.
  if v_inviter is not null and exists(select 1 from public.credit_accounts a join public.profiles p on p.id=a.user_id
      where a.user_id=v_inviter and p.deleted_at is null) then
    v_reward := round(b.credits * 0.1, 4);
    insert into private.referral_rewards(code_id,inviter_user_id,invitee_user_id,redeemed_credits,reward_credits)
      values(c.id,v_inviter,p_user_id,b.credits,v_reward);
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(v_inviter,'referral_bonus',v_reward,'referral:'||c.id::text,
        jsonb_build_object('source','referral','code_id',c.id,'invitee_user_id',p_user_id,'redeemed_credits',b.credits,'rate',0.1));
    update public.credit_accounts set balance=balance+v_reward,total_granted=total_granted+v_reward,updated_at=now() where user_id=v_inviter;
  end if;
  return jsonb_build_object('ok',true,'idempotent',false,'credits',b.credits,'balance',v_balance);
end;
$$;
-- CREATE OR REPLACE preserves the existing service-only redemption ACL.

-- Include earned referral credit in grants, without treating it as paid income.
-- Guard the exact existing expression so an unexpected production definition
-- fails safely instead of silently replacing a different metric or function.
do $$
declare
  v_definition text := pg_get_functiondef('public.get_admin_metrics(date,date)'::regprocedure);
  v_old text := $old$type in ('signup_bonus', 'admin_adjustment', 'purchase')$old$;
  v_new text := $new$type in ('signup_bonus', 'admin_adjustment', 'purchase', 'referral_bonus')$new$;
begin
  if (length(v_definition)-length(replace(v_definition,v_old,''))) / length(v_old) <> 1 then
    raise exception 'REFERRAL_METRICS_BASELINE_MISMATCH';
  end if;
  execute replace(v_definition,v_old,v_new);
end;
$$;
