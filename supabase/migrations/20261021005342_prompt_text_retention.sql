-- Only the prompt text expires. Job rows, balances and image storage are untouched.
create index generation_jobs_prompt_expiry_idx on public.generation_jobs(created_at, id) where prompt <> '';

create function private.prune_prompt_text(p_dry_run boolean default true)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_cutoff timestamptz := statement_timestamp() - interval '7 days';
  v_count integer;
begin
  if p_dry_run is null then raise exception 'Explicit cleanup mode required'; end if;
  if p_dry_run then
    select count(*) into v_count from public.generation_jobs where created_at <= v_cutoff and prompt <> '';
    return jsonb_build_object('dry_run',true,'eligible',v_count,'cutoff',v_cutoff);
  end if;
  with expired as (
    select id from public.generation_jobs where created_at <= v_cutoff and prompt <> ''
    order by created_at,id limit 5000 for update skip locked
  )
  update public.generation_jobs g set prompt = '' from expired where g.id = expired.id;
  get diagnostics v_count = row_count;
  return jsonb_build_object('cleared',v_count,'cutoff',v_cutoff,'max_rows_per_run',5000);
end;
$$;
revoke all on function private.prune_prompt_text(boolean) from public, anon, authenticated, service_role;
select cron.schedule('posterflow-prompt-text-retention-7d', '23 * * * *', 'select private.prune_prompt_text(false);');
