-- Transactional verification: all synthetic edits are rolled back.
begin;
do $$
begin
  if has_table_privilege('anon', 'public.admin_daily_stats', 'select')
    or has_table_privilege('authenticated', 'public.admin_bookkeeping', 'update')
    or has_function_privilege('authenticated', 'public.get_admin_bookkeeping(date,date)', 'execute')
    or has_function_privilege('anon', 'public.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint)', 'execute') then
    raise exception 'Bookkeeping privileges are too broad';
  end if;
end;
$$;
set local role service_role;
do $$
declare
  v_today date := (now() at time zone 'Asia/Shanghai')::date;
  v_admin uuid := gen_random_uuid();
  v_data jsonb; v_saved jsonb; v_again jsonb; v_snapshot jsonb; v_revision bigint;
  v_count bigint;
begin
  v_data := public.get_admin_bookkeeping(v_today - 29, v_today);
  if jsonb_array_length(v_data->'days') <> 30 then raise exception 'Missing day rows'; end if;
  select count(*) into v_count from public.profiles
    where created_at >= (v_today::timestamp at time zone 'Asia/Shanghai')
      and created_at < ((v_today+1)::timestamp at time zone 'Asia/Shanghai');
  if (v_data->'today'->>'new_users')::bigint <> v_count then raise exception 'Beijing day count mismatch'; end if;
  v_revision := (v_data->'today'->>'revision')::bigint;
  v_saved := public.save_admin_bookkeeping(v_admin,'daily',v_today,'128.50','接口费用待核对','<b>literal note</b>',v_revision);
  if not (v_saved->>'ok')::boolean or v_saved->'record'->>'recharge_text' <> '128.50' then raise exception 'Text save failed'; end if;
  v_again := public.save_admin_bookkeeping(v_admin,'daily',v_today,'overwritten','0','',v_revision);
  if v_again->>'code' <> 'BOOKKEEPING_CONFLICT' then raise exception 'Stale write not rejected'; end if;
  v_data := public.get_admin_bookkeeping(v_today,v_today);
  if v_data->'today'->>'cost_text' <> '接口费用待核对' or v_data->'today'->>'note' <> '<b>literal note</b>'
    or (v_data->'today'->>'revision')::bigint <> v_revision + 1 then raise exception 'Refresh overwrote manual fields'; end if;
  if v_data->'overview'->>'source' <> 'daily' or v_data->'overview' <> public.get_admin_bookkeeping_totals()
    then raise exception 'Overview is not the all-time daily aggregate'; end if;
  begin
    perform public.get_admin_bookkeeping(v_today-90,v_today);
    raise exception 'Unbounded range accepted';
  exception when sqlstate '22023' then null; end;
  begin
    perform public.save_admin_bookkeeping(v_admin,'daily',v_today+1,'','','',0);
    raise exception 'Future date accepted';
  exception when sqlstate '22023' then null; end;
  v_snapshot := public.get_admin_console_snapshot(v_today-29,v_today,'',1);
  if v_snapshot->'metrics' ?| array['paid_orders','purchase_credits','topup_amount_yuan']
    or v_snapshot ? 'orders' then raise exception 'Legacy payment tiles remain'; end if;
  if (v_snapshot->'metrics'->>'registered_users')::bigint <>
    (select sum((d->>'new_users')::bigint) from jsonb_array_elements(v_snapshot->'bookkeeping'->'days') d)
    then raise exception 'Headline and daily counts disagree'; end if;
end;
$$;
reset role;
select 'PASS: private grants, 30-day coverage, Beijing counts, freeform save, conflict, refresh preservation, invalid dates, snapshot parity' as checks;
rollback;
