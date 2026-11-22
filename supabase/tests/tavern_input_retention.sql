-- Synthetic fixtures only. Run after tavern_input_retention_72h.
-- No model calls; the transaction rolls back every fixture and billing event.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('c1000000-0000-4000-8000-000000000001','input-owner@example.invalid',now()),
 ('c1000000-0000-4000-8000-000000000002','input-other@example.invalid',now()),
 ('c1000000-0000-4000-8000-000000000003','input-admin@example.invalid',now());
insert into public.credit_accounts(user_id,balance)
 select id,20 from auth.users where id::text like 'c1000000-%'
 on conflict(user_id) do update set balance=20,total_spent=0,total_refunded=0;
update public.profiles set role='admin' where id='c1000000-0000-4000-8000-000000000003';

set local role service_role;
do $$
declare
 owner_id uuid:='c1000000-0000-4000-8000-000000000001';
 other_id uuid:='c1000000-0000-4000-8000-000000000002';
 admin_id uuid:='c1000000-0000-4000-8000-000000000003';
 rid uuid; kind text; r jsonb; previous jsonb; v jsonb; n integer:=0;
 usage jsonb:='{"status":"confirmed","input_tokens":2850,"output_tokens":237,"total_tokens":3087}';
begin
 foreach kind in array array['chat','summary','assist'] loop
  n:=n+1;
  rid:=('c2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('a',64),'deepseek-v4.1-flash',kind,1,
    '用户本轮输入 '||kind||E'\n保留原有换行与表情 🐱');
  assert r->>'ok'='true' and r->>'leader'='true', 'all request kinds save a new input';
  assert not (r->'request') ? 'input_text' and not (r->'request') ? 'input_expires_at',
    'begin projection does not expose input';
  r:=public.apply_tavern_request(owner_id,rid,'completed',usage,'synthetic response '||kind);
  assert r#>>'{request,billing_status}'='settled', 'normal billing still settles';
  assert r#>>'{request,charged_credits}'='0.0228', 'input storage does not change prices';
  assert (r#>>'{request,response_expires_at}')::timestamptz=now()+interval '72 hours',
    'reply keeps its own 72-hour retention';
  assert r#>>'{request,response_text}'='synthetic response '||kind, 'owner reply recovery unchanged';
  previous:=r->'request';
  r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('a',64),'deepseek-v4.1-flash',kind,1,
    'duplicate must not replace original input');
  assert r->>'leader'='false' and r->'request'=previous, 'duplicate is not a new generation';
  r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('b',64),'deepseek-v4.1-flash',kind,1,
    'conflicting input');
  assert r->>'code'='TAVERN_REQUEST_CONFLICT', 'different request fingerprint is rejected';
  assert jsonb_array_length(public.get_tavern_requests(other_id,rid)->'requests')=0,
    'another owner cannot read this request';
  r:=public.get_tavern_requests(owner_id,rid);
  assert not (r#>'{requests,0}') ? 'input_text' and not (r#>'{requests,0}') ? 'input_expires_at',
    'owner billing query does not gain input fields';
 end loop;

 -- Rolling back application code must keep the original RPC working. A replay
 -- through the new RPC must not invent historical input that was never stored.
 rid:='c2000000-0000-4000-8000-000000000004';
 r:=public.begin_tavern_request(owner_id,rid,repeat('c',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'leader'='true', 'legacy RPC remains callable';
 r:=public.apply_tavern_request(owner_id,rid,'completed',usage,'legacy response');
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('c',64),'deepseek-v4.1-flash','chat',1,'no legacy backfill');
 assert r->>'leader'='false', 'legacy replay cannot create a second reservation';

 rid:='c2000000-0000-4000-8000-000000000005';
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('d',64),'deepseek-v4.1-flash','chat',1,'failed input');
 r:=public.apply_tavern_request(owner_id,rid,'rejected',null,null,'SYNTHETIC_REJECTED');
 assert r#>>'{request,billing_status}'='refunded', 'failed requests keep existing refund behavior';
 rid:='c2000000-0000-4000-8000-000000000006';
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('e',64),'deepseek-v4.1-flash','chat',1,'unknown input');
 r:=public.apply_tavern_request(owner_id,rid,'unknown',null,null,'SYNTHETIC_UNKNOWN');
 assert r#>>'{request,billing_status}'='held', 'unknown request accounting is untouched';
 rid:='c2000000-0000-4000-8000-000000000007';
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('f',64),'deepseek-v4.1-flash','assist',1,'review input');
 r:=public.apply_tavern_request(owner_id,rid,'completed',null,'review response');
 assert r#>>'{request,billing_status}'='awaiting_review', 'incomplete usage stays in review';

 -- Reject invalid text before reserving credits or creating a request row.
 rid:='c2000000-0000-4000-8000-000000000008';
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1,null);
 assert r->>'code'='TAVERN_INPUT_INVALID', 'NULL input rejected';
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1,'');
 assert r->>'code'='TAVERN_INPUT_INVALID', 'empty input rejected';
 rid:='c2000000-0000-4000-8000-000000000009';
 r:=public.begin_tavern_request_with_input(owner_id,rid,repeat('a',64),'deepseek-v4.1-flash','chat',1,repeat('字',200000));
 assert r->>'leader'='true', 'long Unicode input accepted';
 r:=public.apply_tavern_request(owner_id,rid,'rejected',null,null,'SYNTHETIC_REJECTED');

 for v in select value from jsonb_array_elements(public.admin_tavern_overview(admin_id,7)->'requests') loop
  assert not v ? 'input_text' and not v ? 'response_text' and not v ? 'content',
    'admin overview does not expose either body';
 end loop;
 for v in select value from jsonb_array_elements(public.list_tavern_billing_reviews(admin_id)->'requests') loop
  assert not v ? 'input_text' and not v ? 'input_expires_at',
    'service-only billing review projection does not gain input fields';
 end loop;
