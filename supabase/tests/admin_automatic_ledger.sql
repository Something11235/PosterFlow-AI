-- Run after applying 20261022004705. No production rows/functions are changed.
-- The pre-release artifact test injects the same local migration definitions.
begin;
create temp table admin_daily_stats (like public.admin_daily_stats including all);
create temp table admin_bookkeeping (like public.admin_bookkeeping including all);
create temp table profiles(id uuid primary key, created_at timestamptz);
do $$
declare signature text;
begin
  execute format('grant usage on schema %I to service_role',
    (select nspname from pg_namespace where oid = pg_my_temp_schema()));
  foreach signature in array array[
    'public.get_admin_bookkeeping_totals()', 'public.get_admin_bookkeeping(date,date)',
    'public.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint)'
  ] loop
    execute replace(pg_get_functiondef(signature::regprocedure), 'public.', 'pg_temp.');
  end loop;
end;
$$;
grant all on pg_temp.admin_daily_stats, pg_temp.admin_bookkeeping, pg_temp.profiles to service_role;
revoke all on function pg_temp.get_admin_bookkeeping_totals(), pg_temp.get_admin_bookkeeping(date,date),
  pg_temp.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint) from public, anon, authenticated;
grant execute on function pg_temp.get_admin_bookkeeping_totals(), pg_temp.get_admin_bookkeeping(date,date),
  pg_temp.save_admin_bookkeeping(uuid,text,date,text,text,text,bigint) to service_role;
insert into pg_temp.profiles values
  (gen_random_uuid(),'2026-10-10T16:00:00Z'),(gen_random_uuid(),'2026-10-11T15:59:59Z'),(gen_random_uuid(),'2026-10-11T16:00:00Z');
insert into pg_temp.admin_bookkeeping(singleton,recharge_text,cost_text,revision) values (true,'1280','1011.37',8);
insert into pg_temp.admin_daily_stats(stat_date,recharge_text,cost_text,revision) values
  ('2026-10-10','100','80',1),('2026-10-11','0.10','0.20',1),('2026-10-12','0.20','待核对',1),
  ('2026-10-13','','0',1),('2026-10-14','-1.00','0.10',1),('2026-10-15','1,000','12.345',1),
  ('2026-10-16','999999999999.99','',1),((now() at time zone 'Asia/Shanghai')::date+1,'999','999',1);
set local role service_role;
do $$
declare
  v_before jsonb; v_after jsonb; v_data jsonb; v_saved jsonb; v_revision bigint;
  v_admin uuid := gen_random_uuid();
begin
  v_before := pg_temp.get_admin_bookkeeping_totals();
  assert v_before->>'recharge_text' = '1000000000099.29', 'Exact decimal sum failed';
  assert v_before->>'cost_text' = '80.30', 'Missing or freeform cost counted';
  assert (v_before->>'recorded_days')::int = 7, 'Generated empty rows counted as saved';
  assert (v_before->>'recharge_days')::int = 5 and (v_before->>'cost_days')::int = 4, 'Numeric coverage mismatch';
  assert (v_before->>'text_days')::int = 2, 'Freeform coverage mismatch';
  v_data := pg_temp.get_admin_bookkeeping('2026-10-11','2026-10-12');
  assert v_data->'overview' = v_before, 'Filter changed cumulative totals';
  assert jsonb_array_length(v_data->'days') = 2, 'Wrong filtered days';
  assert (v_data->'days'->0->>'new_users')::int = 2, 'Beijing boundary count mismatch';
  assert pg_temp.get_admin_bookkeeping('2026-10-16','2026-10-16')->'overview' = v_before,
    'One-day filter changed cumulative totals';

  v_saved := pg_temp.save_admin_bookkeeping(v_admin,'daily','2026-10-11','0.40','0.20','<b>literal</b>',1);
  assert (v_saved->>'ok')::boolean, 'Daily save failed';
  assert v_saved->'overview'->>'recharge_text' = '1000000000099.59', 'Save did not return fresh totals';
  assert v_saved->'record'->>'note' = '<b>literal</b>', 'Note changed';
  v_after := v_saved->'overview';
  v_saved := pg_temp.save_admin_bookkeeping(v_admin,'daily','2026-10-11','0.40','0.20','<b>literal</b>',2);
  assert v_saved->'overview'->>'recharge_text' = v_after->>'recharge_text', 'Repeated edit double counted';
  v_saved := pg_temp.save_admin_bookkeeping(v_admin,'daily','2026-10-11','999','999','',1);
  assert v_saved->>'code' = 'BOOKKEEPING_CONFLICT', 'Stale revision accepted';
  assert pg_temp.get_admin_bookkeeping_totals() = v_after, 'Conflict changed totals';
  v_data := pg_temp.get_admin_bookkeeping('2026-10-11','2026-10-11');
  assert v_data->'days'->0->>'note' = '<b>literal</b>', 'Refresh changed saved text';
  assert v_data->'overview' = v_after, 'Refresh changed totals';
  -- Legacy overview stays intact and is never added to daily totals.
  assert (select recharge_text from pg_temp.admin_bookkeeping where singleton) = '1280', 'Legacy amount overwritten';
  assert not has_function_privilege('anon','pg_temp.get_admin_bookkeeping_totals()','execute'), 'Anonymous access';
  assert not has_function_privilege('authenticated','pg_temp.get_admin_bookkeeping_totals()','execute'), 'Public access';
end;
$$;
-- Empty tables have missing totals, not fabricated zeros; an explicit zero is valid.
delete from pg_temp.admin_daily_stats;
do $$
begin
  assert pg_temp.get_admin_bookkeeping_totals()->>'recharge_text' is null, 'Empty total invented';
end;
$$;
insert into pg_temp.admin_daily_stats(stat_date,recharge_text,cost_text,revision) values ('2026-10-11','0','0',1);
do $$
begin
  assert pg_temp.get_admin_bookkeeping_totals()->>'recharge_text' = '0.00', 'Explicit zero lost';
end;
$$;
select 'PASS: exact decimals, all-time/filter independence, before-chart records, future exclusion, text/missing/zero coverage, atomic save/re-edit/conflict, Beijing boundary, legacy preservation, private grants' as checks;
reset role;
rollback;
