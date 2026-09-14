-- PosterFlow AI: harden payment settlement and administrator adjustments.
-- This is intentionally a follow-up migration so projects that already ran
-- 20260913_004_admin_console_payments.sql can apply the fixes safely.

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

  -- Lock the account before checking the key. Concurrent retries for the same
  -- user therefore observe the first transaction and cannot double-apply it.
  select balance into v_balance
  from public.credit_accounts
  where user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND');
  end if;

  select to_jsonb(t) into v_existing
  from public.credit_transactions t
  where t.user_id = p_user_id and t.idempotency_key = p_idempotency_key;
  if v_existing is not null then
    return jsonb_build_object('ok', true, 'idempotent', true, 'balance', v_balance, 'transaction', v_existing);
  end if;
  if v_balance + p_delta < 0 then
    return jsonb_build_object('ok', false, 'code', 'CREDITS_BALANCE_INVALID');
  end if;

  update public.credit_accounts
  set balance = v_balance + p_delta,
      total_granted = total_granted + greatest(p_delta, 0),
      updated_at = now()
  where user_id = p_user_id;

  insert into public.credit_transactions (user_id, type, delta, idempotency_key, metadata)
  values (
    p_user_id, 'admin_adjustment', p_delta, p_idempotency_key,
    jsonb_build_object('reason', coalesce(nullif(v_reason, ''), '管理员调整'), 'admin_user_id', p_admin_user_id)
  );
  return jsonb_build_object('ok', true, 'idempotent', false, 'balance', v_balance + p_delta);
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
  v_inserted integer;
begin
  if p_out_trade_no is null or trim(p_out_trade_no) = ''
     or p_provider_trade_no is null or trim(p_provider_trade_no) = ''
     or p_paid_amount_fen is null or p_paid_amount_fen <= 0 then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_CALLBACK_INVALID');
  end if;

  -- Serialize callbacks carrying the same gateway transaction number before
  -- checking the cross-order uniqueness condition.
  perform pg_advisory_xact_lock(hashtext(trim(p_provider_trade_no)));
  if exists (
    select 1 from public.credit_orders
    where provider_trade_no = p_provider_trade_no and out_trade_no <> p_out_trade_no
  ) then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_TRADE_CONFLICT');
  end if;

  select * into v_order
  from public.credit_orders
  where out_trade_no = p_out_trade_no
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_FOUND');
  end if;
  if coalesce(p_metadata ->> 'channel', '') <> v_order.channel then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_CHANNEL_MISMATCH');
  end if;
  if v_order.status = 'paid' then
    if v_order.provider_trade_no is distinct from p_provider_trade_no then
      return jsonb_build_object('ok', false, 'code', 'PAYMENT_TRADE_CONFLICT');
    end if;
    select balance into v_balance from public.credit_accounts where user_id = v_order.user_id;
    return jsonb_build_object('ok', true, 'idempotent', true, 'order_id', v_order.id, 'balance', v_balance, 'credits', v_order.credits);
  end if;
  if v_order.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'ORDER_NOT_PAYABLE');
  end if;
  -- A verified gateway success notification may arrive after the browser-side
  -- QR validity window. Do not discard a captured payment because of callback
  -- latency; the official signature, exact amount, and order binding are the
  -- authoritative checks.
  if p_paid_amount_fen <> v_order.amount_fen then
    return jsonb_build_object('ok', false, 'code', 'PAYMENT_AMOUNT_MISMATCH');
  end if;

  -- Validate and lock the account before inserting the purchase ledger row.
  -- This keeps a missing account from producing a committed ledger entry that
  -- has no matching balance update.
  select balance into v_balance
  from public.credit_accounts
  where user_id = v_order.user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'USER_NOT_FOUND');
  end if;

  v_tx_key := 'purchase:' || v_order.out_trade_no;
  insert into public.credit_transactions (user_id, type, delta, idempotency_key, metadata)
  values (
    v_order.user_id, 'purchase', v_order.credits, v_tx_key,
    jsonb_build_object('order_id', v_order.id, 'channel', v_order.channel, 'amount_fen', v_order.amount_fen, 'provider_trade_no', p_provider_trade_no)
      || coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (user_id, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    update public.credit_accounts
    set balance = v_balance + v_order.credits,
        total_granted = total_granted + v_order.credits,
        updated_at = now()
    where user_id = v_order.user_id
    returning balance into v_balance;
  end if;
  update public.credit_orders
  set status = 'paid',
      provider_trade_no = p_provider_trade_no,
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb),
      paid_at = now()
  where id = v_order.id;
  return jsonb_build_object('ok', true, 'idempotent', v_inserted = 0, 'order_id', v_order.id, 'balance', v_balance, 'credits', v_order.credits);
end;
$$;

revoke all on function public.admin_adjust_credits(uuid, uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.complete_credit_order(text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.admin_adjust_credits(uuid, uuid, integer, text, text) to service_role;
grant execute on function public.complete_credit_order(text, text, integer, jsonb) to service_role;
