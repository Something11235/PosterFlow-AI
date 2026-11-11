-- Only synthetic fixtures, every mutation rolled back. No model/network calls.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('ba000000-0000-4000-8000-000000000001','tavern-one@example.invalid',now()),
 ('ba000000-0000-4000-8000-000000000002','tavern-two@example.invalid',now()),
 ('ba000000-0000-4000-8000-000000000003','tavern-admin@example.invalid',now()),
 ('ba000000-0000-4000-8000-000000000004','tavern-unverified@example.invalid',null);
insert into public.profiles(id,username) select id,'tavern-'||right(id::text,12) from auth.users where id::text like 'ba000000-%'
 on conflict(id) do update set status='active',deleted_at=null;
insert into public.credit_accounts(user_id,balance) select id,10 from public.profiles where id::text like 'ba000000-%'
 on conflict(user_id) do update set balance=10,total_spent=0,total_refunded=0;
update public.profiles set role='admin' where id='ba000000-0000-4000-8000-000000000003';

do $$
declare u jsonb := '{"status":"confirmed","input_tokens":10000,"output_tokens":1000,"total_tokens":11000,"cache_read_tokens":0,"cache_miss_tokens":10000,"reasoning_tokens":0}'; v jsonb;
begin
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u)=0.0840;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_read_tokens":8000,"cache_miss_tokens":2000,"reasoning_tokens":500}')=0.0370;
 assert private.quote_tavern_credits('deepseek-v4.1-flash','{"status":"confirmed","input_tokens":1,"output_tokens":1,"total_tokens":2,"cache_read_tokens":0}')=0.0001;
 assert private.quote_tavern_credits('deepseek-v4.1-flash','{"status":"confirmed","input_tokens":0,"output_tokens":0,"total_tokens":0,"cache_read_tokens":0}')=0;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u-'cache_read_tokens') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"status":"partial"}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"total_tokens":11001}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_read_tokens":10001}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_miss_tokens":1}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"reasoning_tokens":1001}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"input_tokens":true}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"input_tokens":"10000"}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"input_tokens":-1}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"input_tokens":1.5}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"input_tokens":9007199254740992}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash','{"status":"confirmed","input_tokens":9007199254740991,"output_tokens":1,"total_tokens":9007199254740991,"cache_read_tokens":0}') is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash','{"status":"confirmed","input_tokens":9007199254740991,"output_tokens":0,"total_tokens":9007199254740991,"cache_read_tokens":0}') is null;
 assert private.quote_tavern_credits('wrong-model',u) is null;
 assert private.quote_tavern_credits('deepseek-v4.1-flash',null) is null;
 v:=private.tavern_usage(u||'{"api_key":"synthetic-do-not-store","prompt":"synthetic-do-not-store"}');
 assert not v ? 'api_key' and not v ? 'prompt';
end; $$;

set local role service_role;
do $$
declare a uuid:='ba000000-0000-4000-8000-000000000001'; b uuid:='ba000000-0000-4000-8000-000000000002';
 admin_id uuid:='ba000000-0000-4000-8000-000000000003'; unverified uuid:='ba000000-0000-4000-8000-000000000004';
 rid uuid:='bb000000-0000-4000-8000-000000000001'; rr uuid; r jsonb; original jsonb; n integer;
 usage jsonb:='{"status":"confirmed","input_tokens":10000,"output_tokens":1000,"total_tokens":11000,"cache_read_tokens":8000,"cache_miss_tokens":2000,"reasoning_tokens":500}';
