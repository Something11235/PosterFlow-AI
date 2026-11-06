-- Isolated synthetic fixtures only. Never execute on a cloud database.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('61616161-6161-4161-8161-616161616161','draft-contract@example.invalid',now()),
 ('62626262-6262-4262-8262-626262626262','other-draft-contract@example.invalid',now());
select public.ensure_signup_bonus('61616161-6161-4161-8161-616161616161');
select public.ensure_signup_bonus('62626262-6262-4262-8262-626262626262');
update public.credit_accounts set balance=10000 where user_id in ('61616161-6161-4161-8161-616161616161','62626262-6262-4262-8262-626262626262');
create function pg_temp.start_draft25(rid uuid,p jsonb,refs jsonb default '[]',own boolean default false) returns jsonb language sql as $$
 select public.begin_seedance25_job_v2('user-61616161-6161-4161-8161-616161616161'||case when own then '-'||repeat('f',64) else '' end,
 '61616161-6161-4161-8161-616161616161',rid,case when own then 'own_key' else 'platform' end,'generate',repeat('a',64),p,refs);
$$;
do $$
declare u uuid:='61616161-6161-4161-8161-616161616161';o text:='user-'||u::text;
 draft uuid:=gen_random_uuid();rid uuid;own_draft uuid;before_balance numeric;before_jobs integer;before_ledger integer;r jsonb;p jsonb;
 refs jsonb:='[{"id":"original-video","kind":"video","duration_ms":22000,"width":854,"height":480,"fps":30,"codec":"avc1","size":3000}]';
 params jsonb:='{"model":"seedance-2.5","prompt":"synthetic contract","resolution":"480p","duration":11,"size":"adaptive","draft":true,"omni_reference_task_type":"reference"}';
