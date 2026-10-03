-- Configurable signup bonus for administrators.
-- The setting is server-only: browsers can only reach it through the
-- authenticated administrator endpoints in backend/server.py.

create table if not exists public.credit_settings (
  setting_key text primary key check (setting_key = 'signup_bonus_credits'),
  integer_value integer not null check (integer_value between 0 and 10000),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_reason text not null default ''
);

insert into public.credit_settings (setting_key, integer_value, updated_reason)
values ('signup_bonus_credits', 10, '初始默认值')
on conflict (setting_key) do nothing;

alter table public.credit_settings enable row level security;
revoke all on table public.credit_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.credit_settings to service_role;

create or replace function public.get_credit_settings()
returns jsonb
language sql
security definer
stable
set search_path = public, auth
as $$
  select jsonb_build_object(
    'signup_bonus_credits', integer_value,
    'updated_by', updated_by,
    'updated_at', updated_at,
    'updated_reason', updated_reason
  )
  from public.credit_settings
  where setting_key = 'signup_bonus_credits';
$$;

create or replace function public.update_signup_bonus_credits(
  p_admin_user_id uuid,
  p_credits integer,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_current public.credit_settings%rowtype;
  v_reason text := left(trim(coalesce(p_reason, '')), 240);
begin
  -- The Flask layer checks both the configured administrator allow-list
  -- and the profile role. Keep the active-profile check here as a second
  -- line of defense while still supporting ADMIN_USER_IDS administrators.
  if not exists (
    select 1 from public.profiles
    where id = p_admin_user_id and status = 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  if p_credits is null or p_credits < 0 or p_credits > 10000 then
    return jsonb_build_object('ok', false, 'code', 'SIGNUP_BONUS_INVALID');
  end if;

  insert into public.credit_settings (setting_key, integer_value, updated_by, updated_at, updated_reason)
  values ('signup_bonus_credits', p_credits, p_admin_user_id, now(), v_reason)
  on conflict (setting_key) do update set
    integer_value = excluded.integer_value,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at,
    updated_reason = excluded.updated_reason
  returning * into v_current;

  return jsonb_build_object(
    'ok', true,
    'settings', jsonb_build_object(
      'signup_bonus_credits', v_current.integer_value,
      'updated_by', v_current.updated_by,
      'updated_at', v_current.updated_at,
      'updated_reason', v_current.updated_reason
    )
  );
end;
$$;

-- Use the current setting only when a verified user claims the bonus for the
-- first time. Existing claims remain unchanged and cannot be re-awarded.
create or replace function public.ensure_signup_bonus(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_email text;
  v_hash text;
  v_balance integer;
  v_bonus integer;
begin
  select email into v_email
  from auth.users
  where id = p_user_id and email_confirmed_at is not null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'EMAIL_UNVERIFIED');
  end if;

  select integer_value into v_bonus
  from public.credit_settings
  where setting_key = 'signup_bonus_credits';
  v_bonus := coalesce(v_bonus, 10);

  v_hash := encode(extensions.digest(lower(trim(v_email)), 'sha256'), 'hex');
  insert into public.credit_accounts(user_id)
  values (p_user_id)
  on conflict(user_id) do nothing;
  insert into public.signup_bonus_claims(email_hash, user_id)
  values (v_hash, p_user_id)
  on conflict do nothing;
  if found then
    insert into public.credit_transactions(user_id, type, delta, idempotency_key, metadata)
    values (
      p_user_id,
      'signup_bonus',
      v_bonus,
      'signup-bonus-v1',
      jsonb_build_object('source', 'email_verification', 'credits', v_bonus)
    );
    update public.credit_accounts
    set balance = balance + v_bonus,
        total_granted = total_granted + v_bonus,
        updated_at = now()
    where user_id = p_user_id;
  end if;

  select balance into v_balance
  from public.credit_accounts
  where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'balance', coalesce(v_balance, 0), 'signup_bonus_credits', v_bonus);
end;
$$;

-- Include the setting in the existing admin payload so the console can load
-- metrics and configuration together.
create or replace function public.get_admin_console_snapshot(
  p_from date default current_date - 29,
  p_to date default current_date,
  p_search text default '',
  p_limit integer default 50
)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'settings', coalesce((select public.get_credit_settings()), jsonb_build_object('signup_bonus_credits', 10)),
    'metrics', public.get_admin_metrics(p_from, p_to),
    'users', coalesce((select jsonb_agg(row_to_json(u) order by u.updated_at desc nulls last) from (
      select p.id as user_id, p.username, p.role, p.status, au.email, au.email_confirmed_at,
        c.balance, c.total_granted, c.total_spent, c.total_refunded, c.updated_at
      from public.profiles p
      join auth.users au on au.id = p.id
      left join public.credit_accounts c on c.user_id = p.id
      where (coalesce(p_search, '') = '' or p.username ilike '%' || p_search || '%' or au.email ilike '%' || p_search || '%')
      order by c.updated_at desc nulls last, p.created_at desc
      limit greatest(1, least(coalesce(p_limit, 50), 100))
    ) u), '[]'::jsonb),
    'usage', coalesce((select jsonb_agg(row_to_json(j) order by j.created_at desc) from (
      select g.id, g.user_id, p.username, au.email, g.billing_mode,
        case when g.billing_mode = 'platform' then '平台图片服务' else '自带 Key 服务' end as provider,
        g.model,
        g.status, g.requested_count, g.generated_count, g.reserved_credits, g.charged_credits,
        g.error_code, g.created_at, g.settled_at
      from public.generation_jobs g
      left join public.profiles p on p.id = g.user_id
      left join auth.users au on au.id = g.user_id
      where g.created_at::date between p_from and p_to
      order by g.created_at desc
      limit 100
    ) j), '[]'::jsonb),
    'orders', coalesce((select jsonb_agg(row_to_json(o) order by o.created_at desc) from (
      select co.id, co.user_id, p.username, au.email, co.channel, co.amount_fen, co.credits,
        co.status, co.out_trade_no, co.created_at, co.paid_at, co.expires_at
      from public.credit_orders co
      left join public.profiles p on p.id = co.user_id
      left join auth.users au on au.id = co.user_id
      where co.created_at::date between p_from and p_to
      order by co.created_at desc
      limit 100
    ) o), '[]'::jsonb)
  );
$$;

revoke all on function public.get_credit_settings() from public, anon, authenticated;
revoke all on function public.update_signup_bonus_credits(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.ensure_signup_bonus(uuid) from public, anon, authenticated;
revoke all on function public.get_admin_console_snapshot(date, date, text, integer) from public, anon, authenticated;
grant execute on function public.get_credit_settings() to service_role;
grant execute on function public.update_signup_bonus_credits(uuid, integer, text) to service_role;
grant execute on function public.ensure_signup_bonus(uuid) to service_role;
grant execute on function public.get_admin_console_snapshot(date, date, text, integer) to service_role;
