-- Compute from the canonical daily rows; never increment a stored total.
-- The legacy singleton and its manually recorded amounts remain untouched.
create function public.get_admin_bookkeeping_totals()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with amounts as (
    select stat_date, revision, updated_at,
      nullif(btrim(recharge_text), '') as recharge,
      nullif(btrim(cost_text), '') as cost,
      case when btrim(recharge_text) ~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$'
        then btrim(recharge_text)::numeric(16,2) end as recharge_amount,
      case when btrim(cost_text) ~ '^-?[0-9]{1,12}(\.[0-9]{1,2})?$'
        then btrim(cost_text)::numeric(16,2) end as cost_amount
    from public.admin_daily_stats
    where stat_date <= (now() at time zone 'Asia/Shanghai')::date
  )
  select jsonb_build_object(
    'source', 'daily',
    'recharge_text', sum(recharge_amount)::text,
    'cost_text', sum(cost_amount)::text,
    'recharge_days', count(recharge_amount), 'cost_days', count(cost_amount),
    'recorded_days', count(*) filter (where revision > 0 or recharge is not null or cost is not null),
    'text_days', count(*) filter (where (recharge is not null and recharge_amount is null)
      or (cost is not null and cost_amount is null)),
    'updated_at', max(updated_at)
  ) from amounts;
$$;
revoke all on function public.get_admin_bookkeeping_totals() from public, anon, authenticated;
grant execute on function public.get_admin_bookkeeping_totals() to service_role;

create or replace function public.get_admin_bookkeeping(p_from date, p_to date)
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
    'overview', public.get_admin_bookkeeping_totals(),
    'today', (select to_jsonb(d) from public.admin_daily_stats d where stat_date = v_today),
    'days', (select coalesce(jsonb_agg(to_jsonb(d) order by stat_date), '[]'::jsonb)
      from public.admin_daily_stats d where stat_date between p_from and p_to)
  );
end;
$$;

create or replace function public.save_admin_bookkeeping(
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
  return jsonb_build_object('ok', true, 'record', v_record, 'overview', public.get_admin_bookkeeping_totals());
end;
$$;
revoke all on function public.get_admin_bookkeeping(date,date) from public, anon, authenticated;
revoke all on function public.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint) from public, anon, authenticated;
grant execute on function public.get_admin_bookkeeping(date,date) to service_role;
grant execute on function public.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint) to service_role;

