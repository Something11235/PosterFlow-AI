-- Model-aware platform credit billing. Keep this migration append-only.
create or replace function public.reserve_platform_credits(
  p_user_id uuid,
  p_request_id uuid,
  p_count integer,
  p_provider text,
  p_model text,
  p_prompt text,
  p_user_daily_limit integer default null,
  p_platform_daily_limit integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_existing public.generation_jobs%rowtype;
  v_balance integer;
  v_status text;
  v_user_total integer;
  v_platform_total integer;
  v_job_id uuid;
  v_model_cost integer;
  v_reserved_credits integer;
begin
  if p_count < 1 or p_count > 4 then
    return jsonb_build_object('ok', false, 'code', 'PARAMETER_INVALID');
  end if;
  v_model_cost := case p_model
    when 'gpt-image-2.5-flare' then 1
    when 'gpt-image-2.5-sunburst' then 2
    else 0
  end;
  if v_model_cost = 0 then
    return jsonb_build_object('ok', false, 'code', 'MODEL_NOT_ALLOWED');
  end if;
  v_reserved_credits := p_count * v_model_cost;

  perform public.ensure_signup_bonus(p_user_id);
  select status into v_status from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AUTH_USER_NOT_FOUND');
  end if;
  if v_status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_FROZEN');
  end if;
  if not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('ok', false, 'code', 'EMAIL_UNVERIFIED');
  end if;

  select * into v_existing from public.generation_jobs where request_id = p_request_id for update;
  if found then
    if v_existing.user_id <> p_user_id then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_ID_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true,
      'existing', true,
      'job_id', v_existing.id,
      'status', v_existing.status,
      'images', v_existing.image_keys,
      'balance', (select balance from public.credit_accounts where user_id = p_user_id)
    );
  end if;

  if p_user_daily_limit is not null and p_user_daily_limit > 0 then
    select coalesce(sum(requested_count), 0) into v_user_total
    from public.generation_jobs
    where user_id = p_user_id and billing_mode = 'platform' and created_at >= date_trunc('day', now());
    if v_user_total + p_count > p_user_daily_limit then
      return jsonb_build_object('ok', false, 'code', 'USER_DAILY_LIMIT');
    end if;
  end if;
  if p_platform_daily_limit is not null and p_platform_daily_limit > 0 then
    select coalesce(sum(requested_count), 0) into v_platform_total
    from public.generation_jobs
    where billing_mode = 'platform' and created_at >= date_trunc('day', now());
    if v_platform_total + p_count > p_platform_daily_limit then
      return jsonb_build_object('ok', false, 'code', 'PLATFORM_DAILY_LIMIT');
    end if;
  end if;

  select balance into v_balance from public.credit_accounts where user_id = p_user_id for update;
  if coalesce(v_balance, 0) < v_reserved_credits then
    return jsonb_build_object('ok', false, 'code', 'CREDITS_INSUFFICIENT', 'balance', coalesce(v_balance, 0), 'required', v_reserved_credits);
  end if;

  insert into public.generation_jobs (
    user_id, request_id, billing_mode, provider, model, status, requested_count,
    reserved_credits, prompt, metadata
  ) values (
    p_user_id, p_request_id, 'platform', p_provider, p_model, 'running', p_count,
    v_reserved_credits, left(p_prompt, 6000), jsonb_build_object('model_cost', v_model_cost)
  ) returning id into v_job_id;

  update public.credit_accounts
  set balance = balance - v_reserved_credits, updated_at = now()
  where user_id = p_user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (p_user_id, v_job_id, 'reserve', -v_reserved_credits, 'reserve:' || p_request_id::text,
    jsonb_build_object('count', p_count, 'model', p_model, 'model_cost', v_model_cost));

  select balance into v_balance from public.credit_accounts where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'job_id', v_job_id, 'status', 'running', 'balance', v_balance, 'reserved', v_reserved_credits);
end;
$$;

create or replace function public.settle_generation(
  p_job_id uuid,
  p_generated_count integer,
  p_duration_ms integer,
  p_image_keys jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_job public.generation_jobs%rowtype;
  v_model_cost integer;
  v_charge integer;
  v_refund integer;
  v_balance integer;
  v_generated_images integer;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if v_job.status in ('succeeded', 'refunded', 'failed') then
    select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
    return jsonb_build_object('ok', true, 'existing', true, 'status', v_job.status, 'balance', v_balance);
  end if;
  v_model_cost := case v_job.model
    when 'gpt-image-2.5-sunburst' then 2
    when 'gpt-image-2.5-flare' then 1
    else 1
  end;
  v_generated_images := greatest(0, least(coalesce(p_generated_count, 0), v_job.requested_count));
  v_charge := least(v_job.reserved_credits, v_generated_images * v_model_cost);
  v_refund := v_job.reserved_credits - v_charge;
  update public.generation_jobs
  set status = case when v_charge > 0 then 'succeeded' else 'refunded' end,
      generated_count = v_generated_images,
      charged_credits = v_charge,
      image_keys = coalesce(p_image_keys, '[]'::jsonb),
      duration_ms = greatest(coalesce(p_duration_ms, 0), 0),
      settled_at = now()
  where id = p_job_id;
  update public.credit_accounts
  set total_spent = total_spent + v_charge,
      total_refunded = total_refunded + v_refund,
      balance = balance + v_refund,
      updated_at = now()
  where user_id = v_job.user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (v_job.user_id, p_job_id, 'spend', 0, 'spend:' || p_job_id::text,
    jsonb_build_object('count', v_generated_images, 'model', v_job.model, 'model_cost', v_model_cost))
  on conflict (user_id, idempotency_key) do nothing;
  if v_refund > 0 then
    insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
    values (v_job.user_id, p_job_id, 'refund', v_refund, 'refund:' || p_job_id::text,
      jsonb_build_object('reason', 'partial_or_empty_result'))
    on conflict (user_id, idempotency_key) do nothing;
  end if;
  select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'status', case when v_charge > 0 then 'succeeded' else 'refunded' end, 'balance', v_balance, 'charged', v_charge, 'refunded', v_refund);
end;
$$;

revoke all on function public.reserve_platform_credits(uuid, uuid, integer, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.settle_generation(uuid, integer, integer, jsonb) from public, anon, authenticated;
grant execute on function public.reserve_platform_credits(uuid, uuid, integer, text, text, text, integer, integer) to service_role;
grant execute on function public.settle_generation(uuid, integer, integer, jsonb) to service_role;