-- User-approved no-delivery policy: release unresolved BuyToken image holds.
-- The API refunds confirmed error exits immediately. This job covers process
-- termination, missing error callbacks and existing unresolved submissions.
-- Ten minutes exceeds the five-minute function budget; known result URLs and
-- active saves are excluded. No provider POST or retry is ever performed here.
set local lock_timeout = '5s';

create function private.refund_stale_buytoken_images(p_limit integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j record; r jsonb; refunded_count integer := 0; refunded_credits numeric := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    return jsonb_build_object('ok',false,'code','INVALID_LIMIT');
  end if;
  for j in
    select a.owner_scope,a.request_id,a.generation_job_id,g.reserved_credits
    from public.apimart_image_jobs a
    join public.generation_jobs g on g.id=a.generation_job_id
    where a.submission_provider='buytoken' and a.billing_mode='platform'
      and a.model in ('gpt-image-2.6-flare','gpt-image-2.6-sunburst')
      and a.user_id is not null and a.owner_scope='user-'||a.user_id::text
      and g.user_id=a.user_id and g.billing_mode='platform' and g.model=a.model
      and a.status in ('submitting','processing','submission_unknown')
      and a.created_at <= now()-interval '10 minutes'
      and (a.save_until is null or a.save_until<=now())
      and jsonb_array_length(a.provider_result_urls)=0
      and jsonb_array_length(a.image_keys)=0
      and g.status in ('reserved','running') and g.generated_count=0
      and jsonb_array_length(g.image_keys)=0 and g.charged_credits=0
      and g.settled_at is null
    order by a.created_at,a.id
    limit p_limit
    for update of a,g skip locked
  loop
    r := private.apply_buytoken_image_tier_job(j.owner_scope,j.request_id,'failed',
      p_error => 'IMAGE_UNDELIVERED_REFUNDED');
    if not coalesce((r->>'ok')::boolean,false)
       or r#>>'{job,status}' is distinct from 'failed'
       or not exists(select 1 from public.generation_jobs g
                     where g.id=j.generation_job_id and g.status='refunded') then
      raise exception 'BuyToken undelivered refund was not confirmed';
    end if;
    refunded_count := refunded_count+1;
    refunded_credits := refunded_credits+j.reserved_credits;
  end loop;
  return jsonb_build_object('ok',true,'refunded_count',refunded_count,
    'refunded_credits',refunded_credits);
end; $$;
revoke all on function private.refund_stale_buytoken_images(integer)
  from public,anon,authenticated,service_role;

comment on function private.refund_stale_buytoken_images(integer) is
  'Owner-run scheduled refund of platform BuyToken requests with no delivered results after 10 minutes; provider costs are borne by the platform.';

do $$ begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    perform cron.schedule('posterflow-buytoken-undelivered-refunds','* * * * *',
      'select private.refund_stale_buytoken_images(200);');
  end if;
end; $$;
