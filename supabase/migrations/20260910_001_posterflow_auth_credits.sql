-- PosterFlow AI: identity, credits, generation ledger, and administrator metrics.
-- Apply this migration in the Supabase SQL editor or with the Supabase CLI.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (char_length(username) between 2 and 48),
  role text not null default 'user' check (role in ('user', 'admin')),
  status text not null default 'active' check (status in ('active', 'frozen')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  deleted_at timestamptz
);

create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username));

create table if not exists public.credit_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  total_granted integer not null default 0 check (total_granted >= 0),
  total_spent integer not null default 0 check (total_spent >= 0),
  total_refunded integer not null default 0 check (total_refunded >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  request_id uuid not null unique,
  billing_mode text not null check (billing_mode in ('platform', 'own_key')),
  provider text not null,
  model text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'running', 'succeeded', 'failed', 'refunded')),
  requested_count integer not null check (requested_count between 1 and 4),
  generated_count integer not null default 0 check (generated_count >= 0),
  reserved_credits integer not null default 0 check (reserved_credits >= 0),
  charged_credits integer not null default 0 check (charged_credits >= 0),
  image_keys jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  prompt text,
  error_code text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index if not exists generation_jobs_user_created_idx
  on public.generation_jobs (user_id, created_at desc);
create index if not exists generation_jobs_status_created_idx
  on public.generation_jobs (status, created_at desc);
create index if not exists generation_jobs_mode_created_idx
  on public.generation_jobs (billing_mode, created_at desc);

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  job_id uuid references public.generation_jobs(id) on delete set null,
  type text not null check (type in ('signup_bonus', 'reserve', 'spend', 'refund', 'admin_adjustment')),
  delta integer not null,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists credit_transactions_user_created_idx
  on public.credit_transactions (user_id, created_at desc);
create unique index if not exists credit_transactions_one_signup_bonus
  on public.credit_transactions (user_id)
  where type = 'signup_bonus';

-- Compatible aggregate structure for scheduled reporting and future dashboards.
create or replace view public.user_daily_stats
with (security_invoker = true) as
select
  user_id,
  created_at::date as activity_date,
  count(*) as job_count,
  sum(generated_count) as generated_count,
  count(*) filter (where status = 'succeeded') as succeeded_jobs,
  count(*) filter (where status in ('failed', 'refunded')) as failed_or_refunded_jobs,
  avg(duration_ms) filter (where duration_ms is not null) as average_duration_ms
from public.generation_jobs
where user_id is not null
group by user_id, created_at::date;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  display_name text;
begin
  display_name := nullif(trim(coalesce(new.raw_user_meta_data ->> 'username', '')), '');
  if display_name is null then
    display_name := split_part(coalesce(new.email, 'posterflow-user'), '@', 1);
  end if;
  display_name := left(display_name, 48);
  if exists (select 1 from public.profiles where lower(username) = lower(display_name)) then
    display_name := left(display_name, 40) || '-' || left(new.id::text, 7);
  end if;
  insert into public.profiles (id, username)
  values (new.id, display_name)
  on conflict (id) do nothing;
  insert into public.credit_accounts (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.ensure_signup_bonus(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_confirmed_at timestamptz;
  v_balance integer;
begin
  select email_confirmed_at into v_confirmed_at
  from auth.users
  where id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'AUTH_USER_NOT_FOUND');
  end if;
  if v_confirmed_at is null then
    return jsonb_build_object('ok', false, 'code', 'EMAIL_UNVERIFIED');
  end if;

  insert into public.credit_accounts (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  insert into public.credit_transactions (user_id, type, delta, idempotency_key, metadata)
  values (p_user_id, 'signup_bonus', 10, 'signup-bonus-v1', '{"source":"email_verification"}'::jsonb)
  on conflict (user_id, idempotency_key) do nothing;

  if found then
    update public.credit_accounts
    set balance = balance + 10,
        total_granted = total_granted + 10,
        updated_at = now()
    where user_id = p_user_id;
  end if;

  select balance into v_balance from public.credit_accounts where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'balance', coalesce(v_balance, 0));
end;
$$;

create or replace function public.reserve_platform_credits(
  p_user_id uuid,
  p_request_id uuid,
  p_count integer,
  p_provider text,
  p_model text,
  p_prompt text,
  p_user_daily_limit integer default null,
  p_platform_daily_limit integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing public.generation_jobs%rowtype;
  v_balance integer;
  v_status text;
  v_user_total integer;
  v_platform_total integer;
  v_job_id uuid;
begin
  if p_count < 1 or p_count > 4 then
    return jsonb_build_object('ok', false, 'code', 'PARAMETER_INVALID');
  end if;
  perform public.ensure_signup_bonus(p_user_id);
  select status into v_status from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AUTH_USER_NOT_FOUND');
  end if;
  if v_status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_FROZEN');
  end if;
  if not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'code', 'EMAIL_UNVERIFIED');
  end if;

  select * into v_existing from public.generation_jobs where request_id = p_request_id for update;
  if found then
    if v_existing.user_id <> p_user_id then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true,
      'existing', true,
      'job_id', v_existing.id,
      'status', v_existing.status,
      'images', v_existing.image_keys,
      'balance', (select balance from public.credit_accounts where user_id = p_user_id)
    );
  end if;

  if p_user_daily_limit is not null and p_user_daily_limit > 0 then
    select coalesce(sum(requested_count), 0) into v_user_total
    from public.generation_jobs
    where user_id = p_user_id and billing_mode = 'platform' and created_at >= date_trunc('day', now());
    if v_user_total + p_count > p_user_daily_limit then
      return jsonb_build_object('ok', false, 'code', 'USER_DAILY_LIMIT');
    end if;
  end if;
  if p_platform_daily_limit is not null and p_platform_daily_limit > 0 then
    select coalesce(sum(requested_count), 0) into v_platform_total
    from public.generation_jobs
    where billing_mode = 'platform' and created_at >= date_trunc('day', now());
    if v_platform_total + p_count > p_platform_daily_limit then
      return jsonb_build_object('ok', false, 'code', 'PLATFORM_DAILY_LIMIT');
    end if;
  end if;

  select balance into v_balance from public.credit_accounts where user_id = p_user_id for update;
  if coalesce(v_balance, 0) < p_count then
    return jsonb_build_object('ok', false, 'code', 'CREDITS_INSUFFICIENT', 'balance', coalesce(v_balance, 0));
  end if;

  insert into public.generation_jobs (
    user_id, request_id, billing_mode, provider, model, status, requested_count,
    reserved_credits, prompt, metadata
  ) values (
    p_user_id, p_request_id, 'platform', p_provider, p_model, 'running', p_count,
    p_count, left(p_prompt, 6000), '{}'::jsonb
  ) returning id into v_job_id;

  update public.credit_accounts
  set balance = balance - p_count, updated_at = now()
  where user_id = p_user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (p_user_id, v_job_id, 'reserve', -p_count, 'reserve:' || p_request_id::text, jsonb_build_object('count', p_count));

  select balance into v_balance from public.credit_accounts where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'job_id', v_job_id, 'status', 'running', 'balance', v_balance);
