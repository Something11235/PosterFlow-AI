-- Pending only. Add new resolution pricing, preserving all legacy RPCs and snapshots.
set local lock_timeout='5s';
alter table public.apimart_image_jobs add column pricing_policy_version integer not null default 1 check(pricing_policy_version in (1,3));
do $$
declare old_check text;
begin
 select pg_get_constraintdef(oid) into strict old_check from pg_constraint where conrelid='public.apimart_image_jobs'::regclass and conname='apimart_image_jobs_unit_credit_cost_check';
 execute 'alter table public.apimart_image_jobs drop constraint apimart_image_jobs_unit_credit_cost_check';
 execute 'alter table public.apimart_image_jobs add constraint apimart_image_jobs_unit_credit_cost_check check (case when pricing_policy_version=3 then unit_credit_cost in (0,0.5,1,1.5,2,2.5,3) else '||substring(old_check from 7)||' end)';
end;$$;
create function private.image_tier_cost(p_model text,p_resolution text,p_references integer) returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare base numeric:=1;rank integer;
begin
 if p_references is null or p_references<0 or p_references>8 then raise exception 'invalid references';end if;
 if p_model in ('seedream-5-0-pro','seedream-5-5') and p_resolution in ('1K','1.5K','2K') then
  base:=case when p_model='seedream-5-0-pro' then 2 else 1 end;rank:=case when p_resolution='2K' then 1 else 0 end;
 elsif p_model='grok-imagine-image-2.0' and p_resolution in ('1K','2K') then
  base:=case when p_references>0 then 2 else 1 end;rank:=case when p_resolution='2K' then 1 else 0 end;
 elsif p_model in ('gpt-image-2.5-flare','gpt-image-2.5-sunburst','gpt-image-2.6-flare','gpt-image-2.6-sunburst','gemini-nano-banana-2.1') and p_resolution in ('1K','2K','4K') then
  if p_model like 'gpt-image-2.6-%' and p_references>0 then base:=1.5;end if;
  rank:=case p_resolution when '1K' then 0 when '2K' then 1 else 2 end;
 else raise exception 'invalid resolution tier';end if;
 return base+rank*0.5;
end;$$;
create function private.adjust_image_tier_reservation(p_job uuid,p_model text,p_resolution text,p_references integer) returns numeric language plpgsql security definer set search_path='' as $$
declare j public.generation_jobs;cost numeric;delta numeric;b numeric;
begin
 select * into strict j from public.generation_jobs where id=p_job for update;
 cost:=private.image_tier_cost(p_model,p_resolution,p_references);
 if j.billing_mode='platform' then
  delta:=j.requested_count*cost-j.reserved_credits;
  select balance into b from public.credit_accounts where user_id=j.user_id for update;
  if delta>b then raise exception using errcode='P5501',message='IMAGE_TIER_CREDITS_INSUFFICIENT';end if;
  if delta<>0 then
   update public.credit_accounts set balance=balance-delta,updated_at=now() where user_id=j.user_id;
   insert into public.credit_transactions(user_id,job_id,type,delta,idempotency_key,metadata)
   values(j.user_id,j.id,'reserve',-delta,'reserve-tier:'||j.request_id::text,jsonb_build_object('resolution',p_resolution,'policy_version',3));
  end if;
  update public.generation_jobs set reserved_credits=requested_count*cost,
   metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('model_cost',cost,'resolution',p_resolution,'image_pricing_policy',3) where id=j.id;
 else cost:=0;end if;
 return cost;
end;$$;
create function private.begin_image_tier_job(p_owner text,p_user uuid,p_request uuid,p_mode text,p_model text,p_count integer,p_fingerprint text,p_prompt text,p_reference_count integer,p_resolution text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;j public.apimart_image_jobs;cost numeric;b numeric;
begin
 perform private.image_tier_cost(p_model,p_resolution,p_reference_count);
 if p_model like 'gpt-image-%' then return jsonb_build_object('ok',false,'code','MODEL_NOT_ALLOWED');end if;
 if p_model='seedream-5-5' then r:=private.begin_seedream55_image_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,p_resolution);
 elsif p_model='seedream-5-0-pro' then r:=private.begin_seedream_image_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,p_resolution);
 else r:=private.begin_apimart_image_job_v3(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,case when p_model='grok-imagine-image-2.0' then null else p_resolution end);end if;
 if not coalesce((r->>'ok')::boolean,false) or coalesce((r->>'existing')::boolean,false) then return r;end if;
 select * into strict j from public.apimart_image_jobs where id=(r->'job'->>'id')::uuid;
 cost:=case when p_mode='own_key' then 0 else private.adjust_image_tier_reservation(j.generation_job_id,p_model,p_resolution,p_reference_count) end;
 update public.apimart_image_jobs set unit_credit_cost=cost,pricing_resolution=p_resolution,pricing_policy_version=3 where id=j.id returning * into j;
 select balance into b from public.credit_accounts where user_id=p_user;
 return r||jsonb_build_object('job',to_jsonb(j),'balance',b);
