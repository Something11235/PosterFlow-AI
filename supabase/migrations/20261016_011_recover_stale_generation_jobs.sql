-- Refund platform jobs that were left running after a serverless function timeout.
-- Apply this migration in the Supabase SQL editor or with the Supabase CLI.

create or replace function public.recover_stale_generation_jobs(
  p_user_id uuid,
  p_stale_after_minutes integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_recovered integer := 0;
  v_refunded integer := 0;
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'USER_REQUIRED');
  end if;
  if p_stale_after_minutes < 5 or p_stale_after_minutes > 1440 then
    return jsonb_build_object('ok', false, 'code', 'TIMEOUT_WINDOW_INVALID');
  end if;

  for v_job in
    select *
    from public.generation_jobs
    where user_id = p_user_id
      and billing_mode = 'platform'
      and status = 'running'
      and created_at <= now() - make_interval(mins => p_stale_after_minutes)
    order by created_at
    for update skip locked
  loop
    update public.generation_jobs
    set status = 'refunded',
        error_code = 'STALE_JOB_RECOVERED',
        settled_at = now()
    where id = v_job.id
      and status = 'running';

    if not found then
      continue;
    end if;

    update public.credit_accounts
    set balance = balance + v_job.reserved_credits,
        total_refunded = total_refunded + v_job.reserved_credits,
        updated_at = now()
    where user_id = v_job.user_id;

    insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
    values (
      v_job.user_id,
      v_job.id,
      'refund',
      v_job.reserved_credits,
      'refund:' || v_job.id::text,
      jsonb_build_object(
        'reason', 'stale_job_recovered',
        'stale_after_minutes', p_stale_after_minutes
      )
    )
    on conflict (user_id, idempotency_key) do nothing;

    v_recovered := v_recovered + 1;
    v_refunded := v_refunded + v_job.reserved_credits;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'recovered', v_recovered,
    'refunded', v_refunded
  );
end;
$$;

revoke all on function public.recover_stale_generation_jobs(uuid, integer) from public, anon, authenticated;
grant execute on function public.recover_stale_generation_jobs(uuid, integer) to service_role;
