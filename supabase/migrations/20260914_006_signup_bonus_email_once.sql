-- Prevent signup bonus reuse across deleted/recreated accounts.
create table if not exists public.signup_bonus_claims (
  email_hash text primary key,
  claimed_at timestamptz not null default now(),
  user_id uuid,
  metadata jsonb not null default '{}'::jsonb
);
revoke all on table public.signup_bonus_claims from public, anon, authenticated;
grant select, insert, update on table public.signup_bonus_claims to service_role;
insert into public.signup_bonus_claims (email_hash, user_id, metadata)
select encode(extensions.digest(lower(trim(u.email)), 'sha256'), 'hex'), t.user_id, jsonb_build_object('source', 'legacy_backfill')
from public.credit_transactions t join auth.users u on u.id=t.user_id
where t.type='signup_bonus' and u.email is not null on conflict (email_hash) do nothing;
create or replace function public.ensure_signup_bonus(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public, auth, extensions as $$
declare v_email text; v_hash text; v_balance integer;
begin
 select email into v_email from auth.users where id=p_user_id and email_confirmed_at is not null;
 if not found then return jsonb_build_object('ok',false,'code','EMAIL_UNVERIFIED'); end if;
 v_hash:=encode(extensions.digest(lower(trim(v_email)),'sha256'),'hex');
 insert into public.credit_accounts(user_id) values(p_user_id) on conflict(user_id) do nothing;
 insert into public.signup_bonus_claims(email_hash,user_id) values(v_hash,p_user_id) on conflict do nothing;
 if found then
  insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata) values(p_user_id,'signup_bonus',10,'signup-bonus-v1',jsonb_build_object('source','email_verification'));
  update public.credit_accounts set balance=balance+10,total_granted=total_granted+10,updated_at=now() where user_id=p_user_id;
 end if;
 select balance into v_balance from public.credit_accounts where user_id=p_user_id;
 return jsonb_build_object('ok',true,'balance',coalesce(v_balance,0));
end; $$;
revoke all on function public.ensure_signup_bonus(uuid) from public, anon, authenticated;
grant execute on function public.ensure_signup_bonus(uuid) to service_role;