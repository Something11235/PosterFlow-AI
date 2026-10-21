-- Runs the installed cleanup implementation on an isolated temporary task table.
begin;
create temporary table history_fixture(id uuid primary key, prompt text, created_at timestamptz, charged_credits integer, image_keys jsonb);
insert into history_fixture values
  (gen_random_uuid(),'expired',statement_timestamp()-interval '8 days',5,'["keep.png"]'),
  (gen_random_uuid(),'boundary',statement_timestamp()-interval '7 days',4,'["keep2.png"]'),
  (gen_random_uuid(),'recent',statement_timestamp()-interval '6 days',3,'[]');
do $$
declare v_definition text; v_result jsonb;
begin
  if has_function_privilege('anon','private.prune_prompt_text(boolean)','execute')
    or has_function_privilege('authenticated','private.prune_prompt_text(boolean)','execute')
    or has_function_privilege('service_role','private.prune_prompt_text(boolean)','execute') then
    raise exception 'Cleanup must be admin/Cron only';
  end if;
  select pg_get_functiondef('private.prune_prompt_text(boolean)'::regprocedure) into v_definition;
  v_definition := replace(replace(v_definition,'private.prune_prompt_text','pg_temp.test_prune_prompt_text'),'public.generation_jobs','pg_temp.history_fixture');
  execute v_definition;
  v_result := pg_temp.test_prune_prompt_text(true);
  if (v_result->>'eligible')::integer <> 2 or (select count(*) from history_fixture where prompt='') <> 0 then raise exception 'Dry run changed text or cutoff is wrong'; end if;
  v_result := pg_temp.test_prune_prompt_text(false);
  if (v_result->>'cleared')::integer <> 2 then raise exception 'Expired rows not cleared'; end if;
  if (select count(*) from history_fixture) <> 3 or (select sum(charged_credits) from history_fixture) <> 12
    or not exists(select 1 from history_fixture where image_keys='["keep.png"]' and prompt='')
    or not exists(select 1 from history_fixture where prompt='recent') then raise exception 'Unexpected task/image/credit modification'; end if;
  if (pg_temp.test_prune_prompt_text(false)->>'cleared')::integer <> 0 then raise exception 'Cleanup not idempotent'; end if;
end;
$$;
select 'PASS: seven-day boundary, dry run, prompt-only cleanup, recent prompt retained, job/image/credit preservation, idempotency, private grants' as checks;
rollback;
