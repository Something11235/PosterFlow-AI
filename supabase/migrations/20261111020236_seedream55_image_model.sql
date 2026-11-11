-- Additive Seedream 5.5 billing. Pending release; do not apply without approval.
-- Existing models, pricing snapshots, RPC bodies and ACL stay unchanged.
set local lock_timeout='5s';
do $$
declare old_check text;
begin
 select pg_get_constraintdef(oid) into strict old_check from pg_constraint
 where conrelid='public.apimart_image_jobs'::regclass and conname='apimart_image_jobs_model_check';
 execute 'alter table public.apimart_image_jobs drop constraint apimart_image_jobs_model_check';
 execute 'alter table public.apimart_image_jobs add constraint apimart_image_jobs_model_check check (model=''seedream-5-5'' or '||substring(old_check from 7)||')';
end;$$;
CREATE FUNCTION private.reserve_seedream55_credits(p_user_id uuid, p_request_id uuid, p_count integer, p_provider text, p_model text, p_prompt text, p_user_daily_limit integer DEFAULT NULL::integer, p_platform_daily_limit integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.generation_jobs%rowtype;
  v_balance numeric;
  v_status text;
  v_user_total integer;
  v_platform_total integer;
  v_job_id uuid;
  v_model_cost numeric;
  v_reserved_credits numeric;
begin
  if p_count is null or p_count < 1 or p_count <> 1 or p_model is null or p_model <> 'seedream-5-5' then
    return jsonb_build_object('ok', false, 'code', 'PARAMETER_INVALID');
  end if;
  v_model_cost := 1;
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
    v_reserved_credits, left(p_prompt, 6000), jsonb_build_object('model_cost', v_model_cost, 'pricing_basis', 'per_image')
  ) returning id into v_job_id;

  update public.credit_accounts
  set balance = balance - v_reserved_credits, updated_at = now()
  where user_id = p_user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (p_user_id, v_job_id, 'reserve', -v_reserved_credits, 'reserve:' || p_request_id::text,
    jsonb_build_object('count', p_count, 'model', p_model, 'model_cost', v_model_cost, 'pricing_basis', 'per_image'));

  select balance into v_balance from public.credit_accounts where user_id = p_user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'job_id', v_job_id, 'status', 'running', 'balance', v_balance, 'reserved', v_reserved_credits);
end;
$function$;

