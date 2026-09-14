-- PosterFlow AI: administrator console, credit top-up orders, and payment settlement.
-- This migration only records orders and verifies server callbacks. Configure a
-- compliant WeChat/Alipay merchant gateway before enabling online checkout.

alter table public.credit_transactions
  drop constraint if exists credit_transactions_type_check;
alter table public.credit_transactions
  add constraint credit_transactions_type_check
  check (type in ('signup_bonus', 'reserve', 'spend', 'refund', 'admin_adjustment', 'purchase'));

create table if not exists public.credit_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null check (channel in ('wechat', 'alipay')),
  amount_fen integer not null check (amount_fen >= 1000 and amount_fen <= 1000000 and amount_fen % 100 = 0),
  credits integer not null check (credits >= 100 and credits = amount_fen / 10),
  out_trade_no text not null unique,
  provider_trade_no text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'closed', 'failed')),
  code_url text,
  payment_url text,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists credit_orders_user_created_idx
  on public.credit_orders (user_id, created_at desc);
create index if not exists credit_orders_status_created_idx
  on public.credit_orders (status, created_at desc);
create unique index if not exists credit_orders_provider_trade_no_unique
  on public.credit_orders (provider_trade_no)
  where provider_trade_no is not null and provider_trade_no <> '';

alter table public.credit_orders enable row level security;
drop policy if exists "credit_orders_select_own" on public.credit_orders;
create policy "credit_orders_select_own" on public.credit_orders for select using (auth.uid() = user_id);

