-- Private bookkeeping: never adjusts credit balances or payment orders.
create table public.admin_bookkeeping (
  singleton boolean primary key default true check (singleton),
  recharge_text text not null default '' check (length(recharge_text) <= 500),
  cost_text text not null default '' check (length(cost_text) <= 500),
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  revision bigint not null default 0,
  updated_by uuid,
  updated_at timestamptz
);
create table public.admin_daily_stats (
  stat_date date primary key,
  new_users bigint not null default 0 check (new_users >= 0),
  recharge_text text not null default '' check (length(recharge_text) <= 500),
  cost_text text not null default '' check (length(cost_text) <= 500),
  note text not null default '' check (length(note) <= 1000),
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  revision bigint not null default 0,
  updated_by uuid,
  updated_at timestamptz,
  counted_at timestamptz not null default now()
);
comment on table public.admin_daily_stats is 'Beijing calendar days; new_users is a refreshed count of existing profiles created that day. Manual text and extra fields are preserved by refresh.';
comment on column public.admin_daily_stats.extra is 'Reserved object for future daily statistic fields without replacing manual records.';
alter table public.admin_bookkeeping enable row level security;
alter table public.admin_daily_stats enable row level security;
revoke all on public.admin_bookkeeping, public.admin_daily_stats from public, anon, authenticated;
grant select, insert, update on public.admin_bookkeeping, public.admin_daily_stats to service_role;
create policy service_bookkeeping on public.admin_bookkeeping for all to service_role using (true) with check (true);
create policy service_daily_stats on public.admin_daily_stats for all to service_role using (true) with check (true);
insert into public.admin_bookkeeping(singleton) values (true);

create function public.get_admin_bookkeeping(p_from date, p_to date)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if p_from is null or p_to is null or p_from > p_to or p_to > v_today or p_to - p_from > 89 then
    raise exception 'Invalid bookkeeping date range' using errcode = '22023';
  end if;
  -- No signup triggers or browser polling. Opening/querying refreshes persisted
  -- daily counts; signup/authentication never depends on bookkeeping writes.
  with days as (
    select p_from + i as day from generate_series(0, p_to - p_from) i
    union select v_today
  ), counts as (
    select (created_at at time zone 'Asia/Shanghai')::date as day, count(*) as total
    from public.profiles
    where (created_at >= (p_from::timestamp at time zone 'Asia/Shanghai')
      and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai'))
      or (created_at >= (v_today::timestamp at time zone 'Asia/Shanghai')
      and created_at < ((v_today + 1)::timestamp at time zone 'Asia/Shanghai'))
    group by 1
  )
  insert into public.admin_daily_stats(stat_date, new_users, counted_at)
    select days.day, coalesce(counts.total, 0), now() from days left join counts using(day) order by days.day
  on conflict (stat_date) do update set new_users = excluded.new_users, counted_at = excluded.counted_at;
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'timezone', 'Asia/Shanghai', 'today_date', v_today,
    'overview', (select to_jsonb(b) - 'singleton' from public.admin_bookkeeping b where singleton),
    'today', (select to_jsonb(d) from public.admin_daily_stats d where stat_date = v_today),
    'days', (select coalesce(jsonb_agg(to_jsonb(d) order by stat_date), '[]'::jsonb)
      from public.admin_daily_stats d where stat_date between p_from and p_to)
  );
end;
$$;

