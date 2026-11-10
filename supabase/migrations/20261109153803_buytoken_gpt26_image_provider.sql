-- Additive only. Existing APIMart rows, RPCs and price snapshots remain intact.
-- Apply once, only after release approval. No account or ledger backfill.
alter table public.apimart_image_jobs
  add column submission_provider text not null default 'apimart'
    check (submission_provider in ('apimart','buytoken')),
  add column provider_result_urls jsonb not null default '[]'::jsonb
    check (jsonb_typeof(provider_result_urls)='array');

CREATE FUNCTION private.begin_buytoken_gpt26_image_job(p_owner text, p_user uuid, p_request uuid, p_mode text, p_model text, p_count integer, p_fingerprint text, p_prompt text, p_reference_count integer, p_resolution text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j public.apimart_image_jobs; r jsonb; gid uuid; b numeric; v_cost numeric;
begin
  if p_owner is null or p_request is null or p_mode is null or p_model is null or p_count is null or p_fingerprint is null or p_prompt is null
    or p_mode not in ('platform','own_key') or p_model not in ('gpt-image-2.6-flare','gpt-image-2.6-sunburst')
    or p_count not between 1 and 4
    or p_reference_count is null or p_reference_count not between 0 and 8
    or p_resolution is null or p_resolution <> '1K'
    or p_fingerprint !~ '^[a-f0-9]{64}$' or length(p_prompt) not between 1 and 6000
    or (p_mode='platform' and (p_user is null or p_owner<>'user-'||p_user::text)) then
    return jsonb_build_object('ok',false,'code','INVALID_IMAGE_TASK');
  end if;
  v_cost:=case when p_mode='own_key' then 0 when p_reference_count > 0 then 1.5 else 1 end;
  perform pg_advisory_xact_lock(hashtextextended('apimart-image:'||p_owner||p_request::text,0));
  select * into j from public.apimart_image_jobs where owner_scope=p_owner and request_id=p_request for update;
  if found then
    if j.submission_provider<>'buytoken' or j.request_fingerprint<>p_fingerprint or j.model<>p_model or j.billing_mode<>p_mode or j.user_id is distinct from p_user or j.reference_count<>p_reference_count
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
    r:=private.reserve_gpt26_credits_v2(p_user,p_request,p_count,'api.buytoken.work',p_model,p_prompt,p_reference_count,null,null);
    if not coalesce((r->>'ok')::boolean,false) then return r; end if;
    gid:=(r->>'job_id')::uuid;
    b:=(r->>'balance')::numeric;
  elsif p_user is not null then
    insert into public.generation_jobs(user_id,request_id,billing_mode,provider,model,status,requested_count,reserved_credits,prompt)
    values(p_user,p_request,'own_key','api.buytoken.work',p_model,'running',p_count,0,p_prompt) returning id into gid;
  end if;
  insert into public.apimart_image_jobs(owner_scope,user_id,request_id,billing_mode,model,requested_count,request_fingerprint,generation_job_id,reference_count,unit_credit_cost,pricing_resolution,submission_provider)
  values(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,gid,p_reference_count,v_cost,p_resolution,'buytoken') returning * into j;
  return jsonb_build_object('ok',true,'existing',false,'job',to_jsonb(j),'balance',b);
end;
$function$;

create function public.begin_buytoken_gpt26_image_job(p_owner text,p_user uuid,p_request uuid,p_mode text,p_model text,p_count integer,p_fingerprint text,p_prompt text,p_reference_count integer,p_resolution text)
returns jsonb language sql security invoker set search_path='' as $$
 select private.begin_buytoken_gpt26_image_job(p_owner,p_user,p_request,p_mode,p_model,p_count,p_fingerprint,p_prompt,p_reference_count,p_resolution);
$$;

create function private.apply_buytoken_gpt26_image_job(p_owner text,p_request uuid,p_event text,p_urls jsonb default '[]'::jsonb,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.apimart_image_jobs; r jsonb; b numeric; n integer;
begin
  select * into j from public.apimart_image_jobs where owner_scope=p_owner and request_id=p_request for update;
  if not found or j.submission_provider<>'buytoken' or j.model not in ('gpt-image-2.6-flare','gpt-image-2.6-sunburst') then
    return jsonb_build_object('ok',false,'code','IMAGE_TASK_NOT_FOUND');
  end if;
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
        r:=private.settle_gpt26_generation(j.generation_job_id,n,extract(epoch from (now()-j.created_at))::integer*1000,p_images);
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
      r:=private.refund_gpt26_generation(j.generation_job_id,coalesce(p_error,'BUYTOKEN_REQUEST_REJECTED'));
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

create function public.apply_buytoken_gpt26_image_job(p_owner text,p_request uuid,p_event text,p_urls jsonb default '[]'::jsonb,p_images jsonb default '[]'::jsonb,p_token uuid default null,p_error text default null)
returns jsonb language sql security invoker set search_path='' as $$
 select private.apply_buytoken_gpt26_image_job(p_owner,p_request,p_event,p_urls,p_images,p_token,p_error);
$$;

revoke all on function private.begin_buytoken_gpt26_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_buytoken_gpt26_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.apply_buytoken_gpt26_image_job(text,uuid,text,jsonb,jsonb,uuid,text),
public.apply_buytoken_gpt26_image_job(text,uuid,text,jsonb,jsonb,uuid,text) from public,anon,authenticated;
grant execute on function private.begin_buytoken_gpt26_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
public.begin_buytoken_gpt26_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text),
private.apply_buytoken_gpt26_image_job(text,uuid,text,jsonb,jsonb,uuid,text),
public.apply_buytoken_gpt26_image_job(text,uuid,text,jsonb,jsonb,uuid,text) to service_role;