end;
$$;

create or replace function public.settle_generation(
  p_job_id uuid,
  p_generated_count integer,
  p_duration_ms integer,
  p_image_keys jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_charge integer;
  v_refund integer;
  v_balance integer;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if v_job.status in ('succeeded', 'refunded', 'failed') then
    select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
    return jsonb_build_object('ok', true, 'existing', true, 'status', v_job.status, 'balance', v_balance);
  end if;
  v_charge := greatest(0, least(p_generated_count, v_job.reserved_credits));
  v_refund := v_job.reserved_credits - v_charge;
  update public.generation_jobs
  set status = case when v_charge > 0 then 'succeeded' else 'refunded' end,
      generated_count = v_charge,
      charged_credits = v_charge,
      image_keys = coalesce(p_image_keys, '[]'::jsonb),
      duration_ms = greatest(coalesce(p_duration_ms, 0), 0),
      settled_at = now()
  where id = p_job_id;
  update public.credit_accounts
  set total_spent = total_spent + v_charge,
      total_refunded = total_refunded + v_refund,
      balance = balance + v_refund,
      updated_at = now()
  where user_id = v_job.user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (v_job.user_id, p_job_id, 'spend', 0, 'spend:' || p_job_id::text, jsonb_build_object('count', v_charge))
  on conflict (user_id, idempotency_key) do nothing;
  if v_refund > 0 then
    insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
    values (v_job.user_id, p_job_id, 'refund', v_refund, 'refund:' || p_job_id::text, jsonb_build_object('reason', 'partial_or_empty_result'))
    on conflict (user_id, idempotency_key) do nothing;
  end if;
  select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'status', case when v_charge > 0 then 'succeeded' else 'refunded' end, 'balance', v_balance, 'charged', v_charge, 'refunded', v_refund);
end;
$$;

create or replace function public.refund_generation(p_job_id uuid, p_reason text default 'provider_failed')
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_balance integer;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if v_job.status in ('succeeded', 'refunded', 'failed') then
    select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
    return jsonb_build_object('ok', true, 'existing', true, 'balance', v_balance);
  end if;
  update public.generation_jobs
  set status = 'refunded', error_code = left(coalesce(p_reason, 'provider_failed'), 120), settled_at = now()
  where id = p_job_id;
  update public.credit_accounts
  set balance = balance + v_job.reserved_credits,
      total_refunded = total_refunded + v_job.reserved_credits,
      updated_at = now()
  where user_id = v_job.user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (v_job.user_id, p_job_id, 'refund', v_job.reserved_credits, 'refund:' || p_job_id::text, jsonb_build_object('reason', p_reason))
  on conflict (user_id, idempotency_key) do nothing;
  select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'balance', v_balance, 'refunded', v_job.reserved_credits);
end;
$$;

