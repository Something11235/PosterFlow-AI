-- Administrator invitation reporting. Preserve every attributable redemption,
-- including no-award redemptions whose users may later delete their accounts.
-- No balance/ledger updates and no replacement of existing financial routines.
set local lock_timeout = '5s';
-- Prevent a redemption from falling between the historical snapshot and the
-- audit trigger installation. Existing transactions finish before backfill.
lock table public.credit_codes in share row exclusive mode;

create table private.referral_redemptions (
  code_id uuid primary key references public.credit_codes(id),
  inviter_user_id uuid not null,
  invitee_user_id uuid not null,
  redeemed_credits numeric(18,4) not null check (redeemed_credits > 0 and redeemed_credits <> 'NaN'::numeric),
  redeemed_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  check (inviter_user_id <> invitee_user_id)
);
-- UUIDs are historical attribution, intentionally not cascading profile FKs.
create index referral_redemptions_invitee_idx on private.referral_redemptions(invitee_user_id, inviter_user_id);
create index referral_redemptions_created_idx on private.referral_redemptions(redeemed_at desc, code_id desc);
create index referral_bindings_created_idx on private.referral_bindings(created_at desc, invitee_user_id desc);
alter table private.referral_redemptions enable row level security;
revoke all on private.referral_redemptions from public, anon, authenticated, service_role;

-- Award facts are authoritative even if redeemed_by has been cleared by user
-- deletion. Only still-attributable no-award vouchers can be backfilled.
insert into private.referral_redemptions(code_id, inviter_user_id, invitee_user_id, redeemed_credits, redeemed_at)
select code_id, inviter_user_id, invitee_user_id, redeemed_credits, created_at
from private.referral_rewards on conflict(code_id) do nothing;
insert into private.referral_redemptions(code_id, inviter_user_id, invitee_user_id, redeemed_credits, redeemed_at)
select c.id, f.inviter_user_id, f.invitee_user_id, b.credits, c.redeemed_at
from public.credit_codes c
join public.credit_code_batches b on b.id = c.batch_id
join private.referral_bindings f on f.invitee_user_id = c.redeemed_by
where c.status = 'redeemed' and c.redeemed_at >= f.created_at
on conflict(code_id) do nothing;

create function private.capture_referral_redemption() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.referral_redemptions(code_id, inviter_user_id, invitee_user_id, redeemed_credits, redeemed_at)
  select new.id, f.inviter_user_id, f.invitee_user_id, b.credits, new.redeemed_at
  from private.referral_bindings f join public.credit_code_batches b on b.id = new.batch_id
  where f.invitee_user_id = new.redeemed_by and new.redeemed_at >= f.created_at
  on conflict(code_id) do nothing;
  return new;
end;
$$;
revoke all on function private.capture_referral_redemption() from public, anon, authenticated, service_role;
create trigger capture_referral_redemption after update of status on public.credit_codes
  for each row when (old.status is distinct from 'redeemed' and new.status = 'redeemed' and new.redeemed_by is not null)
  execute function private.capture_referral_redemption();

create function private.prevent_referral_redemption_rewrite() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'REFERRAL_REDEMPTION_IMMUTABLE' using errcode = '23514';
end;
$$;
revoke all on function private.prevent_referral_redemption_rewrite() from public, anon, authenticated, service_role;
create trigger referral_redemption_immutable before update or delete on private.referral_redemptions
  for each row execute function private.prevent_referral_redemption_rewrite();

create view private.admin_referral_redemptions with (security_invoker = true) as
select d.code_id, d.inviter_user_id, d.invitee_user_id, d.redeemed_at, d.redeemed_credits,
  coalesce(r.reward_credits, 0::numeric) as reward_credits,
  case when r.code_id is not null then 'rewarded' else 'not_issued' end as status
from private.referral_redemptions d left join private.referral_rewards r on r.code_id = d.code_id;
revoke all on private.admin_referral_redemptions from public, anon, authenticated, service_role;

