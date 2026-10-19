-- Regression checks use temporary tables and copied functions only.
-- No real account, job, image provider or credit transaction is touched.
begin;
set local statement_timeout = '15s';

create temporary table profiles (like public.profiles including all);
create temporary table credit_accounts (like public.credit_accounts including all);
create temporary table generation_jobs (like public.generation_jobs including all);
create temporary table credit_transactions (like public.credit_transactions including all);
create temporary table auth_users (id uuid primary key, email_confirmed_at timestamptz);

create function pg_temp.ensure_signup_bonus(uuid) returns void
language plpgsql as $$ begin return; end; $$;

-- BEGIN LOAD FUNCTIONS
do $load$
declare
  v_signature text;
  v_definition text;
begin
  foreach v_signature in array array[
    'public.reserve_platform_credits(uuid,uuid,integer,text,text,text,integer,integer)',
    'public.settle_generation(uuid,integer,integer,jsonb)'
  ] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_definition := replace(v_definition, 'public.', 'pg_temp.');
    v_definition := replace(v_definition, 'auth.users', 'pg_temp.auth_users');
    execute v_definition;
  end loop;
end;
$load$;
-- END LOAD FUNCTIONS

do $tests$
declare
  v_user uuid := gen_random_uuid();
  v_low_balance_user uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_job uuid;
  v_legacy_job uuid;
  v_result jsonb;
  v_model text;
begin
  insert into pg_temp.profiles(id, username) values
    (v_user, 'synthetic-price-test'), (v_low_balance_user, 'synthetic-low-balance');
  insert into pg_temp.auth_users values (v_user, now()), (v_low_balance_user, now());
  insert into pg_temp.credit_accounts(user_id, balance) values (v_user, 10), (v_low_balance_user, 1);

  -- Four new Sunburst images reserve four credits rather than eight.
  v_result := pg_temp.reserve_platform_credits(v_user, v_request, 4, 'synthetic-provider', 'gpt-image-2.5-sunburst', 'synthetic test', null, null);
  if v_result->>'ok' is distinct from 'true' or (v_result->>'reserved')::integer is distinct from 4 or (v_result->>'balance')::integer is distinct from 6 then
    raise exception 'Sunburst must reserve one credit per requested image';
  end if;
  v_job := (v_result->>'job_id')::uuid;
  if (select (metadata->>'model_cost')::integer from pg_temp.generation_jobs where id=v_job) is distinct from 1 then
    raise exception 'New Sunburst reservation must capture a one-credit price';
  end if;

  -- A repeated request must not reserve again.
  v_result := pg_temp.reserve_platform_credits(v_user, v_request, 4, 'synthetic-provider', 'gpt-image-2.5-sunburst', 'synthetic test', null, null);
  if v_result->>'existing' is distinct from 'true' or (v_result->>'balance')::integer is distinct from 6 then
    raise exception 'Reservation idempotency changed';
  end if;

  -- Partial success charges the two actual images and refunds the other two.
  v_result := pg_temp.settle_generation(v_job, 2, 1, '["synthetic-1.png", "synthetic-2.png"]');
  if (v_result->>'charged')::integer is distinct from 2 or (v_result->>'refunded')::integer is distinct from 2 or (v_result->>'balance')::integer is distinct from 8 then
    raise exception 'Partial result settlement must use the reserved one-credit price';
  end if;
  v_result := pg_temp.settle_generation(v_job, 4, 1, '[]');
  if v_result->>'existing' is distinct from 'true' or (v_result->>'balance')::integer is distinct from 8 then
    raise exception 'Settlement idempotency changed';
  end if;

  -- Empty output returns every reserved credit.
  v_result := pg_temp.reserve_platform_credits(v_user, gen_random_uuid(), 2, 'synthetic-provider', 'gpt-image-2.5-sunburst', '', null, null);
  v_result := pg_temp.settle_generation((v_result->>'job_id')::uuid, 0, 1, '[]');
  if (v_result->>'charged')::integer is distinct from 0 or (v_result->>'refunded')::integer is distinct from 2 or (v_result->>'balance')::integer is distinct from 8 then
    raise exception 'Empty results must refund all reserved credits';
  end if;

  -- A one-credit account can now successfully reserve one Sunburst image.
  v_result := pg_temp.reserve_platform_credits(v_low_balance_user, gen_random_uuid(), 1, 'synthetic-provider', 'gpt-image-2.5-sunburst', '', null, null);
  if v_result->>'ok' is distinct from 'true' or (v_result->>'reserved')::integer is distinct from 1 then
    raise exception 'A one-credit account must be able to generate one Sunburst image';
  end if;
  v_result := pg_temp.settle_generation((v_result->>'job_id')::uuid, 1, 1, '["synthetic.png"]');
  if (v_result->>'charged')::integer is distinct from 1 or (v_result->>'balance')::integer is distinct from 0 then
    raise exception 'Single-image Sunburst settlement must charge exactly one credit';
  end if;
  v_result := pg_temp.reserve_platform_credits(v_low_balance_user, gen_random_uuid(), 1, 'synthetic-provider', 'gpt-image-2.5-sunburst', '', null, null);
  if v_result->>'code' is distinct from 'CREDITS_INSUFFICIENT' then
    raise exception 'Insufficient balance must still prevent generation';
  end if;

  -- An in-flight reservation made under the old two-credit price is preserved.
  insert into pg_temp.generation_jobs(user_id, request_id, billing_mode, provider, model, status, requested_count, reserved_credits, metadata)
  values(v_user, gen_random_uuid(), 'platform', 'synthetic-provider', 'gpt-image-2.5-sunburst', 'running', 4, 8, '{"model_cost":2}')
  returning id into v_legacy_job;
  update pg_temp.credit_accounts set balance=balance-8 where user_id=v_user;
  v_result := pg_temp.settle_generation(v_legacy_job, 2, 1, '["synthetic-old-1.png", "synthetic-old-2.png"]');
  if (v_result->>'charged')::integer is distinct from 4 or (v_result->>'refunded')::integer is distinct from 4 then
    raise exception 'Existing jobs must retain their original reserved price';
  end if;

  -- The other platform models retain their one-credit unit price.
  foreach v_model in array array['gpt-image-2.5-flare', 'gpt-image-2'] loop
    v_result := pg_temp.reserve_platform_credits(v_user, gen_random_uuid(), 1, 'synthetic-provider', v_model, '', null, null);
    if (v_result->>'reserved')::integer is distinct from 1 then
      raise exception 'Other platform model pricing changed';
    end if;
    v_result := pg_temp.settle_generation((v_result->>'job_id')::uuid, 1, 1, '["synthetic.png"]');
  end loop;
end;
$tests$;

rollback;
select 'passed' as sunburst_credit_regression, 'temporary fixtures rolled back; no real accounts changed' as isolation;