CREATE FUNCTION private.begin_seedream55_image_job(p_owner text, p_user uuid, p_request uuid, p_mode text, p_model text, p_count integer, p_fingerprint text, p_prompt text, p_reference_count integer, p_resolution text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j public.apimart_image_jobs; r jsonb; gid uuid; b numeric; v_cost numeric;
begin
  if p_owner is null or p_request is null or p_mode is null or p_model is null or p_count is null or p_fingerprint is null or p_prompt is null
    or p_mode not in ('platform','own_key') or p_model not in ('seedream-5-5')
    or p_count <> 1
    or p_reference_count is null or p_reference_count not between 0 and 8 or p_reference_count+p_count>15
    or (p_model='seedream-5-0-lite' and (p_resolution is null or p_resolution not in ('2K','3K','4K')))
    or (p_model<>'seedream-5-0-lite' and p_resolution is not null and p_resolution not in ('1K','1.5K','2K'))
    or p_fingerprint !~ '^[a-f0-9]{64}$' or length(p_prompt) not between 1 and 6000
    or (p_mode='platform' and (p_user is null or p_owner<>'user-'||p_user::text)) then
    return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
  end if;
  v_cost:=case when p_mode='own_key' then 0 else 1 end;
  perform pg_advisory_xact_lock(hashtextextended('apimart-image:'||p_owner||p_request::text,0));
  select * into j from public.apimart_image_jobs where owner_scope=p_owner and request_id=p_request for update;
  if found then
    if j.request_fingerprint<>p_fingerprint or j.model<>p_model or j.billing_mode<>p_mode or j.user_id is distinct from p_user or j.reference_count<>p_reference_count
      or (j.pricing_resolution is not null and j.pricing_resolution is distinct from p_resolution) then
      return jsonb_build_object('ok',false,'code','IMAGE_REQUEST_CONFLICT');
    end if;
    select balance into b from public.credit_accounts where user_id=p_user;
    return jsonb_build_object('ok',true,'existing',true,'job',to_jsonb(j),'balance',b);
  end if;
  if exists(select 1 from public.generation_jobs where request_id=p_request) then
    return jsonb_build_object('ok',false,'code','IMAGE_REQUEST_CONFLICT');
  end if;
  if p_mode='platform' then
    r:=private.reserve_seedream55_credits(p_user,p_request,p_count,'api.apimart.ai',p_model,p_prompt,null,null);
    if not coalesce((r->>'ok')::boolean,false) then return r; end if;
    gid:=(r->>'job_id')::uuid;
    b:=(r->>'balance')::numeric;
  elsif p_user is not null then
    insert into public.generation_jobs(user_id,request_id,billing_mode,provider,model,status,requested_count,reserved_credits,prompt)
    values(p_user,p_request,'own_key','api.apimart.ai',p_model,'running',p_count,0,p_prompt) returning id into gid;
  end if;
  insert into public.apimart_image_jobs(owner_scope,user_id,request_id,billing_mode,model,requested_count,request_fingerprint,generation_job_id,reference_count,unit_credit_cost,pricing_resolution)
  values(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,gid,p_reference_count,v_cost,p_resolution) returning * into j;
  return jsonb_build_object('ok',true,'existing',false,'job',to_jsonb(j),'balance',b);
end;
$function$;

CREATE FUNCTION private.settle_seedream55_generation(p_job_id uuid, p_generated_count integer, p_duration_ms integer, p_image_keys jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job public.generation_jobs%rowtype;
  v_model_cost numeric;
  v_charge numeric;
  v_refund numeric;
  v_balance numeric;
  v_generated_images integer;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if v_job.model not in ('seedream-5-5') then return jsonb_build_object('ok',false,'code','MODEL_NOT_ALLOWED'); end if;
  if v_job.status in ('succeeded', 'refunded', 'failed') then
    select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
    return jsonb_build_object('ok', true, 'existing', true, 'status', v_job.status, 'balance', v_balance);
  end if;
  -- requested_count is constrained to 1..4. Derive the reserved unit price
  -- so an in-flight job keeps its original price across pricing changes.
  v_model_cost := v_job.reserved_credits / v_job.requested_count;
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
$function$;

CREATE FUNCTION private.refund_seedream55_generation(p_job_id uuid, p_reason text DEFAULT 'provider_failed'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job public.generation_jobs%rowtype;
  v_balance numeric;
begin
  select * into v_job from public.generation_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'JOB_NOT_FOUND'); end if;
  if v_job.model not in ('seedream-5-5') then return jsonb_build_object('ok',false,'code','MODEL_NOT_ALLOWED'); end if;
  if v_job.status in ('succeeded', 'refunded', 'failed') then
    select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
    return jsonb_build_object('ok', true, 'existing', true, 'balance', v_balance);
  end if;
  update public.generation_jobs
  set status = 'refunded', error_code = left(coalesce(p_reason, 'provider_failed'), 120), settled_at = now()
  where id = p_job_id;
  update public.credit_accounts
  set balance = balance + v_job.reserved_credits,
      total_refunded = total_refunded + v_job.reserved_credits,
      updated_at = now()
  where user_id = v_job.user_id;
  insert into public.credit_transactions (user_id, job_id, type, delta, idempotency_key, metadata)
  values (v_job.user_id, p_job_id, 'refund', v_job.reserved_credits, 'refund:' || p_job_id::text, jsonb_build_object('reason', p_reason))
  on conflict (user_id, idempotency_key) do nothing;
  select balance into v_balance from public.credit_accounts where user_id = v_job.user_id;
  return jsonb_build_object('ok', true, 'existing', false, 'balance', v_balance, 'refunded', v_job.reserved_credits);
end;
$function$;

create function private.apply_seedream55_image_job(p_owner text,p_request uuid,p_event text,p_task text default null,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.apimart_image_jobs; r jsonb; b numeric; n integer;
begin
  select * into j from public.apimart_image_jobs where owner_scope=p_owner and request_id=p_request for update;
  if not found or j.model<>'seedream-5-5' or j.submission_provider<>'apimart' then return jsonb_build_object('ok',false,'code','IMAGE_TASK_NOT_FOUND'); end if;
  if j.status in ('completed','failed') then
    select balance into b from public.credit_accounts where user_id=j.user_id;
    return jsonb_build_object('ok',true,'job',to_jsonb(j),'balance',b,'claimed',false);
  end if;
  if p_event='submitted' then
    if p_task is null or p_task !~ '^[A-Za-z0-9_-]{8,160}$' or (j.provider_task_id is not null and j.provider_task_id<>p_task) then
      return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
    end if;
    update public.apimart_image_jobs set provider_task_id=p_task,status='submitted',updated_at=now() where id=j.id;
  elsif p_event='submission_unknown' and j.provider_task_id is null then
    update public.apimart_image_jobs set status='submission_unknown',error_code=left(p_error,100),updated_at=now() where id=j.id;
  elsif p_event='claim' then
    if j.provider_task_id is null or p_token is null or (j.status='saving' and j.save_until>now()) then
      return jsonb_build_object('ok',true,'job',to_jsonb(j),'claimed',false);
    end if;
    update public.apimart_image_jobs set status='saving',save_token=p_token,save_until=now()+interval '5 minutes',updated_at=now() where id=j.id;
  elsif p_event in ('completed','retry') then
    if p_token is null or j.save_token is distinct from p_token or j.status<>'saving' then
      return jsonb_build_object('ok',false,'code','IMAGE_SAVE_CONFLICT');
    end if;
    if p_event='retry' then
      update public.apimart_image_jobs set status='processing',save_token=null,save_until=null,error_code=left(p_error,100),updated_at=now() where id=j.id;
    else
      if jsonb_typeof(p_images)<>'array' then return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK'); end if;
      n:=jsonb_array_length(p_images);
      if n not between 1 and j.requested_count then return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK'); end if;
      if j.billing_mode='platform' then
        r:=private.settle_seedream55_generation(j.generation_job_id,n,extract(epoch from (now()-j.created_at))::integer*1000,p_images);
        if not coalesce((r->>'ok')::boolean,false) then return r; end if;
        b:=(r->>'balance')::numeric;
      elsif j.generation_job_id is not null then
        update public.generation_jobs set status='succeeded',generated_count=n,image_keys=p_images,settled_at=now(),duration_ms=extract(epoch from (now()-j.created_at))::integer*1000 where id=j.generation_job_id;
      end if;
      update public.apimart_image_jobs set status='completed',image_keys=p_images,save_token=null,save_until=null,error_code=null,updated_at=now() where id=j.id;
    end if;
  elsif p_event='failed' then
    -- Never let a stale failure callback race a worker currently saving results.
    if j.status='saving' and j.save_until>now() then return jsonb_build_object('ok',true,'job',to_jsonb(j),'claimed',false); end if;
    if j.billing_mode='platform' then
      r:=private.refund_seedream55_generation(j.generation_job_id,coalesce(p_error,'APIMART_TASK_FAILED'));
      if not coalesce((r->>'ok')::boolean,false) then return r; end if;
      b:=(r->>'balance')::numeric;
    elsif j.generation_job_id is not null then
      update public.generation_jobs set status='failed',error_code=left(p_error,100),settled_at=now() where id=j.generation_job_id;
    end if;
    update public.apimart_image_jobs set status='failed',error_code=left(p_error,100),updated_at=now() where id=j.id;
  elsif p_event not in ('processing','unknown') then
    return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
  elsif j.status<>'saving' then
    update public.apimart_image_jobs set status=p_event,updated_at=now() where id=j.id;
  end if;
  select * into j from public.apimart_image_jobs where id=j.id;
  if b is null then select balance into b from public.credit_accounts where user_id=j.user_id; end if;
  return jsonb_build_object('ok',true,'job',to_jsonb(j),'balance',b,'claimed',p_event='claim');
end;
$$;
create function public.begin_seedream55_image_job(p_owner text,p_user uuid,p_request uuid,p_mode text,p_model text,p_count integer,p_fingerprint text,p_prompt text,p_reference_count integer,p_resolution text) returns jsonb language sql security invoker set search_path='' as $$select private.begin_seedream55_image_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,p_resolution);$$;

create function public.apply_seedream55_image_job(p_owner text,p_request uuid,p_event text,p_task text default null,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null) returns jsonb language sql security invoker set search_path='' as $$select private.apply_seedream55_image_job(p_owner,p_request,p_event,p_task,p_images,p_token,p_error);$$;

revoke all on function private.reserve_seedream55_credits(uuid,uuid,integer,text,text,text,integer,integer),
private.begin_seedream55_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_seedream55_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.settle_seedream55_generation(uuid,integer,integer,jsonb),
private.refund_seedream55_generation(uuid,text),
private.apply_seedream55_image_job(text,uuid,text,text,jsonb,uuid,text),
public.apply_seedream55_image_job(text,uuid,text,text,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function private.reserve_seedream55_credits(uuid,uuid,integer,text,text,text,integer,integer),
private.begin_seedream55_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_seedream55_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.settle_seedream55_generation(uuid,integer,integer,jsonb),
private.refund_seedream55_generation(uuid,text),
private.apply_seedream55_image_job(text,uuid,text,text,jsonb,uuid,text),
public.apply_seedream55_image_job(text,uuid,text,text,jsonb,uuid,text) to service_role;
