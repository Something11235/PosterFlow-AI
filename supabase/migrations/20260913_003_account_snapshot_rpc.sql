-- Fetch the complete account header in one database round trip.
-- This avoids the slow Auth Admin lookup plus several sequential PostgREST reads
-- that otherwise make a freshly signed-in user temporarily appear unverified.

create or replace function public.get_account_snapshot(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email text;
  v_confirmed_at timestamptz;
  v_signup_bonus jsonb;
  v_profile jsonb;
  v_credits jsonb;
  v_transactions jsonb;
begin
  select email, email_confirmed_at
  into v_email, v_confirmed_at
  from auth.users
  where id = p_user_id;

  if not found then
    return jsonb_build_object(
      'signup_bonus', jsonb_build_object('ok', false, 'code', 'AUTH_USER_NOT_FOUND'),
      'profile', null,
      'email', null,
      'email_verified', false,
      'email_confirmed_at', null,
      'credits', jsonb_build_object(
        'balance', 0,
        'total_granted', 0,
        'total_spent', 0,
        'total_refunded', 0
      ),
      'transactions', '[]'::jsonb
    );
  end if;

  -- ensure_signup_bonus uses unique constraints so concurrent logins award once.
  v_signup_bonus := public.ensure_signup_bonus(p_user_id);

  select to_jsonb(p)
  into v_profile
  from (
    select id, username, role, status, created_at, last_login_at
    from public.profiles
    where id = p_user_id
  ) p;

  select to_jsonb(c)
  into v_credits
  from (
    select balance, total_granted, total_spent, total_refunded, updated_at
    from public.credit_accounts
    where user_id = p_user_id
  ) c;

  select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
  into v_transactions
  from (
    select id, type, delta, metadata, created_at
    from public.credit_transactions
    where user_id = p_user_id
    order by created_at desc
    limit 30
  ) t;

  return jsonb_build_object(
    'profile', v_profile,
    'email', v_email,
    'email_verified', v_confirmed_at is not null,
    'email_confirmed_at', v_confirmed_at,
    'signup_bonus', v_signup_bonus,
    'credits', coalesce(v_credits, jsonb_build_object(
      'balance', 0,
      'total_granted', 0,
      'total_spent', 0,
      'total_refunded', 0
    )),
    'transactions', v_transactions
  );
end;
$$;

revoke all on function public.get_account_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.get_account_snapshot(uuid) to service_role;