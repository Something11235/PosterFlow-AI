begin;
insert into auth.users(id,email,email_confirmed_at)
values('ff250000-0000-4000-8000-000000000001','flash-pricing@example.invalid',now());
select public.ensure_signup_bonus('ff250000-0000-4000-8000-000000000001');
update public.credit_accounts set balance=200 where user_id='ff250000-0000-4000-8000-000000000001';

do $$
declare
  u uuid := 'ff250000-0000-4000-8000-000000000001';
  o text := 'user-'||u::text;
  own text := o||'-'||repeat('e',64);
  rid uuid;
  fingerprint text := repeat('a',64);
  params jsonb := '{"model":"seedance-2-5-flash","prompt":"fixture","resolution":"480p","duration":5}';
  refs jsonb := '[{"id":"source","kind":"video","duration_ms":3250},{"id":"audio","kind":"audio","duration_ms":5000}]';
  item record;
  r jsonb;
  invalid jsonb;
begin
  -- Expected values derived independently from APIMart's Gold prices in USD/second.
  for item in select * from (values
    ('480p',5,'[]'::jsonb,7,11.5), ('720p',5,'[]'::jsonb,16,25.5),
    ('480p',5,refs,7.5,11.5), ('720p',5,refs,16,25.5),
    ('720p',-1,refs,64,102)
  ) as cases(res,seconds,media,estimated,reserved)
  loop
    rid := gen_random_uuid();
    r := public.begin_seedance25_flash_job(o,u,rid,'platform','generate',fingerprint,
      params||jsonb_build_object('resolution',item.res,'duration',item.seconds),item.media);
    assert (r->>'ok')::boolean and (r#>>'{job,estimated_credits}')::numeric=item.estimated,r::text;
    assert (r#>>'{job,reserved_credits}')::numeric=item.reserved,r::text;
    assert r#>>'{job,pricing_profile,version}'='seedance25-flash-gold-half-v1';
    r := public.apply_seedance25_job(o,rid,'submission_unknown');
    assert r#>>'{job,billing_status}'='reserved';
    r := public.apply_seedance25_job(o,rid,'failed');
    r := public.apply_seedance25_job(o,rid,'failed');
    assert r#>>'{job,billing_status}'='refunded' and (select balance from public.credit_accounts where user_id=u)=200;
  end loop;

  for invalid in select value from jsonb_array_elements('[{"resolution":"1080p"},{"duration":31},{"draft":true},{"model":"seedance-2.5"}]') loop
    r := public.begin_seedance25_flash_job(o,u,gen_random_uuid(),'platform','generate',fingerprint,params||invalid,'[]');
    assert r->>'code'='INVALID_VIDEO_INPUT',r::text;
  end loop;
  r := public.begin_seedance25_flash_job(o,u,gen_random_uuid(),'platform','generate',fingerprint,params,
    '[{"id":"source","kind":"video","duration_ms":0}]');
  assert r->>'code'='VIDEO_REFERENCE_DURATION';
  r := public.begin_seedance25_flash_job(o,u,gen_random_uuid(),'platform','generate',fingerprint,params,
    '[{"id":"source","kind":"video","duration_ms":29000},{"id":"source2","kind":"video","duration_ms":2000}]');
  assert r->>'code'='VIDEO_REFERENCE_DURATION';

  rid := gen_random_uuid();
  r := public.begin_seedance25_flash_job(o,u,rid,'platform','generate',fingerprint,params,'[]');
  r := public.begin_seedance25_flash_job(o,u,rid,'platform','generate',fingerprint,params,'[]');
  assert (r->>'existing')::boolean and (select balance from public.credit_accounts where user_id=u)=188.5;
  r := public.begin_seedance25_flash_job(o,u,rid,'platform','generate',repeat('b',64),params,'[]');
  assert r->>'code'='VIDEO_REQUEST_CONFLICT';
  r := public.apply_seedance25_job(o,rid,'completed');
  assert r#>>'{job,billing_status}'='awaiting_provider';
  r := public.apply_seedance25_job(o,rid,'completed',null,null,'[]',0.48,74000);
  assert r#>>'{job,billing_status}'='settled' and (r#>>'{job,charged_credits}')::numeric=11;
  r := public.apply_seedance25_job(o,rid,'completed',null,null,'[]',9);
  assert (select balance from public.credit_accounts where user_id=u)=189;
  assert exists(select 1 from jsonb_array_elements(private.get_admin_music_overview(
    current_date-1,current_date+1,'flash-pricing@example.invalid',100)->'video_jobs') j
    where j->>'request_id'=rid::text and j->>'billing_unit'='actual_cost');
  rid := gen_random_uuid();
  r := public.begin_seedance25_flash_job(own,u,rid,'own_key','generate',fingerprint,params,'[]');
  assert (r#>>'{job,reserved_credits}')::numeric=0;
  r := public.apply_seedance25_job(own,rid,'completed');
  assert r#>>'{job,billing_status}'='not_applicable' and (r#>>'{job,charged_credits}')::numeric=0;

  rid := gen_random_uuid();
  r := public.begin_seedance25_flash_job(o,u,rid,'platform','asset_review',fingerprint,
    '{"model":"seedance-2-5-flash"}','[{"id":"example","kind":"image"}]');
  assert (r->>'ok')::boolean and r#>>'{job,billing_status}'='not_applicable';
  r := public.apply_seedance25_job(o,rid,'completed',null,null,'[{"status":"Active","asset_url":"asset://reviewed_image"}]');
  assert r#>>'{job,status}'='completed' and r#>>'{job,asset_results,0,id}'='example';
  assert (select balance from public.credit_accounts where user_id=u)=189;
  assert not has_function_privilege('anon','public.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb)','execute');
  assert not has_function_privilege('authenticated','private.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb)','execute');
  assert has_function_privilege('service_role','public.begin_seedance25_flash_job(text,uuid,uuid,text,text,text,jsonb,jsonb)','execute');
end;
$$;
rollback;
