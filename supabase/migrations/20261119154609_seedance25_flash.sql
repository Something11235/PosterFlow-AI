set local lock_timeout='5s';

alter table public.video_jobs
  drop constraint video_jobs_model_check,
  drop constraint video_jobs_generation_shape,
  add constraint video_jobs_model_check check(model in ('seedance-2.0-mini','seedance-2.0','seedance-2.0-fast','seedance-2.5','seedance-2-5-flash','gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video')),
  add constraint video_jobs_generation_shape check(
    (operation='generate' and resolution is not null and (
      (model in ('seedance-2.0-mini','seedance-2.0-fast') and requested_duration between 4 and 15 and resolution in ('480p','720p'))
      or (model='seedance-2.0' and requested_duration between 4 and 15 and resolution in ('480p','720p','1080p','4k'))
      or (model='seedance-2.5' and resolution in ('480p','720p','1080p') and (requested_duration=-1 or requested_duration between 4 and 30))
      or (model='seedance-2-5-flash' and resolution in ('480p','720p') and (requested_duration=-1 or requested_duration between 4 and 30) and not is_draft and draft_source_id is null)
      or (model='MiniMax-H3' and requested_duration between 4 and 15 and resolution in ('768p','2k','hd','fhd'))
      or (model='flux-3-video' and requested_duration between 5 and 20 and resolution in ('hd','fhd'))
      or (model='wan3.0-video' and (requested_duration=-1 or requested_duration between 2 and 30) and resolution in ('480p','720p','1080p'))
      or (model='MiniMax-H3-Max' and requested_duration between 5 and 15 and resolution in ('480p','768p','1080p'))
      or (model='gemini-omni-1.1-flash' and requested_duration=-1 and resolution in ('360p','720p','1080p','4k'))
    )) or (operation='asset_review' and model not in ('gemini-omni-1.1-flash','MiniMax-H3','MiniMax-H3-Max','wan3.0-video','flux-3-video') and requested_duration=0 and resolution is null and unit_credit_cost=0 and estimated_credits=0)
  );