begin
 r:=pg_temp.start_draft25(draft,params,refs);assert (r->>'ok')::boolean,r::text;
 perform public.apply_seedance25_job(o,draft,'submitted','task_draft_contract_fixture_001');
 r:=public.apply_seedance25_job(o,draft,'completed',null,null,'[]',1,1000);assert r#>>'{job,billing_status}'='settled';
 p:=jsonb_build_object('model','seedance-2.5','resolution','1080p','draft_request_id',draft);
 select balance into before_balance from public.credit_accounts where user_id=u;
 rid:=gen_random_uuid();r:=pg_temp.start_draft25(rid,p);assert (r->>'ok')::boolean,r::text;
 assert (r#>>'{job,requested_duration}')::integer=11 and (r#>>'{job,reference_duration_ms}')::integer=22000;
 assert (r#>>'{job,estimated_credits}')::numeric=233 and (r#>>'{job,reserved_credits}')::numeric=373,r::text;
 assert r#>>'{job,pricing_profile,markup}'='1.2' and r#>>'{job,pricing_profile,version}'='seedance25-draft3d-original-input-half-v3';
 assert r#>>'{job,reference_metadata}'='[]';
 assert (select balance from public.credit_accounts where user_id=u)=before_balance-373;
 r:=pg_temp.start_draft25(rid,p);assert (r->>'existing')::boolean;
 assert (select balance from public.credit_accounts where user_id=u)=before_balance-373;
 -- No recharging/repricing existing intents, even after their source expires.
 update public.video_jobs set created_at=statement_timestamp()-interval '4 days' where request_id=draft;
 r:=pg_temp.start_draft25(rid,p);assert (r->>'existing')::boolean;
 r:=public.apply_seedance25_job(o,rid,'completed',null,null,'[]',1,1000);
 assert (r#>>'{job,charged_credits}')::numeric=22.5;
 assert (select balance from public.credit_accounts where user_id=u)=before_balance-22.5;
 perform public.apply_seedance25_job(o,rid,'completed',null,null,'[]',99,99000);
 assert (select balance from public.credit_accounts where user_id=u)=before_balance-22.5;
 select balance into before_balance from public.credit_accounts where user_id=u;
 select count(*) into before_jobs from public.video_jobs;select count(*) into before_ledger from public.credit_transactions;
 r:=pg_temp.start_draft25(gen_random_uuid(),p);assert r->>'code'='VIDEO_DRAFT_INVALID';
 update public.video_jobs set created_at=statement_timestamp()-interval '3 days' where request_id=draft;
 r:=pg_temp.start_draft25(gen_random_uuid(),p);assert r->>'code'='VIDEO_DRAFT_INVALID';
 assert (select count(*) from public.video_jobs)=before_jobs;
 assert (select count(*) from public.credit_transactions)=before_ledger;
 assert (select balance from public.credit_accounts where user_id=u)=before_balance;
 update public.video_jobs set created_at=statement_timestamp()-interval '3 days'+interval '1 millisecond' where request_id=draft;
 rid:=gen_random_uuid();r:=pg_temp.start_draft25(rid,p);assert (r->>'ok')::boolean,r::text;
 perform public.apply_seedance25_job(o,rid,'failed');perform public.apply_seedance25_job(o,rid,'failed');
 assert (select balance from public.credit_accounts where user_id=u)=before_balance;
 -- Other owners, key namespaces, unfinished and malformed source choices cannot reserve.
 r:=public.begin_seedance25_job_v2('user-62626262-6262-4262-8262-626262626262','62626262-6262-4262-8262-626262626262',gen_random_uuid(),'platform','generate',repeat('a',64),p,'[]');
 assert r->>'code'='VIDEO_DRAFT_INVALID';
 r:=pg_temp.start_draft25(gen_random_uuid(),p,'[]',true);assert r->>'code'='VIDEO_DRAFT_INVALID';
 r:=pg_temp.start_draft25(gen_random_uuid(),p,refs);assert r->>'code'='VIDEO_DRAFT_INVALID';
 update public.video_jobs set status='processing' where request_id=draft;
 r:=pg_temp.start_draft25(gen_random_uuid(),p);assert r->>'code'='VIDEO_DRAFT_INVALID';
 update public.video_jobs set status='completed' where request_id=draft;
 -- Auto duration reserves output up to 30 seconds plus the ORIGINAL 22 seconds.
 update public.video_jobs set requested_duration=-1 where request_id=draft;
 rid:=gen_random_uuid();r:=pg_temp.start_draft25(rid,p);assert (r->>'ok')::boolean,r::text;
 assert (r#>>'{job,estimated_credits}')::numeric=367 and (r#>>'{job,reserved_credits}')::numeric=587.5;
 perform public.apply_seedance25_job(o,rid,'failed');
 -- Audio does not contribute input video seconds; no-input final prices stay unchanged.
 update public.video_jobs set requested_duration=5,reference_duration_ms=0 where request_id=draft;
 rid:=gen_random_uuid();r:=pg_temp.start_draft25(rid,p);
 assert (r#>>'{job,reserved_credits}')::numeric=95 and (r#>>'{job,estimated_credits}')::numeric=59.5;
 perform public.apply_seedance25_job(o,rid,'failed');
 -- Insufficient funds cannot create a free task or ledger entry.
 update public.video_jobs set requested_duration=11,reference_duration_ms=22000 where request_id=draft;
 update public.credit_accounts set balance=1 where user_id=u;
 select count(*) into before_jobs from public.video_jobs;select count(*) into before_ledger from public.credit_transactions;
 r:=pg_temp.start_draft25(gen_random_uuid(),p);assert r->>'code'='CREDITS_INSUFFICIENT' and (r->>'required')::numeric=373;
 assert (select count(*) from public.video_jobs)=before_jobs and (select count(*) from public.credit_transactions)=before_ledger;
 update public.credit_accounts set balance=before_balance where user_id=u;
 -- BYOK is owner-scoped and never changes website balances or ledger.
 own_draft:=gen_random_uuid();r:=pg_temp.start_draft25(own_draft,params,refs,true);assert (r->>'ok')::boolean,r::text;
 perform public.apply_seedance25_job(o||'-'||repeat('f',64),own_draft,'submitted','task_own_draft_contract_001');
 perform public.apply_seedance25_job(o||'-'||repeat('f',64),own_draft,'completed');
 select count(*) into before_ledger from public.credit_transactions;
 rid:=gen_random_uuid();r:=pg_temp.start_draft25(rid,jsonb_build_object('model','seedance-2.5','resolution','1080p','draft_request_id',own_draft),'[]',true);
 assert (r->>'ok')::boolean and (r#>>'{job,reserved_credits}')::numeric=0;
 assert (r#>>'{job,estimated_credits}')::numeric=233;
 perform public.apply_seedance25_job(o||'-'||repeat('f',64),rid,'completed');
 assert (select balance from public.credit_accounts where user_id=u)=before_balance;
 assert (select count(*) from public.credit_transactions)=before_ledger;
 -- Ordinary requests retain their original estimates and reservations.
 rid:=gen_random_uuid();r:=pg_temp.start_draft25(rid,params||'{"draft":false,"duration":5}');
 assert (r#>>'{job,estimated_credits}')::numeric=11 and (r#>>'{job,reserved_credits}')::numeric=17;
 perform public.apply_seedance25_job(o,rid,'failed');
 assert (select balance from public.credit_accounts where user_id=u)=before_balance;
 -- Asset review continues to reserve zero website credits.
 rid:=gen_random_uuid();r:=public.begin_seedance25_job_v2(o,u,rid,'platform','asset_review',repeat('b',64),'{"model":"seedance-2.5"}','[{"id":"source-image","kind":"image","width":512,"height":512}]');
 assert (r->>'ok')::boolean and (r#>>'{job,reserved_credits}')::numeric=0,r::text;
 perform public.apply_seedance25_job(o,rid,'failed');
 assert (select balance from public.credit_accounts where user_id=u)=before_balance;
 assert not has_function_privilege('anon','public.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb)','execute');
 assert not has_function_privilege('authenticated','private.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb)','execute');
 assert has_function_privilege('service_role','public.begin_seedance25_job_v2(text,uuid,uuid,text,text,text,jsonb,jsonb)','execute');
end;$$;
rollback;
