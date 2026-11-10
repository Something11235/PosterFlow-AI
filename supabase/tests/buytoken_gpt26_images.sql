-- In-memory/local regression fixture only. Never run against user data.
begin;
do $$
declare
  uid uuid := '68686868-6868-4868-8868-686868686868';
  owner text := 'user-68686868-6868-4868-8868-686868686868';
  rid uuid := '68686868-6868-4868-8868-686868686861';
  tok uuid := '68686868-6868-4868-8868-686868686862';
  j jsonb; r jsonb; b numeric; tx integer; f record;
begin
  insert into auth.users(id,email,email_confirmed_at) values(uid,'buytoken-fixture@example.invalid',now());
  perform public.ensure_signup_bonus(uid);
  update public.credit_accounts set balance=100 where user_id=uid;
  r:=public.begin_buytoken_gpt26_image_job(owner,uid,rid,'platform','gpt-image-2.6-flare',4,repeat('b',64),'fixture',2,'1K');
  assert (r->>'ok')::boolean;
  j:=r->'job';
  assert (j->>'unit_credit_cost')::numeric=1.5;
  assert j->>'submission_provider'='buytoken';
  assert j->>'provider_task_id' is null;
  assert (r->>'balance')::numeric=94;
  assert (select provider='api.buytoken.work' from public.generation_jobs where id=(j->>'generation_job_id')::uuid);
  select count(*) into tx from public.credit_transactions;
  r:=public.begin_buytoken_gpt26_image_job(owner,uid,rid,'platform','gpt-image-2.6-flare',4,repeat('b',64),'fixture',2,'1K');
  assert (r->>'existing')::boolean;
  assert (select count(*) from public.credit_transactions)=tx;
  r:=public.begin_buytoken_gpt26_image_job(owner,uid,rid,'platform','gpt-image-2.6-sunburst',4,repeat('b',64),'fixture',2,'1K');
  assert r->>'code'='IMAGE_REQUEST_CONFLICT';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'sending');
  assert (r->>'send')::boolean;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'sending');
  assert not (r->>'send')::boolean;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'unknown',p_error:='IMAGE_SUBMISSION_UNKNOWN');
  assert r->'job'->>'status'='submission_unknown';
  assert (r->>'balance')::numeric=94;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'sending');
  assert not (r->>'send')::boolean;
  r:=public.apply_buytoken_gpt26_image_job('someone-else',rid,'claim',p_token:=tok);
  assert r->>'code'='IMAGE_TASK_NOT_FOUND';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'claim',p_token:=tok);
  assert not (r->>'claimed')::boolean;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'received','["http://127.0.0.1/x"]');
  assert r->>'code'='INVALID_IMAGE_TASK';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'received','["https://result.example.invalid/one","https://result.example.invalid/two"]');
  assert (r->>'ok')::boolean;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'received','["https://result.example.invalid/different"]');
  assert r->>'code'='IMAGE_REQUEST_CONFLICT';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'failed',p_error:='late_failure');
  assert r->>'code'='IMAGE_RESULT_PENDING';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'claim',p_token:=tok);
  assert (r->>'claimed')::boolean;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'claim',p_token:=gen_random_uuid());
  assert not (r->>'claimed')::boolean;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'completed',p_images:='["one.png","two.gif"]',p_token:=gen_random_uuid());
  assert r->>'code'='IMAGE_SAVE_CONFLICT';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'retry',p_token:=tok,p_error:='IMAGE_SAVE_PENDING');
  assert jsonb_array_length(r->'job'->'provider_result_urls')=2;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'claim',p_token:=tok);
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'completed',p_images:='["one.png"]',p_token:=tok);
  assert r->>'code'='INVALID_IMAGE_TASK';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'completed',p_images:='["one.png","two.gif"]',p_token:=tok);
  assert r->'job'->>'status'='completed';
  assert (r->>'balance')::numeric=97; -- 2 saved outputs * 1.5
  assert (select charged_credits=3 from public.generation_jobs where id=(j->>'generation_job_id')::uuid);
  select count(*) into tx from public.credit_transactions;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'completed',p_images:='["one.png","two.gif"]',p_token:=tok);
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'failed');
  assert (select balance=97 from public.credit_accounts where user_id=uid);
  assert (select count(*) from public.credit_transactions)=tx;

  rid:='68686868-6868-4868-8868-686868686863';
  r:=public.begin_buytoken_gpt26_image_job(owner,uid,rid,'platform','gpt-image-2.6-sunburst',1,repeat('c',64),'fixture',0,'1K');
  assert (r->'job'->>'unit_credit_cost')::numeric=1;
  assert (r->>'balance')::numeric=96;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'sending');
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'failed',p_error:='BUYTOKEN_REQUEST_REJECTED');
  assert (r->>'balance')::numeric=97;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'failed');
  assert (r->>'balance')::numeric=97;

  rid:='68686868-6868-4868-8868-686868686864';
  r:=public.begin_buytoken_gpt26_image_job(owner,uid,rid,'own_key','gpt-image-2.6-flare',4,repeat('c',64),'fixture',8,'1K');
  assert (r->'job'->>'unit_credit_cost')::numeric=0;
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'sending');
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'received','["https://result.example.invalid/one"]');
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'claim',p_token:=tok);
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'completed',p_images:='["one.gif"]',p_token:=tok);
  assert (r->>'balance')::numeric=97;

  -- Old in-flight APIMart jobs retain the original adapter and settlement.
  rid:='68686868-6868-4868-8868-686868686865';
  r:=public.begin_gpt26_image_job_v2(owner,uid,rid,'platform','gpt-image-2.6-flare',1,repeat('d',64),'legacy',1,'1K');
  assert r->'job'->>'submission_provider'='apimart';
  r:=public.begin_buytoken_gpt26_image_job(owner,uid,rid,'platform','gpt-image-2.6-flare',1,repeat('d',64),'legacy',1,'1K');
  assert r->>'code'='IMAGE_REQUEST_CONFLICT';
  r:=public.apply_buytoken_gpt26_image_job(owner,rid,'sending');
  assert r->>'code'='IMAGE_TASK_NOT_FOUND';
  r:=public.apply_image_job_v3(owner,rid,'submitted','task_legacy_fixture');
  r:=public.apply_image_job_v3(owner,rid,'claim',p_token:=tok);
  r:=public.apply_image_job_v3(owner,rid,'completed',p_images:='["legacy.png"]',p_token:=tok);
  assert (r->>'balance')::numeric=95.5;

  r:=public.begin_buytoken_gpt26_image_job(owner,uid,gen_random_uuid(),'platform','gpt-image-2.6-flare',5,repeat('e',64),'invalid',0,'1K');
  assert r->>'code'='INVALID_IMAGE_TASK';
  r:=public.begin_buytoken_gpt26_image_job('wrong-owner',uid,gen_random_uuid(),'platform','gpt-image-2.6-flare',1,repeat('e',64),'invalid',0,'1K');
  assert r->>'code'='INVALID_IMAGE_TASK';
  for f in select p.oid,p.prosecdef,n.nspname,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('begin_buytoken_gpt26_image_job','apply_buytoken_gpt26_image_job') loop
    assert not has_function_privilege('anon',f.oid,'EXECUTE');
    assert not has_function_privilege('authenticated',f.oid,'EXECUTE');
    assert has_function_privilege('service_role',f.oid,'EXECUTE');
    assert f.prosecdef=(f.nspname='private');
    assert f.proconfig @> array['search_path=""'];
  end loop;
  assert (select relrowsecurity from pg_class where oid='public.apimart_image_jobs'::regclass);
  assert not has_table_privilege('anon','public.apimart_image_jobs','SELECT');
  assert not has_table_privilege('authenticated','public.apimart_image_jobs','SELECT');
end;
$$;
rollback;
