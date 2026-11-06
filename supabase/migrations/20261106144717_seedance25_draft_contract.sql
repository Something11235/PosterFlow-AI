-- New Seedance 2.5 requests only. Old RPCs and all existing pricing snapshots stay intact.
-- Final jobs inherit ORIGINAL input-video milliseconds; no duplicate media submission.
set local lock_timeout='5s';
CREATE FUNCTION private.begin_seedance25_job_v2(p_owner text, p_user_id uuid, p_request_id uuid, p_mode text, p_operation text, p_fingerprint text, p_parameters jsonb, p_references jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j public.video_jobs;s public.video_jobs;b numeric;res text;seconds integer:=0;ref_ms integer:=0;rate numeric:=0;
 estimate numeric:=0;reserve numeric:=0;final boolean:=false;v_draft boolean:=false;source_id uuid;prompt text:='';
begin
 if p_user_id is null or p_request_id is null or p_mode is null or p_mode not in ('platform','own_key')
  or p_owner is null or (p_mode='platform' and p_owner<>'user-'||p_user_id::text)
  or(p_mode='own_key' and p_owner !~ ('^user-'||p_user_id::text||'-[a-f0-9]{64}$'))
  or p_operation is null or p_operation not in ('generate','asset_review')
  or p_fingerprint is null or p_fingerprint !~ '^[a-f0-9]{64}$'
  or p_parameters is null or jsonb_typeof(p_parameters)<>'object' or p_parameters->>'model' is distinct from 'seedance-2.5'
  or p_parameters-array['model','prompt','duration','size','resolution','seed','generate_audio','return_last_frame','tools','nsfw_check',
       'draft','draft_request_id','output_format','watermark','omni_reference_task_type']<>'{}'::jsonb
  or p_references is null or jsonb_typeof(p_references)<>'array' or jsonb_array_length(p_references)>50 then
  return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');end if;
 if exists(select 1 from jsonb_array_elements(p_references) r where jsonb_typeof(r)<>'object'
   or r-array['id','kind','sha256','asset_url','role','duration_ms','width','height','fps','codec','size']<>'{}'::jsonb
   or r->>'kind' is null or r->>'kind' not in ('image','video','audio') or r->>'id' is null) then
  return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');end if;
 perform pg_advisory_xact_lock(hashtextextended(p_owner||':'||p_request_id::text,0));
 select * into j from public.video_jobs where owner_scope=p_owner and request_id=p_request_id for update;
 if found then
  if j.model<>'seedance-2.5' or j.operation<>p_operation or j.request_fingerprint<>p_fingerprint then return jsonb_build_object('ok',false,'code','VIDEO_REQUEST_CONFLICT');end if;
  return jsonb_build_object('ok',true,'existing',true,'job',to_jsonb(j));
 end if;
 if not exists(select 1 from auth.users where id=p_user_id and email_confirmed_at is not null) then return jsonb_build_object('ok',false,'code','EMAIL_UNVERIFIED');end if;
 if not exists(select 1 from public.profiles where id=p_user_id and status='active' and deleted_at is null) then return jsonb_build_object('ok',false,'code','ACCOUNT_FROZEN');end if;
 if p_operation='generate' then
  final:=p_parameters?'draft_request_id';res:=p_parameters->>'resolution';
  if res is null or res not in ('480p','720p','1080p') then return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');end if;
  if final then
   if p_parameters-array['model','draft_request_id','resolution','output_format','return_last_frame','watermark']<>'{}'::jsonb
    or res<>'1080p' or jsonb_array_length(p_references)<>0
    or coalesce(p_parameters->>'draft_request_id','') !~ '^[a-f0-9-]{36}$' then return jsonb_build_object('ok',false,'code','VIDEO_DRAFT_INVALID');end if;
   select * into s from public.video_jobs where owner_scope=p_owner and user_id=p_user_id and request_id=(p_parameters->>'draft_request_id')::uuid
    and model='seedance-2.5' and is_draft and status='completed' and billing_status in ('settled','not_applicable') and created_at>statement_timestamp()-interval '3 days' and coalesce(provider_task_id,'') ~ '^[A-Za-z0-9_-]{8,160}$';
   if not found then return jsonb_build_object('ok',false,'code','VIDEO_DRAFT_INVALID');end if;
   seconds:=s.requested_duration;source_id:=s.id;prompt:=s.history_prompt;
   -- The original draft's input videos remain billable for the final task.
   -- Do not count the generated draft itself as another input video.
   ref_ms:=s.reference_duration_ms;
   if ref_ms is null or ref_ms<0 or ref_ms>30000 then return jsonb_build_object('ok',false,'code','VIDEO_DRAFT_INVALID');end if;
  else
   if coalesce(p_parameters->>'duration','') !~ '^(-1|[4-9]|[12][0-9]|30)$'
    or jsonb_typeof(p_parameters->'prompt') is distinct from 'string' or char_length(p_parameters->>'prompt') not between 1 and 32000
    or (p_parameters->>'draft') not in ('true','false') then return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');end if;
   seconds:=(p_parameters->>'duration')::integer;prompt:=p_parameters->>'prompt';v_draft:=(p_parameters->>'draft')::boolean;
   if v_draft and res<>'480p' then return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');end if;
   if exists(select 1 from jsonb_array_elements(p_references) r where r->>'kind' in ('video','audio') and coalesce(r->>'duration_ms','') !~ '^[0-9]{1,5}$') then return jsonb_build_object('ok',false,'code','VIDEO_REFERENCE_DURATION');end if;
   select coalesce(sum((r->>'duration_ms')::integer),0) into ref_ms from jsonb_array_elements(p_references) r where r->>'kind'='video';
   if ref_ms>30000 then return jsonb_build_object('ok',false,'code','VIDEO_REFERENCE_DURATION');end if;
  end if;
  rate:=case res when '480p' then case when ref_ms>0 then 0.0576 else 0.09608 end
    when '720p' then case when ref_ms>0 then 0.1296 else 0.216 end
    else case when ref_ms>0 then 0.3192 else 0.5346 end end;
  estimate:=private.seedance25_charge((case when seconds=-1 then 30 else seconds end+ref_ms/1000.0)*rate);
  reserve:=private.seedance25_charge((case when seconds=-1 then 30 else seconds end+ref_ms/1000.0)*rate*1.6);
 elsif p_parameters<>'{"model":"seedance-2.5"}'::jsonb or jsonb_array_length(p_references)<>1 then return jsonb_build_object('ok',false,'code','INVALID_VIDEO_INPUT');
 end if;
 select balance into b from public.credit_accounts where user_id=p_user_id for update;
 if not found then return jsonb_build_object('ok',false,'code','AUTH_REQUIRED');end if;
 if p_mode='platform' and exists(select 1 from public.video_jobs where user_id=p_user_id and billing_status='awaiting_balance') then return jsonb_build_object('ok',false,'code','VIDEO_UNSETTLED_BALANCE');end if;
 if (select count(*) from public.video_jobs where user_id=p_user_id and operation=p_operation and status not in ('completed','failed'))>=3 then return jsonb_build_object('ok',false,'code','VIDEO_QUEUE_FULL');end if;
 if p_mode='platform' and b<reserve then return jsonb_build_object('ok',false,'code','CREDITS_INSUFFICIENT','required',reserve,'balance',b);end if;
 if p_mode='platform' and reserve>0 then update public.credit_accounts set balance=balance-reserve,updated_at=now() where user_id=p_user_id returning balance into b;end if;
 insert into public.video_jobs(user_id,owner_scope,request_id,billing_mode,operation,model,request_fingerprint,billing_status,resolution,
  requested_duration,reference_duration_ms,unit_credit_cost,estimated_credits,reserved_credits,reference_metadata,history_prompt,history_parameters,history_created_at,
  is_draft,draft_source_id,pricing_profile)
 values(p_user_id,p_owner,p_request_id,p_mode,p_operation,'seedance-2.5',p_fingerprint,case when p_mode='platform' and reserve>0 then 'reserved' else 'not_applicable' end,res,
  seconds,ref_ms,0,estimate,case when p_mode='platform' then reserve else 0 end,p_references,prompt,case when p_operation='generate' then p_parameters else null end,
  case when p_operation='generate' then now() else null end,v_draft,source_id,'{"version":"seedance25-draft3d-original-input-half-v3","usd_cny":"7","credit_cny":"0.38","markup":"1.2"}') returning * into j;
 if p_mode='platform' and reserve>0 then
  insert into public.credit_transactions(user_id,video_job_id,type,delta,idempotency_key,metadata)
  values(p_user_id,j.id,'reserve',-reserve,'video-reserve:'||j.id::text,jsonb_build_object('media_type','video','model',j.model,'pricing_profile',j.pricing_profile));
 end if;
 return jsonb_build_object('ok',true,'existing',false,'job',to_jsonb(j),'balance',b);
end;$function$
;
create function public.begin_seedance25_job_v2(p_owner text,p_user_id uuid,p_request_id uuid,p_mode text,p_operation text,p_fingerprint text,p_parameters jsonb,p_references jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select private.begin_seedance25_job_v2(p_owner,p_user_id,p_request_id,p_mode,p_operation,p_fingerprint,p_parameters,p_references);
$$;
revoke all on function private.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb),public.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function private.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb),public.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