create function public.save_admin_bookkeeping(
  p_admin_user_id uuid, p_scope text, p_date date,
  p_recharge_text text, p_cost_text text, p_note text, p_revision bigint
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_record jsonb;
begin
  if p_admin_user_id is null or p_revision is null or p_revision < 0
    or p_recharge_text is null or length(p_recharge_text) > 500
    or p_cost_text is null or length(p_cost_text) > 500
    or p_note is null or length(p_note) > 1000 then
    raise exception 'Invalid bookkeeping fields' using errcode = '22023';
  end if;
  if p_scope = 'overview' then
    update public.admin_bookkeeping b set recharge_text = p_recharge_text,
      cost_text = p_cost_text, revision = revision + 1, updated_by = p_admin_user_id, updated_at = now()
    where singleton and revision = p_revision returning to_jsonb(b) - 'singleton' into v_record;
  elsif p_scope = 'daily' then
    if p_date is null or p_date > (now() at time zone 'Asia/Shanghai')::date then
      raise exception 'Invalid bookkeeping date' using errcode = '22023';
    end if;
    -- Ensures a saved historical date has a fresh automatic user count too.
    perform public.get_admin_bookkeeping(p_date, p_date);
    update public.admin_daily_stats d set recharge_text = p_recharge_text,
      cost_text = p_cost_text, note = p_note, revision = revision + 1,
      updated_by = p_admin_user_id, updated_at = now()
    where stat_date = p_date and revision = p_revision returning to_jsonb(d) into v_record;
  else
    raise exception 'Invalid bookkeeping scope' using errcode = '22023';
  end if;
  if v_record is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKKEEPING_CONFLICT');
  end if;
  return jsonb_build_object('ok', true, 'record', v_record);
end;
$$;
revoke all on function public.get_admin_bookkeeping(date,date) from public, anon, authenticated;
revoke all on function public.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.get_admin_bookkeeping(date,date) to service_role;
grant execute on function public.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint) to service_role;

-- Extend the existing single console RPC; orders and legacy payment tiles are omitted.
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
    'metrics', public.get_admin_metrics(p_from, p_to) - array['paid_orders','purchase_credits','topup_amount_yuan'],
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
      where g.created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and g.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')
      order by g.created_at desc
      limit 100
    ) j), '[]'::jsonb),
    'bookkeeping', public.get_admin_bookkeeping(p_from, p_to)
  );
$$;
revoke all on function public.get_admin_console_snapshot(date,date,text,integer) from public, anon, authenticated;
grant execute on function public.get_admin_console_snapshot(date,date,text,integer) to service_role;

-- Keep console filters, headline metrics, and daily charts on the same calendar.
create or replace function public.get_admin_metrics(p_from date default current_date - 30, p_to date default current_date)
returns jsonb
language sql
security definer
set search_path = public, auth
as $$
  select jsonb_build_object(
    'registered_users', (select count(*) from public.profiles where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'verified_users', (select count(*) from auth.users where email_confirmed_at is not null and created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'daily_active_users', (select count(distinct user_id) from public.generation_jobs where created_at >= (date_trunc('day', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')),
    'monthly_active_users', (select count(distinct user_id) from public.generation_jobs where created_at >= (date_trunc('month', now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai')),
    'generated_images', (select coalesce(sum(generated_count), 0) from public.generation_jobs where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'success_rate', (select coalesce(round(100.0 * count(*) filter (where status = 'succeeded') / nullif(count(*), 0), 1), 0) from public.generation_jobs where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'average_duration_ms', (select coalesce(round(avg(duration_ms)), 0) from public.generation_jobs where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai') and duration_ms is not null),
    'credits_granted', (select coalesce(sum(delta) filter (where type in ('signup_bonus', 'admin_adjustment', 'purchase') and delta > 0), 0) from public.credit_transactions where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'credits_consumed', (select coalesce(sum(charged_credits), 0) from public.generation_jobs where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'credits_refunded', (select coalesce(sum(delta) filter (where type = 'refund'), 0) from public.credit_transactions where created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'paid_orders', (select count(*) from public.credit_orders where status = 'paid' and paid_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and paid_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'topup_amount_yuan', (select coalesce(sum(amount_fen) filter (where status = 'paid'), 0) / 100.0 from public.credit_orders where paid_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and paid_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'purchase_credits', (select coalesce(sum(credits) filter (where status = 'paid'), 0) from public.credit_orders where paid_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and paid_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'platform_jobs', (select count(*) from public.generation_jobs where billing_mode = 'platform' and created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai')),
    'own_key_jobs', (select count(*) from public.generation_jobs where billing_mode = 'own_key' and created_at >= (p_from::timestamp at time zone 'Asia/Shanghai') and created_at < ((p_to + 1)::timestamp at time zone 'Asia/Shanghai'))
  );
$$;
revoke all on function public.get_admin_metrics(date,date) from public,anon,authenticated;
grant execute on function public.get_admin_metrics(date,date) to service_role;