end; $$;
reset role;

do $$
declare n integer:=0; kind text; rid uuid; j public.tavern_requests;
begin
 foreach kind in array array['chat','summary','assist'] loop
  n:=n+1;
  rid:=('c2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  select * into strict j from public.tavern_requests where request_id=rid;
  assert j.input_text='用户本轮输入 '||kind||E'\n保留原有换行与表情 🐱', 'original input is stored exactly once';
  assert j.input_expires_at=j.created_at+interval '72 hours', 'input expiry is anchored to initial creation';
 end loop;
 assert (select input_text is null and input_expires_at is null from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000004'), 'legacy rows stay empty';
 assert not exists(select 1 from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000008'), 'invalid input leaves no request';
 assert (select input_text=repeat('字',200000) and input_expires_at=created_at+interval '72 hours' from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000009'), 'long input retains its full text and normal expiry';
 assert (select relrowsecurity from pg_class where oid='public.tavern_requests'::regclass), 'RLS stays enabled';
 assert not has_table_privilege('anon','public.tavern_requests','SELECT'), 'anonymous cannot read the table';
 assert not has_table_privilege('authenticated','public.tavern_requests','SELECT'), 'signed-in clients cannot read the table';
 assert not has_table_privilege('service_role','public.tavern_requests','SELECT'), 'service role still uses explicit RPCs';
 assert has_function_privilege('service_role','public.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text)','EXECUTE'),
   'backend may execute the new RPC';
 assert not has_function_privilege('anon','public.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text)','EXECUTE'),
   'anonymous cannot execute the new RPC';
 assert not has_function_privilege('authenticated','public.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text)','EXECUTE'),
   'signed-in client cannot impersonate an owner through the new RPC';
 assert not has_function_privilege('service_role','private.prune_tavern_responses()','EXECUTE'),
   'backend cannot trigger global cleanup';
end; $$;

-- A storage failure must roll back the reservation, account debit and ledger,
-- rather than leave a bill for a request that could not save its input.
create function pg_temp.reject_tavern_input_fixture() returns trigger
language plpgsql as $$ begin
 if new.input_text='synthetic storage rejection' then raise exception 'synthetic input write failure'; end if;
 return new;
end; $$;
create trigger reject_tavern_input_fixture before update of input_text on public.tavern_requests
 for each row execute function pg_temp.reject_tavern_input_fixture();
do $$
declare before_balance numeric; before_count bigint;
begin
 select balance into before_balance from public.credit_accounts where user_id='c1000000-0000-4000-8000-000000000001';
 select count(*) into before_count from public.credit_transactions;
 begin
  perform public.begin_tavern_request_with_input('c1000000-0000-4000-8000-000000000001',
   'c2000000-0000-4000-8000-000000000010',repeat('a',64),'deepseek-v4.1-flash','chat',1,'synthetic storage rejection');
  raise exception 'expected input write to fail';
 exception when raise_exception then
  assert sqlerrm='synthetic input write failure', 'fixture reached the input storage write';
 end;
 assert not exists(select 1 from public.tavern_requests where request_id='c2000000-0000-4000-8000-000000000010'),
  'input write failure rolls back the request';
 assert (select balance=before_balance from public.credit_accounts where user_id='c1000000-0000-4000-8000-000000000001'),
  'input write failure rolls back the account debit';
 assert (select count(*)=before_count from public.credit_transactions), 'input write failure rolls back the reservation ledger';
end; $$;
drop trigger reject_tavern_input_fixture on public.tavern_requests;

-- The two bodies expire independently. Input-only failures must also be purged.
update public.tavern_requests set input_expires_at=now()
 where request_id='c2000000-0000-4000-8000-000000000001';
update public.tavern_requests set response_expires_at=now()
 where request_id='c2000000-0000-4000-8000-000000000002';
update public.tavern_requests set input_expires_at=now()-interval '1 second'
 where request_id in ('c2000000-0000-4000-8000-000000000005','c2000000-0000-4000-8000-000000000006',
   'c2000000-0000-4000-8000-000000000007');
update public.tavern_requests set response_expires_at=now()-interval '1 second'
 where request_id='c2000000-0000-4000-8000-000000000007';
create temporary table input_accounts_before as select * from public.credit_accounts;
create temporary table input_ledger_before as select * from public.credit_transactions;
create temporary table input_requests_before as
 select id,to_jsonb(t)-array['input_text','response_text'] as data from public.tavern_requests t;

do $$
declare removed integer; r jsonb;
begin
 removed:=private.prune_tavern_responses();
 assert removed>=5, 'expired input and output are both removed';
 assert private.prune_tavern_responses()=0, 'cleanup is idempotent';
 assert (select input_text is null and response_text='synthetic response chat' from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000001'), 'expired input does not clear a live reply';
 assert (select input_text is not null and response_text is null from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000002'), 'expired reply does not clear live input';
 assert (select input_text is not null and response_text='synthetic response assist' from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000003'), 'live bodies remain';
 assert not exists(select 1 from public.tavern_requests where input_text is not null and request_id in
   ('c2000000-0000-4000-8000-000000000005','c2000000-0000-4000-8000-000000000006','c2000000-0000-4000-8000-000000000007')),
   'failed, unknown and review input all expire without waiting for a reply';
 assert not exists((table input_accounts_before except table public.credit_accounts)
   union all (table public.credit_accounts except table input_accounts_before)), 'cleanup cannot change balances';
 assert not exists((table input_ledger_before except table public.credit_transactions)
   union all (table public.credit_transactions except table input_ledger_before)), 'cleanup cannot change transactions';
 assert not exists((select * from input_requests_before except select id,to_jsonb(t)-array['input_text','response_text'] from public.tavern_requests t)
   union all (select id,to_jsonb(t)-array['input_text','response_text'] from public.tavern_requests t except select * from input_requests_before)),
   'cleanup changes only body columns, keeping expiry, usage, status and billing fields';
 r:=public.begin_tavern_request_with_input('c1000000-0000-4000-8000-000000000001',
   'c2000000-0000-4000-8000-000000000001',repeat('a',64),'deepseek-v4.1-flash','chat',1,'must not resurrect');
 assert r->>'leader'='false', 'replay after expiry does not restart the request';
 assert (select input_text is null and input_expires_at=now() from public.tavern_requests
   where request_id='c2000000-0000-4000-8000-000000000001'), 'replay cannot restore cleared text or extend expiry';
 assert not exists((table input_accounts_before except table public.credit_accounts)
   union all (table public.credit_accounts except table input_accounts_before)), 'replay cannot reserve again';
 assert not exists((table input_ledger_before except table public.credit_transactions)
   union all (table public.credit_transactions except table input_ledger_before)), 'replay cannot create duplicate accounting';
end; $$;
rollback;