create or replace function public.admin_adjust_credits(
  p_admin_user_id uuid,
  p_user_id uuid,
  p_delta integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_balance integer;
  v_existing jsonb;
  v_reason text := left(trim(coalesce(p_reason, '')), 240);
begin
  if not exists (select 1 from public.profiles where id = p_admin_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  if p_delta = 0 or p_delta is null then
    return jsonb_build_object('ok', false, 'code', 'CREDIT_DELTA_INVALID');
  end if;
  if p_idempotency_key is null or length(trim(p_idempotency_key)) < 8 then
    return jsonb_build_object('ok', false, 'code', 'IDEMPOTENCY_KEY_INVALID');
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND');
  end if;

  select to_jsonb(t) into v_existing
  from public.credit_transactions t
  where t.user_id = p_user_id and t.idempotency_key = p_idempotency_key;
  if v_existing is not null then
    select balance into v_balance from public.credit_accounts where user_id = p_user_id;
    return jsonb_build_object('ok', true, 'idempotent', true, 'balance', v_balance, 'transaction', v_existing);
  end if;

  update public.credit_accounts
  set balance = balance + p_delta,
      total_granted = total_granted + greatest(p_delta, 0),
      updated_at = now()
  where user_id = p_user_id and balance + p_delta >= 0
  returning balance into v_balance;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CREDITS_BALANCE_INVALID');
  end if;

  insert into public.credit_transactions (user_id, type, delta, idempotency_key, metadata)
  values (
    p_user_id, 'admin_adjustment', p_delta, p_idempotency_key,
    jsonb_build_object('reason', coalesce(nullif(v_reason, ''), '管理员调整'), 'admin_user_id', p_admin_user_id)
  );
  return jsonb_build_object('ok', true, 'idempotent', false, 'balance', v_balance);
end;
$$;

create or replace function public.complete_credit_order(
  p_out_trade_no text,
  p_provider_trade_no text,
  p_paid_amount_fen integer,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_order public.credit_orders%rowtype;
  v_balance integer;
  v_tx_key text;
begin
  if p_out_trade_no is null or trim(p_out_trade_no) = ''
     or p_provider_trade_no is null or trim(p_provider_trade_no) = ''
     or p_paid_amount_fen is null or p_paid_amount_fen <= 0 then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_CALLBACK_INVALID');
  end if;
  if exists (
    select 1 from public.credit_orders
    where provider_trade_no = p_provider_trade_no and out_trade_no <> p_out_trade_no
  ) then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_TRADE_CONFLICT');
  end if;
  select * into v_order from public.credit_orders where out_trade_no = p_out_trade_no for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND'); end if;
  if v_order.status = 'paid' then
    if v_order.provider_trade_no is distinct from p_provider_trade_no then
      return jsonb_build_object('ok', false, 'code', 'PAYMENT_TRADE_CONFLICT');
    end if;
    select balance into v_balance from public.credit_accounts where user_id = v_order.user_id;
    return jsonb_build_object('ok', true, 'idempotent', true, 'order_id', v_order.id, 'balance', v_balance, 'credits', v_order.credits);
  end if;
  if v_order.status <> 'pending' then return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_PAYABLE'); end if;
  if v_order.expires_at < now() then
    update public.credit_orders set status = 'closed' where id = v_order.id;
    return jsonb_build_object('ok', false, 'code', 'ORDER_EXPIRED');
  end if;
  if p_paid_amount_fen <> v_order.amount_fen then return jsonb_build_object('ok', false, 'code', 'PAYMENT_AMOUNT_MISMATCH'); end if;

  update public.credit_accounts
  set balance = balance + v_order.credits,
      total_granted = total_granted + v_order.credits,
      updated_at = now()
  where user_id = v_order.user_id
  returning balance into v_balance;
  if not found then return jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND'); end if;

  v_tx_key := 'purchase:' || v_order.out_trade_no;
  insert into public.credit_transactions (user_id, type, delta, idempotency_key, metadata)
  values (v_order.user_id, 'purchase', v_order.credits, v_tx_key,
    jsonb_build_object('order_id', v_order.id, 'channel', v_order.channel, 'amount_fen', v_order.amount_fen, 'provider_trade_no', p_provider_trade_no) || coalesce(p_metadata, '{}'::jsonb));
  update public.credit_orders
  set status = 'paid', provider_trade_no = p_provider_trade_no, metadata = metadata || coalesce(p_metadata, '{}'::jsonb), paid_at = now()
  where id = v_order.id;
  return jsonb_build_object('ok', true, 'idempotent', false, 'order_id', v_order.id, 'balance', v_balance, 'credits', v_order.credits);
end;
$$;

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

-- Keep the original aggregate RPC useful after paid top-ups are introduced.
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
    'credits_granted', (select coalesce(sum(delta) filter (where type in ('signup_bonus', 'admin_adjustment', 'purchase') and delta > 0), 0) from public.credit_transactions where created_at::date between p_from and p_to),
    'credits_consumed', (select coalesce(sum(charged_credits), 0) from public.generation_jobs where created_at::date between p_from and p_to),
    'credits_refunded', (select coalesce(sum(delta) filter (where type = 'refund'), 0) from public.credit_transactions where created_at::date between p_from and p_to),
    'paid_orders', (select count(*) from public.credit_orders where status = 'paid' and paid_at::date between p_from and p_to),
    'topup_amount_yuan', (select coalesce(sum(amount_fen) filter (where status = 'paid'), 0) / 100.0 from public.credit_orders where paid_at::date between p_from and p_to),
    'purchase_credits', (select coalesce(sum(credits) filter (where status = 'paid'), 0) from public.credit_orders where paid_at::date between p_from and p_to),
    'platform_jobs', (select count(*) from public.generation_jobs where billing_mode = 'platform' and created_at::date between p_from and p_to),
    'own_key_jobs', (select count(*) from public.generation_jobs where billing_mode = 'own_key' and created_at::date between p_from and p_to)
  );
$$;

alter table public.credit_orders force row level security;
revoke all on table public.credit_orders from public, anon, authenticated;
grant select, insert, update on table public.credit_orders to service_role;
revoke all on function public.admin_adjust_credits(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.complete_credit_order(text, text, integer, jsonb) from public, anon, authenticated;
revoke all on function public.get_admin_console_snapshot(date, date, text, integer) from public, anon, authenticated;
revoke all on function public.get_admin_metrics(date, date) from public, anon, authenticated;
grant execute on function public.admin_adjust_credits(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.complete_credit_order(text, text, integer, jsonb) to service_role;
grant execute on function public.get_admin_console_snapshot(date, date, text, integer) to service_role;
grant execute on function public.get_admin_metrics(date, date) to service_role;
