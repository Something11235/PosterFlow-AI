-- Extend only the temporary owner recovery copy; keep all billing and usage records.
-- Rollback must coordinate the previous API/UI version, finish_tavern_request
-- from 20261111131934, live expiry timestamps (-60h), and the cron job name.
set local lock_timeout = '5s';

create or replace function private.finish_tavern_request(p_user_id uuid,p_request_id uuid,p_outcome text,
  p_usage jsonb,p_response_text text,p_error_code text,p_actor_id uuid default null,p_reason text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.tavern_requests; b numeric; charge numeric; refund numeric; meta jsonb; u jsonb;
begin
  if p_user_id is null or p_request_id is null or p_outcome is null
     or p_outcome not in ('completed','not_submitted','rejected','unknown')
     or char_length(p_response_text)>65536
     or (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{1,100}$') then
    return jsonb_build_object('ok',false,'code','TAVERN_EVENT_INVALID'); end if;
  select balance into b from public.credit_accounts where user_id=p_user_id for update;
  if not found then return jsonb_build_object('ok',false,'code','TAVERN_NOT_FOUND'); end if;
  select * into j from public.tavern_requests where user_id=p_user_id and request_id=p_request_id for update;
  if not found then return jsonb_build_object('ok',false,'code','TAVERN_NOT_FOUND'); end if;
  -- Terminal accounting never repeats or changes, including a late failure event.
  if j.billing_status in ('settled','refunded') then
    return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text); end if;
  if p_actor_id is not null and j.status='reserved' and j.created_at > now()-interval '5 minutes' then
    return jsonb_build_object('ok',false,'code','TAVERN_REVIEW_NOT_READY'); end if;
  -- Only an explicitly authorized administrator can change a completed review.
  if j.billing_status='awaiting_review' and p_actor_id is null
     and not (p_outcome='completed' and private.quote_tavern_credits(j.model,p_usage) is not null
       and private.quote_tavern_credits(j.model,p_usage)<=j.reserved_credits) then
    return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text); end if;
  meta := jsonb_build_object('media_type','tavern','kind',j.kind,'request_id',j.request_id,
    'model',j.model,'pricing_version',j.pricing_version,'reserved_credits',j.reserved_credits::text);
  if p_actor_id is not null then
    if not exists(select 1 from public.profiles p join auth.users a on a.id=p.id
      where p.id=p_actor_id and p.role='admin' and p.status='active' and p.deleted_at is null
        and a.email_confirmed_at is not null) then
      return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED'); end if;
    meta := meta || jsonb_build_object('admin_user_id',p_actor_id,'reason',p_reason);
  end if;
  if p_outcome='completed' then
    u := private.tavern_usage(p_usage);
    charge := private.quote_tavern_credits(j.model,p_usage);
    if charge is null or charge > j.reserved_credits then
      if p_actor_id is not null then return jsonb_build_object('ok',false,'code','TAVERN_USAGE_UNSETTLEABLE'); end if;
      update public.tavern_requests set status='completed',billing_status='awaiting_review',usage=u,
        response_text=p_response_text,response_expires_at=case when p_response_text is not null then now()+interval '72 hours' end,
        error_code=case when charge is null then 'TAVERN_USAGE_UNCONFIRMED' else 'TAVERN_RESERVE_EXCEEDED' end,
        updated_at=now() where id=j.id returning * into j;
      return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text);
    end if;
    refund := j.reserved_credits-charge;
    update public.credit_accounts set balance=balance+refund,total_spent=total_spent+charge,
      total_refunded=total_refunded+refund,updated_at=now() where user_id=p_user_id returning balance into b;
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(p_user_id,'spend',0,'tavern-spend:'||j.id::text,meta||jsonb_build_object('charged_credits',charge::text,'usage',u));
    if refund>0 then
      insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
        values(p_user_id,'refund',refund,'tavern-refund:'||j.id::text,meta||jsonb_build_object('reason',coalesce(p_reason,'unused_reservation')));
    end if;
    update public.tavern_requests set status='completed',billing_status='settled',charged_credits=charge,usage=u,
      response_text=case when p_actor_id is null then p_response_text else response_text end,
      response_expires_at=case when p_actor_id is null and p_response_text is not null then now()+interval '72 hours' else response_expires_at end,
      error_code=null,settled_at=now(),updated_at=now(),
      review_resolution=case when p_actor_id is not null then jsonb_build_object('actor_id',p_actor_id,'action','settle','reason',p_reason,'resolved_at',now()) end
      where id=j.id returning * into j;
  elsif p_outcome in ('not_submitted','rejected') then
    update public.credit_accounts set balance=balance+j.reserved_credits,total_refunded=total_refunded+j.reserved_credits,
      updated_at=now() where user_id=p_user_id returning balance into b;
    insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
      values(p_user_id,'refund',j.reserved_credits,'tavern-refund:'||j.id::text,
        meta||jsonb_build_object('reason',coalesce(p_reason,p_outcome)));
    update public.tavern_requests set status=case when status='completed' then status else 'failed' end,
      billing_status='refunded',charged_credits=0,error_code=p_error_code,settled_at=now(),updated_at=now(),
      review_resolution=case when p_actor_id is not null then jsonb_build_object('actor_id',p_actor_id,'action','refund','reason',p_reason,'resolved_at',now()) end
      where id=j.id returning * into j;
  else
    update public.tavern_requests set status='unknown',error_code=p_error_code,updated_at=now()
      where id=j.id returning * into j;
  end if;
  return jsonb_build_object('ok',true,'request',private.tavern_request_view(j),'balance',b::text);
end; $$;

-- One-time extension of still-live replies written under the previous 12h policy.
-- Anchor to the original write's expiry, not deployment time; NULL/expired text
-- is never resurrected. No amounts, usage, state or accounting timestamps change.
update public.tavern_requests
set response_expires_at = response_expires_at + interval '60 hours'
where response_text is not null
  and response_expires_at > now()
  and response_expires_at <= now() + interval '12 hours';

comment on column public.tavern_requests.response_text is
  'Temporary owner-only reply recovery; expires 72 hours after storage. Financial records remain.';

-- Expiry-aware reads stay authoritative even if the hourly cleanup is delayed.
-- Replace the legacy name without creating two scheduled prune jobs.
do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    if to_regprocedure('cron.unschedule(text)') is not null
       and exists(select 1 from cron.job where jobname='posterflow-tavern-response-retention-12h') then
      perform cron.unschedule('posterflow-tavern-response-retention-12h');
    end if;
    perform cron.schedule('posterflow-tavern-response-retention-72h','7 * * * *','select private.prune_tavern_responses();');
  end if;
end; $$;