create or replace function public.record_own_key_generation(
  p_user_id uuid,
  p_request_id uuid,
  p_provider text,
  p_model text,
  p_prompt text,
  p_requested_count integer,
  p_generated_count integer,
  p_duration_ms integer,
  p_image_keys jsonb,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_job_id uuid;
begin
  insert into public.generation_jobs (
    user_id, request_id, billing_mode, provider, model, status, requested_count,
    generated_count, charged_credits, image_keys, metadata, prompt, duration_ms, error_code, settled_at
  ) values (
    p_user_id, p_request_id, 'own_key', p_provider, p_model,
    case when p_generated_count > 0 then 'succeeded' else 'failed' end,
    greatest(1, least(p_requested_count, 4)), greatest(0, p_generated_count), 0,
    coalesce(p_image_keys, '[]'::jsonb), '{}'::jsonb, left(p_prompt, 6000), greatest(coalesce(p_duration_ms, 0), 0),
    left(p_error_code, 120), now()
  ) on conflict (request_id) do update
  set generated_count = excluded.generated_count,
      image_keys = excluded.image_keys,
      duration_ms = excluded.duration_ms,
      error_code = excluded.error_code,
      status = excluded.status,
      settled_at = now()
  returning id into v_job_id;
  return jsonb_build_object('ok', true, 'job_id', v_job_id);
end;
$$;

create or replace function public.get_admin_metrics(p_from date default current_date - 30, p_to date default current_date)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'registered_users', (select count(*) from public.profiles where created_at::date between p_from and p_to),
    'verified_users', (select count(*) from auth.users where email_confirmed_at is not null and created_at::date between p_from and p_to),
    'daily_active_users', (select count(distinct user_id) from public.generation_jobs where created_at >= current_date),
    'monthly_active_users', (select count(distinct user_id) from public.generation_jobs where created_at >= date_trunc('month', current_date)),
    'generated_images', (select coalesce(sum(generated_count), 0) from public.generation_jobs where created_at::date between p_from and p_to),
    'success_rate', (select coalesce(round(100.0 * count(*) filter (where status = 'succeeded') / nullif(count(*), 0), 1), 0) from public.generation_jobs where created_at::date between p_from and p_to),
    'average_duration_ms', (select coalesce(round(avg(duration_ms)), 0) from public.generation_jobs where created_at::date between p_from and p_to and duration_ms is not null),
    'credits_granted', (select coalesce(sum(delta) filter (where type in ('signup_bonus', 'admin_adjustment') and delta > 0), 0) from public.credit_transactions where created_at::date between p_from and p_to),
    'credits_consumed', (select coalesce(sum(charged_credits), 0) from public.generation_jobs where created_at::date between p_from and p_to),
    'credits_refunded', (select coalesce(sum(delta) filter (where type = 'refund'), 0) from public.credit_transactions where created_at::date between p_from and p_to),
    'platform_jobs', (select count(*) from public.generation_jobs where billing_mode = 'platform' and created_at::date between p_from and p_to),
    'own_key_jobs', (select count(*) from public.generation_jobs where billing_mode = 'own_key' and created_at::date between p_from and p_to),
    'trend', coalesce((select jsonb_agg(row_to_json(t) order by t.activity_date) from (
      select created_at::date as activity_date, count(*) as jobs, sum(generated_count) as images,
        count(*) filter (where status = 'succeeded') as succeeded
      from public.generation_jobs where created_at::date between p_from and p_to group by created_at::date
    ) t), '[]'::jsonb)
  );
$$;

alter table public.profiles enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.generation_jobs enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id and role = 'user');
drop policy if exists "credit_accounts_select_own" on public.credit_accounts;
create policy "credit_accounts_select_own" on public.credit_accounts for select using (auth.uid() = user_id);
drop policy if exists "credit_transactions_select_own" on public.credit_transactions;
create policy "credit_transactions_select_own" on public.credit_transactions for select using (auth.uid() = user_id);
drop policy if exists "generation_jobs_select_own" on public.generation_jobs;
create policy "generation_jobs_select_own" on public.generation_jobs for select using (auth.uid() = user_id);

revoke all on function public.ensure_signup_bonus(uuid) from public, anon, authenticated;
revoke all on function public.reserve_platform_credits(uuid, uuid, integer, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.settle_generation(uuid, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function public.refund_generation(uuid, text) from public, anon, authenticated;
revoke all on function public.record_own_key_generation(uuid, uuid, text, text, text, integer, integer, integer, jsonb, text) from public, anon, authenticated;
revoke all on function public.get_admin_metrics(date, date) from public, anon, authenticated;

grant execute on function public.ensure_signup_bonus(uuid) to service_role;
grant execute on function public.reserve_platform_credits(uuid, uuid, integer, text, text, text, integer, integer) to service_role;
grant execute on function public.settle_generation(uuid, integer, integer, jsonb) to service_role;
grant execute on function public.refund_generation(uuid, text) to service_role;
grant execute on function public.record_own_key_generation(uuid, uuid, text, text, text, integer, integer, integer, jsonb, text) to service_role;
grant execute on function public.get_admin_metrics(date, date) to service_role;