exception when sqlstate 'P5501' then return jsonb_build_object('ok',false,'code','CREDITS_INSUFFICIENT');
end;$$;
create function private.begin_buytoken_image_tier_job(p_owner text,p_user uuid,p_request uuid,p_mode text,p_model text,p_count integer,p_fingerprint text,p_prompt text,p_reference_count integer,p_resolution text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;j public.apimart_image_jobs;cost numeric;b numeric;
begin
 perform private.image_tier_cost(p_model,p_resolution,p_reference_count);
 r:=private.begin_buytoken_gpt26_image_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,'1K');
 if not coalesce((r->>'ok')::boolean,false) or coalesce((r->>'existing')::boolean,false) then return r;end if;
 select * into strict j from public.apimart_image_jobs where id=(r->'job'->>'id')::uuid;
 cost:=case when p_mode='own_key' then 0 else private.adjust_image_tier_reservation(j.generation_job_id,p_model,p_resolution,p_reference_count) end;
 update public.apimart_image_jobs set unit_credit_cost=cost,pricing_resolution=p_resolution,pricing_policy_version=3 where id=j.id returning * into j;
 select balance into b from public.credit_accounts where user_id=p_user;
 return r||jsonb_build_object('job',to_jsonb(j),'balance',b);
exception when sqlstate 'P5501' then return jsonb_build_object('ok',false,'code','CREDITS_INSUFFICIENT');
end;$$;
create function private.reserve_legacy_image_tier_credits(p_user_id uuid,p_request_id uuid,p_count integer,p_provider text,p_model text,p_prompt text,p_resolution text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r jsonb;cost numeric;b numeric;
begin
 if p_model not in ('gpt-image-2.5-flare','gpt-image-2.5-sunburst') then return jsonb_build_object('ok',false,'code','MODEL_NOT_ALLOWED');end if;
 perform private.image_tier_cost(p_model,p_resolution,0);
 r:=public.reserve_platform_credits(p_user_id,p_request_id,p_count,p_provider,p_model,p_prompt,null,null);
 if not coalesce((r->>'ok')::boolean,false) or coalesce((r->>'existing')::boolean,false) then return r;end if;
 cost:=private.adjust_image_tier_reservation((r->>'job_id')::uuid,p_model,p_resolution,0);
 select balance into b from public.credit_accounts where user_id=p_user_id;
 return r||jsonb_build_object('balance',b,'reserved',cost*p_count);
exception when sqlstate 'P5501' then return jsonb_build_object('ok',false,'code','CREDITS_INSUFFICIENT');
end;$$;

CREATE FUNCTION private.settle_image_tier_generation(p_job_id uuid, p_generated_count integer, p_duration_ms integer, p_image_keys jsonb)
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
  if v_job.model not in ('gpt-image-2.5-flare','gpt-image-2.5-sunburst','gpt-image-2.6-flare','gpt-image-2.6-sunburst','gemini-nano-banana-2.1','grok-imagine-image-2.0','seedream-5-0-pro','seedream-5-5') then return jsonb_build_object('ok',false,'code','MODEL_NOT_ALLOWED'); end if;
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
CREATE FUNCTION private.refund_image_tier_generation(p_job_id uuid, p_reason text DEFAULT 'provider_failed'::text)
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
  if v_job.model not in ('gpt-image-2.5-flare','gpt-image-2.5-sunburst','gpt-image-2.6-flare','gpt-image-2.6-sunburst','gemini-nano-banana-2.1','grok-imagine-image-2.0','seedream-5-0-pro','seedream-5-5') then return jsonb_build_object('ok',false,'code','MODEL_NOT_ALLOWED'); end if;
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
create function private.apply_image_tier_job(p_owner text,p_request uuid,p_event text,p_task text default null,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.apimart_image_jobs; r jsonb; b numeric; n integer;
begin
  select * into j from public.apimart_image_jobs where owner_scope=p_owner and request_id=p_request for update;
  if not found or j.pricing_policy_version<>3 or j.submission_provider<>'apimart' then return jsonb_build_object('ok',false,'code','IMAGE_TASK_NOT_FOUND'); end if;
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
        r:=private.settle_image_tier_generation(j.generation_job_id,n,extract(epoch from (now()-j.created_at))::integer*1000,p_images);
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
      r:=private.refund_image_tier_generation(j.generation_job_id,coalesce(p_error,'APIMART_TASK_FAILED'));
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
create function private.apply_buytoken_image_tier_job(p_owner text,p_request uuid,p_event text,p_urls jsonb default '[]'::jsonb,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.apimart_image_jobs; r jsonb; b numeric; n integer;
begin
  select * into j from public.apimart_image_jobs where owner_scope=p_owner and request_id=p_request for update;
  if not found or j.submission_provider<>'buytoken' or j.model not in ('gpt-image-2.6-flare','gpt-image-2.6-sunburst') then
    return jsonb_build_object('ok',false,'code','IMAGE_TASK_NOT_FOUND');
  end if;
  if j.pricing_policy_version<>3 then return private.apply_buytoken_gpt26_image_job(p_owner,p_request,p_event,p_urls,p_images,p_token,p_error); end if;
  if j.status in ('completed','failed') then
    select balance into b from public.credit_accounts where user_id=j.user_id;
    return jsonb_build_object('ok',true,'job',to_jsonb(j),'balance',b,'claimed',false,'send',false);
  end if;
  if p_event='sending' then
    -- This transition is committed BEFORE the single paid POST. An uncertain
    -- result, including a process crash, must never authorize another POST.
    if j.status<>'submitting' then
      return jsonb_build_object('ok',true,'job',to_jsonb(j),'send',false);
    end if;
    update public.apimart_image_jobs set status='processing',updated_at=now() where id=j.id returning * into j;
    return jsonb_build_object('ok',true,'job',to_jsonb(j),'send',true);
  elsif p_event='received' then
    if p_urls is null or jsonb_typeof(p_urls)<>'array' then
      return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
    end if;
    n:=jsonb_array_length(p_urls);
    if n not between 1 and j.requested_count or exists(
      select 1 from jsonb_array_elements(p_urls) u
      where jsonb_typeof(u)<>'string' or length(u#>>'{}') not between 1 and 8192 or (u#>>'{}') !~ '^https://[^/@[:space:]]+/'
    ) then return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK'); end if;
    if jsonb_array_length(j.provider_result_urls)>0 then
      if j.provider_result_urls<>p_urls then return jsonb_build_object('ok',false,'code','IMAGE_REQUEST_CONFLICT'); end if;
    else
      update public.apimart_image_jobs set provider_result_urls=p_urls,status='processing',error_code=null,updated_at=now() where id=j.id;
    end if;
  elsif p_event='unknown' then
    if jsonb_array_length(j.provider_result_urls)=0 and j.status<>'saving' then
      update public.apimart_image_jobs set status='submission_unknown',error_code=left(p_error,100),updated_at=now() where id=j.id;
    end if;
  elsif p_event='claim' then
    if jsonb_array_length(j.provider_result_urls)=0 or p_token is null or (j.status='saving' and j.save_until>now()) then
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
      if p_images is null or jsonb_typeof(p_images)<>'array' then return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK'); end if;
      n:=jsonb_array_length(p_images);
      if n<>jsonb_array_length(j.provider_result_urls) or n not between 1 and j.requested_count
        or exists(select 1 from jsonb_array_elements(p_images) i where jsonb_typeof(i)<>'string' or (i#>>'{}') !~ '^[A-Za-z0-9_-]+\.(png|gif)$') then
        return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
      end if;
      if j.billing_mode='platform' then
        r:=private.settle_image_tier_generation(j.generation_job_id,n,extract(epoch from (now()-j.created_at))::integer*1000,p_images);
        if not coalesce((r->>'ok')::boolean,false) then return r; end if;
        b:=(r->>'balance')::numeric;
      elsif j.generation_job_id is not null then
        update public.generation_jobs set status='succeeded',generated_count=n,image_keys=p_images,settled_at=now(),duration_ms=extract(epoch from (now()-j.created_at))::integer*1000 where id=j.generation_job_id;
      end if;
      update public.apimart_image_jobs set status='completed',image_keys=p_images,provider_result_urls='[]'::jsonb,save_token=null,save_until=null,error_code=null,updated_at=now() where id=j.id;
    end if;
  elsif p_event='failed' then
    -- Accepted outputs must be recovered, never refunded by a late callback.
    if jsonb_array_length(j.provider_result_urls)>0 or j.status='saving' then
      return jsonb_build_object('ok',false,'code','IMAGE_RESULT_PENDING');
    end if;
    if j.billing_mode='platform' then
      r:=private.refund_image_tier_generation(j.generation_job_id,coalesce(p_error,'BUYTOKEN_REQUEST_REJECTED'));
      if not coalesce((r->>'ok')::boolean,false) then return r; end if;
      b:=(r->>'balance')::numeric;
    elsif j.generation_job_id is not null then
      update public.generation_jobs set status='failed',error_code=left(p_error,100),settled_at=now() where id=j.generation_job_id;
    end if;
    update public.apimart_image_jobs set status='failed',error_code=left(p_error,100),updated_at=now() where id=j.id;
  else
    return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
  end if;
  select * into j from public.apimart_image_jobs where id=j.id;
  if b is null then select balance into b from public.credit_accounts where user_id=j.user_id; end if;
  return jsonb_build_object('ok',true,'job',to_jsonb(j),'balance',b,'claimed',p_event='claim','send',false);
end;
$$;

create function public.begin_image_tier_job(p_owner text,p_user uuid,p_request uuid,p_mode text,p_model text,p_count integer,p_fingerprint text,p_prompt text,p_reference_count integer,p_resolution text) returns jsonb language sql security invoker set search_path='' as $$select private.begin_image_tier_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,p_resolution);$$;

create function public.begin_buytoken_image_tier_job(p_owner text,p_user uuid,p_request uuid,p_mode text,p_model text,p_count integer,p_fingerprint text,p_prompt text,p_reference_count integer,p_resolution text) returns jsonb language sql security invoker set search_path='' as $$select private.begin_buytoken_image_tier_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,p_resolution);$$;

create function public.reserve_legacy_image_tier_credits(p_user_id uuid,p_request_id uuid,p_count integer,p_provider text,p_model text,p_prompt text,p_resolution text) returns jsonb language sql security invoker set search_path='' as $$select private.reserve_legacy_image_tier_credits(p_user_id,p_request_id,p_count,p_provider,p_model,p_prompt,p_resolution);$$;

create function public.settle_image_tier_generation(p_job_id uuid, p_generated_count integer, p_duration_ms integer, p_image_keys jsonb) returns jsonb language sql security invoker set search_path='' as $$select private.settle_image_tier_generation(p_job_id,p_generated_count,p_duration_ms,p_image_keys);$$;

create function public.apply_image_tier_job(p_owner text,p_request uuid,p_event text,p_task text default null,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null) returns jsonb language sql security invoker set search_path='' as $$select private.apply_image_tier_job(p_owner,p_request,p_event,p_task,p_images,p_token,p_error);$$;

create function public.apply_buytoken_image_tier_job(p_owner text,p_request uuid,p_event text,p_urls jsonb default '[]'::jsonb,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null) returns jsonb language sql security invoker set search_path='' as $$select private.apply_buytoken_image_tier_job(p_owner,p_request,p_event,p_urls,p_images,p_token,p_error);$$;

revoke all on function private.image_tier_cost(text,text,integer),
private.adjust_image_tier_reservation(uuid,text,text,integer),
private.begin_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.begin_buytoken_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_buytoken_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.reserve_legacy_image_tier_credits(uuid,uuid,integer,text,text,text,text),
public.reserve_legacy_image_tier_credits(uuid,uuid,integer,text,text,text,text),
private.settle_image_tier_generation(uuid,integer,integer,jsonb),
public.settle_image_tier_generation(uuid,integer,integer,jsonb),
private.refund_image_tier_generation(uuid,text),
private.apply_image_tier_job(text,uuid,text,text,jsonb,uuid,text),
public.apply_image_tier_job(text,uuid,text,text,jsonb,uuid,text),
private.apply_buytoken_image_tier_job(text,uuid,text,jsonb,jsonb,uuid,text),
public.apply_buytoken_image_tier_job(text,uuid,text,jsonb,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function private.image_tier_cost(text,text,integer),
private.adjust_image_tier_reservation(uuid,text,text,integer),
private.begin_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.begin_buytoken_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_buytoken_image_tier_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.reserve_legacy_image_tier_credits(uuid,uuid,integer,text,text,text,text),
public.reserve_legacy_image_tier_credits(uuid,uuid,integer,text,text,text,text),
private.settle_image_tier_generation(uuid,integer,integer,jsonb),
public.settle_image_tier_generation(uuid,integer,integer,jsonb),
private.refund_image_tier_generation(uuid,text),
private.apply_image_tier_job(text,uuid,text,text,jsonb,uuid,text),
public.apply_image_tier_job(text,uuid,text,text,jsonb,uuid,text),
private.apply_buytoken_image_tier_job(text,uuid,text,jsonb,jsonb,uuid,text),
public.apply_buytoken_image_tier_job(text,uuid,text,jsonb,jsonb,uuid,text) to service_role;
