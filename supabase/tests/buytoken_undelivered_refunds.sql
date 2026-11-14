-- Offline synthetic fixtures only. All account/job/ledger mutations roll back.
begin;
create temporary table undelivered_users (id uuid primary key);
create temporary table undelivered_fixtures (
  label text, user_id uuid, request_id uuid, generation_job_id uuid,
  eligible boolean not null
);

do $$
declare u uuid; users uuid[] := array[]::uuid[]; rid uuid; r jsonb;
        label text; i integer; gid uuid;
begin
  for i in 1..3 loop
    u := gen_random_uuid(); users := array_append(users,u);
    insert into auth.users(id,email,email_confirmed_at)
      values(u,'undelivered-'||u::text||'@example.invalid',now());
    perform public.ensure_signup_bonus(u);
    update public.credit_accounts set balance=1000,total_refunded=0 where user_id=u;
    insert into undelivered_users values(u);
  end loop;

  -- More than the 200-row cap, spread across accounts and all eligible states.
  for i in 1..207 loop
    u := users[1+(i%3)]; rid := gen_random_uuid();
    if i=207 then
      r := public.begin_buytoken_gpt26_image_job('user-'||u::text,u,rid,
        'platform','gpt-image-2.6-sunburst',1,repeat('a',64),'synthetic legacy fixture',2,'1K');
    else
      r := public.begin_buytoken_image_tier_job('user-'||u::text,u,rid,
        'platform','gpt-image-2.6-sunburst',1,repeat('a',64),'synthetic fixture',2,'1K');
    end if;
    assert (r->>'ok')::boolean, 'fixture reservation must succeed';
    gid := (r#>>'{job,generation_job_id}')::uuid;
    update public.apimart_image_jobs
      set status=case i%3 when 0 then 'submitting' when 1 then 'processing' else 'submission_unknown' end,
          created_at=now()-interval '10 minutes',
          error_code=case when i%3=2 then 'IMAGE_SUBMISSION_UNKNOWN' end
      where generation_job_id=gid;
    insert into undelivered_fixtures values('eligible-'||i,u,rid,gid,true);
  end loop;

  u := users[1];
  foreach label in array array['fresh','saving','active_lease','result_url',
    'image_key_a','image_key_g','generated','charged','settled_timestamp',
    'terminal_success','terminal_image_failed','byok','apimart','owner_mismatch',
    'user_mismatch','model_mismatch','billing_mismatch','missing_generation'] loop
    rid := gen_random_uuid();
    r := public.begin_buytoken_image_tier_job('user-'||u::text,u,rid,
      case when label='byok' then 'own_key' else 'platform' end,
      'gpt-image-2.6-sunburst',1,repeat('b',64),'synthetic excluded fixture',2,'1K');
    assert (r->>'ok')::boolean;
    gid := (r#>>'{job,generation_job_id}')::uuid;
    update public.apimart_image_jobs set status='processing',created_at=now()-interval '20 minutes'
      where generation_job_id=gid;
    case label
      when 'fresh' then update public.apimart_image_jobs set created_at=now()-interval '9 minutes 59 seconds' where generation_job_id=gid;
      when 'saving' then update public.apimart_image_jobs set status='saving',save_token=gen_random_uuid(),save_until=now()-interval '1 minute' where generation_job_id=gid;
      when 'active_lease' then update public.apimart_image_jobs set save_until=now()+interval '1 minute' where generation_job_id=gid;
      when 'result_url' then update public.apimart_image_jobs set provider_result_urls='["https://example.invalid/saved.png"]' where generation_job_id=gid;
      when 'image_key_a' then update public.apimart_image_jobs set image_keys='["synthetic.png"]' where generation_job_id=gid;
      when 'image_key_g' then update public.generation_jobs set image_keys='["synthetic.png"]' where id=gid;
      when 'generated' then update public.generation_jobs set generated_count=1 where id=gid;
      when 'charged' then update public.generation_jobs set charged_credits=0.5 where id=gid;
      when 'settled_timestamp' then update public.generation_jobs set settled_at=now() where id=gid;
      when 'terminal_success' then update public.generation_jobs set status='succeeded' where id=gid;
      when 'terminal_image_failed' then update public.apimart_image_jobs set status='failed' where generation_job_id=gid;
      when 'byok' then null;
      when 'apimart' then update public.apimart_image_jobs set submission_provider='apimart' where generation_job_id=gid;
      when 'owner_mismatch' then update public.apimart_image_jobs set owner_scope='user-'||users[2]::text where generation_job_id=gid;
      when 'user_mismatch' then update public.generation_jobs set user_id=users[2] where id=gid;
      when 'model_mismatch' then update public.generation_jobs set model='gpt-image-2.6-flare' where id=gid;
      when 'billing_mismatch' then update public.generation_jobs set billing_mode='own_key' where id=gid;
      when 'missing_generation' then update public.apimart_image_jobs set generation_job_id=null where generation_job_id=gid;
    end case;
    insert into undelivered_fixtures values(label,u,rid,gid,false);
  end loop;
end; $$;

create temporary table undelivered_accounts_before as
  select a.* from public.credit_accounts a join undelivered_users u on u.id=a.user_id;
create temporary table undelivered_excluded_jobs_before as
  select g.id,to_jsonb(g) as data from public.generation_jobs g
  join undelivered_fixtures f on f.generation_job_id=g.id where not f.eligible;
create temporary table undelivered_excluded_images_before as
  select a.id,to_jsonb(a) as data from public.apimart_image_jobs a
  join undelivered_fixtures f on f.request_id=a.request_id where not f.eligible;

do $$
declare r jsonb; target record; event text;
begin
  assert private.refund_stale_buytoken_images(0)->>'code'='INVALID_LIMIT';
  assert private.refund_stale_buytoken_images(201)->>'code'='INVALID_LIMIT';
  assert private.refund_stale_buytoken_images(null)->>'code'='INVALID_LIMIT';
  r := private.refund_stale_buytoken_images(1);
  assert (r->>'ok')::boolean and (r->>'refunded_count')::integer=1;
  assert (r->>'refunded_credits')::numeric=1.5;
  r := private.refund_stale_buytoken_images();
  assert (r->>'refunded_count')::integer=200, 'default cap must be 200';
  assert (r->>'refunded_credits')::numeric=300;
  r := private.refund_stale_buytoken_images();
  assert (r->>'refunded_count')::integer=6;
  assert (r->>'refunded_credits')::numeric=9;
  r := private.refund_stale_buytoken_images();
  assert (r->>'refunded_count')::integer=0 and (r->>'refunded_credits')::numeric=0,
    'repeat scheduled execution must not refund twice';

  assert not exists(select 1 from undelivered_fixtures f
    join public.generation_jobs g on g.id=f.generation_job_id
    join public.apimart_image_jobs a on a.generation_job_id=g.id
    where f.eligible and (g.status<>'refunded' or g.charged_credits<>0
      or a.status<>'failed' or a.error_code<>'IMAGE_UNDELIVERED_REFUNDED'));
  assert (select count(*) from public.credit_transactions t join undelivered_fixtures f
    on f.generation_job_id=t.job_id where f.eligible and t.type='refund')=207;
  assert (select sum(t.delta) from public.credit_transactions t join undelivered_fixtures f
    on f.generation_job_id=t.job_id where f.eligible and t.type='refund')=310.5;
  assert not exists(select 1 from public.credit_transactions t join undelivered_fixtures f
    on f.generation_job_id=t.job_id where f.eligible and t.type='refund'
    and (t.idempotency_key<>'refund:'||t.job_id::text
      or t.metadata->>'reason'<>'IMAGE_UNDELIVERED_REFUNDED'));
  assert not exists(select 1 from undelivered_accounts_before b
    join public.credit_accounts a on a.user_id=b.user_id
    where a.balance<>b.balance+103.5 or a.total_refunded<>b.total_refunded+103.5
      or a.total_spent<>b.total_spent), 'each owner receives only their own refunds';

  for target in select * from undelivered_fixtures where eligible loop
    foreach event in array array['failed','received','claim','completed','sending'] loop
      r := public.apply_buytoken_image_tier_job('user-'||target.user_id::text,
        target.request_id,event,'["https://example.invalid/late.png"]','["late.png"]',gen_random_uuid(),
        'IMAGE_UNDELIVERED_REFUNDED');
      assert (r->>'ok')::boolean and r#>>'{job,status}'='failed';
      assert (r->>'send')::boolean=false;
    end loop;
  end loop;
  assert not exists(select 1 from undelivered_accounts_before b
    join public.credit_accounts a on a.user_id=b.user_id
    where a.balance<>b.balance+103.5 or a.total_refunded<>b.total_refunded+103.5
      or a.total_spent<>b.total_spent), 'late callbacks never recharge refunded jobs';
  assert (select count(*) from public.credit_transactions t join undelivered_fixtures f
    on f.generation_job_id=t.job_id where f.eligible and t.type='refund')=207;
  assert not exists(select 1 from undelivered_excluded_jobs_before b
    join public.generation_jobs g on g.id=b.id where to_jsonb(g)<>b.data),
    'excluded billing rows stay untouched';
  assert not exists(select 1 from undelivered_excluded_images_before b
    join public.apimart_image_jobs a on a.id=b.id where to_jsonb(a)<>b.data),
    'excluded image rows stay untouched';
end; $$;

-- The scheduler's owner may execute; browser and application service roles may not.
do $$
declare role_name text; signature regprocedure := 'private.refund_stale_buytoken_images(integer)'::regprocedure;
begin
  foreach role_name in array array['anon','authenticated','service_role'] loop
    assert not has_function_privilege(role_name,signature,'execute');
  end loop;
  assert has_function_privilege('postgres',signature,'execute');
  assert (select prosecdef and 'search_path=""'=any(proconfig) from pg_proc where oid=signature);
  assert (select count(*) from cron.job where jobname='posterflow-buytoken-undelivered-refunds')=1;
  assert exists(select 1 from cron.job where jobname='posterflow-buytoken-undelivered-refunds'
    and schedule='* * * * *' and command='select private.refund_stale_buytoken_images(200);' and active);
end; $$;
rollback;