create function private.admin_referral_overview(
  p_admin uuid, p_view text default 'relations', p_search text default '', p_limit integer default 20, p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_search text;
  v_totals jsonb;
  v_records jsonb;
  v_total_count bigint;
begin
  if not exists(
    select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = p_admin and p.role = 'admin' and p.status = 'active'
      and p.deleted_at is null and u.email_confirmed_at is not null
  ) then return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED'); end if;
  if p_view is null or p_view not in ('relations','rewards') or p_search is null or length(p_search) > 120
    or p_limit is null or p_limit < 1 or p_limit > 50
    or p_offset is null or p_offset < 0 or p_offset > 1000000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REFERRAL_INPUT');
  end if;
  v_search := lower(btrim(p_search));
  -- Lifetime totals are intentionally independent of the current search/page.
  select jsonb_build_object(
    'inviter_count', (select count(distinct inviter_user_id) from private.referral_bindings),
    'invitee_count', (select count(*) from private.referral_bindings),
    'redemption_count', count(*), 'redeemed_credits', coalesce(sum(redeemed_credits), 0),
    'reward_credits', coalesce(sum(reward_credits), 0)
  ) into v_totals from private.admin_referral_redemptions;

  if p_view = 'relations' then
    with amounts as (
      select invitee_user_id, inviter_user_id, count(*) as redemption_count,
        sum(redeemed_credits) as redeemed_credits, sum(reward_credits) as reward_credits
      from private.admin_referral_redemptions group by invitee_user_id, inviter_user_id
    ), named as (
      select f.invitee_user_id as invitee_id,
        case when e.deleted_at is null then coalesce(e.username, '已注销用户') else '已注销用户' end as invitee_name,
        case when e.id is not null and e.deleted_at is null then eu.email end as invitee_email,
        f.inviter_user_id as inviter_id,
        case when i.deleted_at is null then coalesce(i.username, '已注销用户') else '已注销用户' end as inviter_name,
        case when i.id is not null and i.deleted_at is null then iu.email end as inviter_email,
        f.created_at as bound_at, coalesce(a.redemption_count, 0) as redemption_count,
        coalesce(a.redeemed_credits, 0) as redeemed_credits, coalesce(a.reward_credits, 0) as reward_credits
      from private.referral_bindings f
      left join public.profiles e on e.id = f.invitee_user_id left join auth.users eu on eu.id = e.id
      left join public.profiles i on i.id = f.inviter_user_id left join auth.users iu on iu.id = i.id
      left join amounts a on a.invitee_user_id = f.invitee_user_id and a.inviter_user_id = f.inviter_user_id
    ), filtered as (
      select * from named where v_search = ''
        or strpos(lower(invitee_name),v_search) > 0 or strpos(lower(coalesce(invitee_email,'')),v_search) > 0
        or strpos(invitee_id::text,v_search) > 0 or strpos(lower(inviter_name),v_search) > 0
        or strpos(lower(coalesce(inviter_email,'')),v_search) > 0 or strpos(inviter_id::text,v_search) > 0
    )
    select (select count(*) from filtered), coalesce((
      select jsonb_agg(to_jsonb(r) order by r.bound_at desc, r.invitee_id desc)
      from (select * from filtered order by bound_at desc, invitee_id desc limit p_limit offset p_offset) r
    ), '[]'::jsonb) into v_total_count, v_records;
  else
    with named as (
      select d.code_id as id, d.invitee_user_id as invitee_id,
        case when e.deleted_at is null then coalesce(e.username, '已注销用户') else '已注销用户' end as invitee_name,
        case when e.id is not null and e.deleted_at is null then eu.email end as invitee_email,
        d.inviter_user_id as inviter_id,
        case when i.deleted_at is null then coalesce(i.username, '已注销用户') else '已注销用户' end as inviter_name,
        case when i.id is not null and i.deleted_at is null then iu.email end as inviter_email,
        d.redeemed_at, d.redeemed_credits, d.reward_credits, d.status
      from private.admin_referral_redemptions d
      left join public.profiles e on e.id = d.invitee_user_id left join auth.users eu on eu.id = e.id
      left join public.profiles i on i.id = d.inviter_user_id left join auth.users iu on iu.id = i.id
    ), filtered as (
      select * from named where v_search = ''
        or strpos(lower(invitee_name),v_search) > 0 or strpos(lower(coalesce(invitee_email,'')),v_search) > 0
        or strpos(invitee_id::text,v_search) > 0 or strpos(lower(inviter_name),v_search) > 0
        or strpos(lower(coalesce(inviter_email,'')),v_search) > 0 or strpos(inviter_id::text,v_search) > 0
    )
    select (select count(*) from filtered), coalesce((
      select jsonb_agg(to_jsonb(r) order by r.redeemed_at desc, r.id desc)
      from (select * from filtered order by redeemed_at desc, id desc limit p_limit offset p_offset) r
    ), '[]'::jsonb) into v_total_count, v_records;
  end if;
  return jsonb_build_object('ok', true, 'totals', v_totals, 'records', v_records,
    'total_count', v_total_count, 'has_more', v_total_count > p_offset::bigint + p_limit);
end;
$$;
create function public.admin_referral_overview(
  p_admin uuid, p_view text default 'relations', p_search text default '', p_limit integer default 20, p_offset integer default 0
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.admin_referral_overview(p_admin, p_view, p_search, p_limit, p_offset);
$$;
revoke all on function private.admin_referral_overview(uuid,text,text,integer,integer),
  public.admin_referral_overview(uuid,text,text,integer,integer) from public, anon, authenticated;
grant execute on function private.admin_referral_overview(uuid,text,text,integer,integer),
  public.admin_referral_overview(uuid,text,text,integer,integer) to service_role;