create function private.begin_seedance25_flash_job(p_owner text,p_user_id uuid,p_request_id uuid,p_mode text,
  p_operation text,p_fingerprint text,p_parameters jsonb,p_references jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  model_id constant text := 'seedance-2-5-flash';
  profile constant jsonb := '{"version":"seedance25-flash-gold-half-v1","usd_cny":"7","credit_cny":"0.38","markup":"1.2"}';
  job public.video_jobs;
  account_balance numeric;
  res text;
  output_seconds integer := 0;
  video_ms integer := 0;
  audio_ms integer := 0;
  usd_per_second numeric;
  estimated_usd numeric;
  estimated numeric := 0;
  reserved numeric := 0;
begin
  if p_request_id is null or p_user_id is null or p_owner is null or p_mode is null
    or p_mode not in ('platform','own_key')
    or (p_mode='platform' and p_owner <> 'user-'||p_user_id::text)
    or (p_mode='own_key' and p_owner !~ ('^user-'||p_user_id::text||'-[a-f0-9]{64}$'))
    or p_operation is null or p_operation not in ('generate','asset_review')
    or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_parameters) is distinct from 'object' or p_parameters->>'model' is distinct from model_id
    or jsonb_typeof(p_references) is distinct from 'array' then
    return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_owner||':'||p_request_id::text,0));
  select * into job from public.video_jobs where owner_scope=p_owner and request_id=p_request_id for update;
  if found then
    if job.model<>model_id or job.operation<>p_operation or job.request_fingerprint<>p_fingerprint then
      return jsonb_build_object('ok',false,'code','VIDEO_REQUEST_CONFLICT');
    end if;
    return jsonb_build_object('ok',true,'existing',true,'job',to_jsonb(job));
  end if;
  if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('ok',false,'code','EMAIL_UNVERIFIED');
  end if;
  if not exists(select 1 from public.profiles where id=p_user_id and status='active' and deleted_at is null) then
    return jsonb_build_object('ok',false,'code','ACCOUNT_FROZEN');
  end if;

  if jsonb_array_length(p_references)>20 or exists(
    select 1 from jsonb_array_elements(p_references) r
    where jsonb_typeof(r) <> 'object' or r-array['id','kind','sha256','asset_url','role','duration_ms','width','height','fps','codec','size'] <> '{}'::jsonb
      or jsonb_typeof(r->'id') is distinct from 'string' or coalesce(r->>'kind','') not in ('image','video','audio')
  ) then return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT'); end if;

  if p_operation='generate' then
    res := p_parameters->>'resolution';
    if res is null or res not in ('480p','720p')
      or p_parameters-array['model','prompt','duration','size','resolution','seed','generate_audio','return_last_frame','tools','nsfw_check','output_format','watermark','omni_reference_task_type'] <> '{}'::jsonb
      or jsonb_typeof(p_parameters->'duration') is distinct from 'number' or p_parameters->>'duration' !~ '^(-1|[4-9]|[12][0-9]|30)$'
      or jsonb_typeof(p_parameters->'prompt') is distinct from 'string' or char_length(btrim(p_parameters->>'prompt')) not between 1 and 32000 then
      return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');
    end if;
    if exists(select 1 from jsonb_array_elements(p_references) r group by r->>'kind'
      having count(*) > case when r->>'kind'='image' then 10 else 5 end) then
      return jsonb_build_object('ok',false,'code','VIDEO_REFERENCE_COUNT');
    end if;
    if exists(select 1 from jsonb_array_elements(p_references) r where r->>'kind' in ('video','audio') and
      (jsonb_typeof(r->'duration_ms') is distinct from 'number' or coalesce(r->>'duration_ms','') !~ '^[0-9]{4,5}$')) then
      return jsonb_build_object('ok',false,'code','VIDEO_REFERENCE_DURATION');
    end if;
    if exists(select 1 from jsonb_array_elements(p_references) r where r->>'kind' in ('video','audio')
      and (r->>'duration_ms')::integer not between 2000 and 30000) then
      return jsonb_build_object('ok',false,'code','VIDEO_REFERENCE_DURATION');
    end if;
    select coalesce(sum((r->>'duration_ms')::integer) filter(where r->>'kind'='video'),0),
           coalesce(sum((r->>'duration_ms')::integer) filter(where r->>'kind'='audio'),0)
      into video_ms,audio_ms from jsonb_array_elements(p_references) r;
    if video_ms>30000 or audio_ms>30000 then return jsonb_build_object('ok',false,'code','VIDEO_REFERENCE_DURATION'); end if;

    output_seconds := (p_parameters->>'duration')::integer;
    -- Gold Credits divided by 10 convert exactly to USD; only video references add billable seconds.
    usd_per_second := case res when '480p' then case when video_ms>0 then 0.0384 else 0.06312 end
                               else case when video_ms>0 then 0.0864 else 0.14192 end end;
    estimated_usd := ((case when output_seconds=-1 then 30 else output_seconds end) + video_ms/1000.0) * usd_per_second;
    estimated := private.seedance25_charge(estimated_usd);
    reserved := private.seedance25_charge(estimated_usd*1.6);
  elsif p_parameters <> jsonb_build_object('model',model_id) or jsonb_array_length(p_references)<>1 then
    return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');
  end if;

  select balance into account_balance from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED'); end if;
  if p_mode='platform' and exists(select 1 from public.video_jobs where user_id=p_user_id and billing_status='awaiting_balance') then
    return jsonb_build_object('ok',false,'code','VIDEO_UNSETTLED_BALANCE');
  end if;
  if (select count(*) from public.video_jobs where user_id=p_user_id and operation=p_operation and status not in ('completed','failed'))>=3 then
    return jsonb_build_object('ok',false,'code','VIDEO_QUEUE_FULL');
  end if;
  if p_mode='own_key' then reserved := 0; end if;
  if account_balance<reserved then
    return jsonb_build_object('ok',false,'code','CREDITS_INSUFFICIENT','required',reserved,'balance',account_balance);
  end if;
  if reserved>0 then
    update public.credit_accounts set balance=balance-reserved,updated_at=now() where user_id=p_user_id returning balance into account_balance;
  end if;
  insert into public.video_jobs(user_id,owner_scope,request_id,billing_mode,operation,model,request_fingerprint,billing_status,resolution,
    requested_duration,reference_duration_ms,unit_credit_cost,estimated_credits,reserved_credits,reference_metadata,history_prompt,history_parameters,history_created_at,pricing_profile)
  values(p_user_id,p_owner,p_request_id,p_mode,p_operation,model_id,p_fingerprint,case when reserved>0 then 'reserved' else 'not_applicable' end,res,
    output_seconds,video_ms,0,estimated,reserved,p_references,coalesce(p_parameters->>'prompt',''),
    case when p_operation='generate' then p_parameters end,case when p_operation='generate' then now() end,profile)
  returning * into job;
  if reserved>0 then
    insert into public.credit_transactions(user_id,video_job_id,type,delta,idempotency_key,metadata)
    values(p_user_id,job.id,'reserve',-reserved,'video-reserve:'||job.id::text,jsonb_build_object('media_type','video','model',model_id,'pricing_profile',profile));
  end if;
  return jsonb_build_object('ok',true,'existing',false,'job',to_jsonb(job),'balance',account_balance);
end;
$$;

create function public.begin_seedance25_flash_job(p_owner text,p_user_id uuid,p_request_id uuid,p_mode text,
  p_operation text,p_fingerprint text,p_parameters jsonb,p_references jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select private.begin_seedance25_flash_job(p_owner,p_user_id,p_request_id,p_mode,p_operation,p_fingerprint,p_parameters,p_references);
$$;
revoke all on function private.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb),
  public.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb),
  public.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb) to service_role;

-- The settlement already uses each job's immutable pricing snapshot. Extend only its model guard
-- and the admin billing label, preserving the installed function bodies and grants.
do $$
declare
  signature regprocedure;
  original text;
  expected text;
  replacement text;
begin
  for signature,expected,replacement in values
    ('private.apply_seedance25_job(text,uuid,text,text,text,jsonb,numeric,bigint)'::regprocedure,
     $old$j.model<>'seedance-2.5'$old$, $new$j.model not in ('seedance-2.5','seedance-2-5-flash')$new$),
    ('private.get_admin_music_overview(date,date,text,integer)'::regprocedure,
     $old$case when v.model in ('seedance-2.5',$old$, $new$case when v.model in ('seedance-2.5','seedance-2-5-flash',$new$)
  loop
    original := pg_get_functiondef(signature);
    if cardinality(string_to_array(original,expected))<>2 then
      raise exception 'Unexpected function definition for %',signature;
    end if;
    execute replace(original,expected,replacement);
  end loop;
end;
$$;