begin
 assert public.tavern_billing_ready()->>'ready'='true';
 r:=public.begin_tavern_request(unverified,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'code'='EMAIL_UNVERIFIED';
 foreach n in array array[0,-1,100001] loop
  r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat',n);
  assert r->>'code'='TAVERN_INPUT_INVALID';
 end loop;
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat',0.00001);
 assert r->>'code'='TAVERN_INPUT_INVALID';
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat','NaN');
 assert r->>'code'='TAVERN_INPUT_INVALID';
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat','Infinity');
 assert r->>'code'='TAVERN_INPUT_INVALID';
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat',11);
 assert r->>'code'='INSUFFICIENT_CREDITS';
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'leader'='true' and r->>'balance'='9.0000' and r#>>'{request,reserved_credits}'='1.0000';
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'leader'='false' and r->>'balance'='9.0000';
 r:=public.begin_tavern_request(a,rid,repeat('b',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'code'='TAVERN_REQUEST_CONFLICT';
 r:=public.resolve_tavern_request(admin_id,a,rid,'refund',null,'synthetic active guard');
 assert r->>'code'='TAVERN_REVIEW_NOT_READY';
 assert jsonb_array_length(public.list_tavern_billing_reviews(admin_id)->'requests')=0;
 r:=public.apply_tavern_request(b,rid,'completed',usage,'other user must not see');
 assert r->>'code'='TAVERN_NOT_FOUND';
 assert jsonb_array_length(public.get_tavern_requests(b,rid)->'requests')=0;
 r:=public.apply_tavern_request(a,rid,'completed',usage||'{"secret":"synthetic"}','synthetic response');
 assert r#>>'{request,billing_status}'='settled' and r#>>'{request,charged_credits}'='0.0370' and r->>'balance'='9.9630';
 assert r#>>'{request,response_text}'='synthetic response' and not (r#>'{request,usage}') ? 'secret';
 original:=r;
 r:=public.apply_tavern_request(a,rid,'rejected',null,null,'LATE_FAILURE'); assert r=original;
 r:=public.apply_tavern_request(a,rid,'completed',usage,'overwritten response'); assert r=original;
 r:=public.resolve_tavern_request(admin_id,null,rid,'refund',null,'synthetic duplicate'); assert r=original;
 r:=public.begin_tavern_request(a,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'leader'='false' and r#>>'{request,billing_status}'='settled';
 assert public.get_tavern_requests(a,rid)#>>'{requests,0,response_text}'='synthetic response';
 assert public.list_tavern_billing_reviews(a)->>'code'='ADMIN_REQUIRED';
 assert public.resolve_tavern_request(a,a,rid,'refund',null,'synthetic unauthorized')->>'code'='ADMIN_REQUIRED';

 -- Missing cache is not zero cost. Completed response survives pending review.
 rr:='bb000000-0000-4000-8000-000000000002';
 perform public.begin_tavern_request(a,rr,repeat('b',64),'deepseek-v4.1-flash','summary',1);
 r:=public.apply_tavern_request(a,rr,'completed',usage-'cache_read_tokens','synthetic summary');
 assert r#>>'{request,billing_status}'='awaiting_review' and r#>'{request,charged_credits}'='null'::jsonb;
 assert r#>>'{request,response_text}'='synthetic summary';
 r:=public.begin_tavern_request(a,gen_random_uuid(),repeat('c',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'code'='TAVERN_REVIEW_REQUIRED';
 r:=public.apply_tavern_request(a,rr,'rejected');
 assert r#>>'{request,billing_status}'='awaiting_review';
 r:=public.resolve_tavern_request(admin_id,null,rr,'settle',usage,'synthetic provider verification');
 assert r#>>'{request,billing_status}'='settled' and r#>>'{request,charged_credits}'='0.0370';
 assert r#>>'{request,response_text}'='synthetic summary' and r#>>'{request,review_resolution,actor_id}'=admin_id::text;

 -- An actual charge above its reserve never causes extra debit or an automatic refund.
 rr:='bb000000-0000-4000-8000-000000000003';
 perform public.begin_tavern_request(a,rr,repeat('c',64),'deepseek-v4.1-flash','chat',0.0001);
 r:=public.apply_tavern_request(a,rr,'completed',usage,'synthetic expensive');
 assert r#>>'{request,error_code}'='TAVERN_RESERVE_EXCEEDED' and r#>>'{request,billing_status}'='awaiting_review';
 r:=public.resolve_tavern_request(admin_id,a,rr,'settle',usage,'synthetic cannot surcharge');
 assert r->>'code'='TAVERN_USAGE_UNSETTLEABLE';
 r:=public.resolve_tavern_request(admin_id,a,rr,'refund',null,'synthetic approved goodwill');
 assert r#>>'{request,billing_status}'='refunded' and r#>>'{request,charged_credits}'='0.0000';

 -- Unknown delivery holds its reservation. Three different pending jobs maximum.
 for n in 10..12 loop
  rr:=('bb000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=public.begin_tavern_request(a,rr,repeat('d',64),'deepseek-v4.1-flash','chat',1);
  assert r->>'leader'='true';
  r:=public.apply_tavern_request(a,rr,'unknown',null,null,'TAVERN_TIMEOUT');
  assert r#>>'{request,status}'='unknown' and r#>>'{request,billing_status}'='held';
 end loop;
 r:=public.begin_tavern_request(a,gen_random_uuid(),repeat('d',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'code'='TAVERN_PENDING_LIMIT';
 assert jsonb_array_length(public.list_tavern_billing_reviews(admin_id)->'requests')=3;
 for n in 10..12 loop
  rr:=('bb000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=public.resolve_tavern_request(admin_id,a,rr,'refund',null,'synthetic verified unused');
  assert r#>>'{request,billing_status}'='refunded';
 end loop;
 -- Two owners may have the same UUID, but only their own records are returned.
 perform public.begin_tavern_request(b,rid,repeat('e',64),'deepseek-v4.1-flash','chat',1);
 perform public.apply_tavern_request(b,rid,'unknown');
 r:=public.resolve_tavern_request(admin_id,null,rid,'refund',null,'synthetic ambiguous');
 assert r->>'code'='TAVERN_REQUEST_AMBIGUOUS';
 r:=public.apply_tavern_request(b,rid,'not_submitted');
 assert r#>>'{request,billing_status}'='refunded' and r->>'balance'='10.0000';
 r:=public.apply_tavern_request(b,rid,'not_submitted'); assert r->>'balance'='10.0000';
end; $$;
reset role;

do $$
declare u uuid:='ba000000-0000-4000-8000-000000000001'; admin_id uuid:='ba000000-0000-4000-8000-000000000003';
 rid uuid; r jsonb; sample jsonb; n integer;
begin
 -- Truly missing, malformed and contradictory statistics all require review.
 for sample in select value from jsonb_array_elements('[null,{},[],{"status":"missing"},
   {"status":"invalid","input_tokens":100},
   {"status":"confirmed","input_tokens":true,"output_tokens":0,"total_tokens":0,"cache_read_tokens":0},
   {"status":"confirmed","input_tokens":1,"output_tokens":1,"total_tokens":99,"cache_read_tokens":0}]') loop
  rid:=gen_random_uuid();
  r:=public.begin_tavern_request(u,rid,repeat('a',64),'deepseek-v4.1-flash','summary',0.01);
  assert r->>'leader'='true';
  r:=public.apply_tavern_request(u,rid,'completed',sample);
  assert r#>>'{request,billing_status}'='awaiting_review' and r#>'{request,charged_credits}'='null'::jsonb;
  r:=public.apply_tavern_request(u,rid,'completed','{"status":"confirmed","input_tokens":0,"output_tokens":0,"total_tokens":0,"cache_read_tokens":0}');
  assert r#>>'{request,billing_status}'='awaiting_review';
  r:=public.resolve_tavern_request(admin_id,u,rid,'refund',null,'synthetic missing usage verified');
  assert r#>>'{request,billing_status}'='refunded';
 end loop;
 -- A real, confirmed zero-token result is distinguishable from missing usage.
 rid:=gen_random_uuid();
 perform public.begin_tavern_request(u,rid,repeat('b',64),'deepseek-v4.1-flash','chat',0.01);
 r:=public.apply_tavern_request(u,rid,'completed','{"status":"confirmed","input_tokens":0,"output_tokens":0,"total_tokens":0,"cache_read_tokens":0}');
 assert r#>>'{request,billing_status}'='settled' and r#>>'{request,charged_credits}'='0.0000';
 assert (r->>'balance')::numeric=9.9260;
 -- Stale reserved holds become visible and can be explicitly resolved.
 rid:=gen_random_uuid();
 perform public.begin_tavern_request(u,rid,repeat('c',64),'deepseek-v4.1-flash','chat',0.01);
 update public.tavern_requests set created_at=now()-interval '6 minutes' where user_id=u and request_id=rid;
 assert jsonb_array_length(public.list_tavern_billing_reviews(admin_id)->'requests')=1;
 r:=public.resolve_tavern_request(admin_id,u,rid,'refund',null,'synthetic stale reservation checked');
 assert r#>>'{request,billing_status}'='refunded';
 -- Read cap is bounded but a single older request is still directly retrievable.
 for n in 1..51 loop
  rid:=gen_random_uuid();
  perform public.begin_tavern_request(u,rid,repeat('d',64),'deepseek-v4.1-flash','chat',0.0001);
  perform public.apply_tavern_request(u,rid,'not_submitted');
 end loop;
 assert jsonb_array_length(public.get_tavern_requests(u)->'requests')=50;
 assert jsonb_array_length(public.get_tavern_requests(u,'bb000000-0000-4000-8000-000000000001')->'requests')=1;
end; $$;

do $$
declare u uuid:='ba000000-0000-4000-8000-000000000001'; r jsonb; f record; count_before integer;
begin
 assert (select balance from public.credit_accounts where user_id=u)=9.9260;
 assert (select total_spent from public.credit_accounts where user_id=u)=0.0740;
 assert (select sum(delta) from public.credit_transactions where user_id=u and metadata->>'media_type'='tavern')=-0.0740;
 assert (select count(*) from public.credit_transactions where user_id=u and type='spend' and metadata->>'media_type'='tavern')=3;
 assert not exists(select 1 from public.credit_transactions where metadata->>'media_type'='tavern' and job_id is not null);
 assert exists(select 1 from public.credit_transactions where metadata->>'media_type'='tavern' and metadata->>'admin_user_id'='ba000000-0000-4000-8000-000000000003');
 -- Local profile changes are enforced inside SQL, not just by Flask.
 update public.profiles set status='frozen' where id=u;
 r:=public.begin_tavern_request(u,gen_random_uuid(),repeat('a',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'code'='ACCOUNT_FROZEN';
 update public.profiles set status='active',deleted_at=now() where id=u;
 r:=public.begin_tavern_request(u,gen_random_uuid(),repeat('a',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'code'='ACCOUNT_FROZEN';
 update public.profiles set deleted_at=null where id=u;
 update public.profiles set status='frozen' where id='ba000000-0000-4000-8000-000000000003';
 assert public.list_tavern_billing_reviews('ba000000-0000-4000-8000-000000000003')->>'code'='ADMIN_REQUIRED';
 update public.profiles set status='active' where id='ba000000-0000-4000-8000-000000000003';
 -- Expiry masks response at reads, then physical cleanup deletes only the body.
 select count(*) into count_before from public.tavern_requests;
 update public.tavern_requests set response_expires_at=now()-interval '1 second' where user_id=u and response_text is not null;
 assert public.get_tavern_requests(u,'bb000000-0000-4000-8000-000000000001')#>'{requests,0,response_text}'='null'::jsonb;
 assert private.prune_tavern_responses()=3;
 assert (select count(*) from public.tavern_requests)=count_before;
 assert not exists(select 1 from public.tavern_requests where user_id=u and response_text is not null);
 assert (select balance from public.credit_accounts where user_id=u)=9.9260;
 -- No browser role can invoke money or inspect raw table/response data.
 assert (select relrowsecurity from pg_class where oid='public.tavern_requests'::regclass);
 assert not has_table_privilege('anon','public.tavern_requests','select');
 assert not has_table_privilege('authenticated','public.tavern_requests','select');
 assert not has_table_privilege('service_role','public.tavern_requests','update');
 for f in select p.oid::regprocedure as signature,p.proname,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','private') and p.proname like '%tavern%' loop
  assert not has_function_privilege('anon',f.signature,'execute'),f.signature::text;
  assert not has_function_privilege('authenticated',f.signature,'execute'),f.signature::text;
 end loop;
 assert not has_function_privilege('service_role','private.finish_tavern_request(uuid,uuid,text,jsonb,text,text,uuid,text)','execute');
 assert has_function_privilege('service_role','public.begin_tavern_request(uuid,uuid,text,text,text,numeric)','execute');
end; $$;
rollback;
