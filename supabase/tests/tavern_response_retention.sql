-- Synthetic fixtures only; run after the 72-hour response retention migration.
-- The surrounding transaction is rolled back; no model or network requests.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('be000000-0000-4000-8000-000000000001','retention-owner@example.invalid',now()),
 ('be000000-0000-4000-8000-000000000002','retention-other@example.invalid',now()),
 ('be000000-0000-4000-8000-000000000003','retention-admin@example.invalid',now());
insert into public.credit_accounts(user_id,balance)
 select id,10 from auth.users where id::text like 'be000000-%'
 on conflict(user_id) do update set balance=10,total_spent=0,total_refunded=0;
update public.profiles set role='admin' where id='be000000-0000-4000-8000-000000000003';

set local role service_role;
do $$
declare
 owner_id uuid:='be000000-0000-4000-8000-000000000001';
 other_id uuid:='be000000-0000-4000-8000-000000000002';
 admin_id uuid:='be000000-0000-4000-8000-000000000003';
 rid uuid; kind text; r jsonb; original jsonb; v jsonb; n integer:=0;
 usage jsonb:='{"status":"confirmed","input_tokens":2850,"output_tokens":237,"total_tokens":3087}';
begin
 foreach kind in array array['chat','summary','assist'] loop
  n:=n+1;
  rid:=('bf000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=public.begin_tavern_request(owner_id,rid,repeat('a',64),'deepseek-v4.1-flash',kind,1);
  assert r->>'leader'='true', 'new response has one leader';
  r:=public.apply_tavern_request(owner_id,rid,'completed',usage,'synthetic retained '||kind);
  assert r#>>'{request,billing_status}'='settled', 'trusted usage still settles';
  assert (r#>>'{request,response_expires_at}')::timestamptz=now()+interval '72 hours', 'all reply kinds retain 72 hours';
  assert r#>>'{request,charged_credits}'='0.0228', 'retention does not change pricing';
  assert r#>>'{request,response_text}'='synthetic retained '||kind, 'owner receives the original body';
  original:=r;
  r:=public.apply_tavern_request(owner_id,rid,'completed',usage,'duplicate must not replace text');
  assert r=original, 'duplicate cannot reset expiry, text, or accounting';
  r:=public.apply_tavern_request(owner_id,rid,'rejected',null,null,'LATE_FAILURE');
  assert r=original, 'late failure cannot alter a terminal result';
  assert jsonb_array_length(public.get_tavern_requests(other_id,rid)->'requests')=0, 'other user cannot recover body';
 end loop;
 rid:='bf000000-0000-4000-8000-000000000004';
 r:=public.begin_tavern_request(owner_id,rid,repeat('b',64),'deepseek-v4.1-flash','chat',1);
 assert r->>'leader'='true';
 r:=public.apply_tavern_request(owner_id,rid,'completed',null,'synthetic review body');
 assert r#>>'{request,billing_status}'='awaiting_review', 'missing usage stays unresolved';
 assert (r#>>'{request,response_expires_at}')::timestamptz=now()+interval '72 hours', 'review replies also retain 72 hours';
 assert r#>>'{request,response_text}'='synthetic review body';
 for v in select value from jsonb_array_elements(public.admin_tavern_overview(admin_id,7)->'requests') loop
  assert not v ? 'response_text' and not v ? 'content', 'admin overview cannot expose reply bodies';
 end loop;
end; $$;
reset role;

-- Simulate a reply saved 48 hours ago; it remains recoverable beyond the old 12h window.
update public.tavern_requests set created_at=now()-interval '48 hours',
 response_expires_at=now()+interval '24 hours'
 where request_id='bf000000-0000-4000-8000-000000000001';
do $$ begin
 assert public.get_tavern_requests('be000000-0000-4000-8000-000000000001',
  'bf000000-0000-4000-8000-000000000001')#>>'{requests,0,response_text}'='synthetic retained chat';
end; $$;

-- Expire one settled reply at the exact boundary and the review reply just past it.
update public.tavern_requests set response_expires_at=now()
 where request_id='bf000000-0000-4000-8000-000000000002';
update public.tavern_requests set response_expires_at=now()-interval '1 second'
 where request_id='bf000000-0000-4000-8000-000000000004';
create temporary table retention_accounts_before as select * from public.credit_accounts;
create temporary table retention_ledger_before as select * from public.credit_transactions;
create temporary table retention_requests_before as
 select id,to_jsonb(t)-'response_text' as data from public.tavern_requests t;

do $$
declare r jsonb; removed integer;
begin
 r:=public.get_tavern_requests('be000000-0000-4000-8000-000000000001','bf000000-0000-4000-8000-000000000002');
 assert r#>>'{requests,0,response_text}' is null, 'expiry hides reply before cron runs';
 assert r#>>'{requests,0,billing_status}'='settled', 'expired reply keeps settled bill';
 assert r#>>'{requests,0,usage,input_tokens}'='2850', 'expired reply keeps measured usage';
 removed:=private.prune_tavern_responses();
 assert removed>=2, 'cron removes both expired bodies';
 assert private.prune_tavern_responses()=0, 'cleanup is idempotent';
 assert (select response_text from public.tavern_requests where request_id='bf000000-0000-4000-8000-000000000002') is null;
 assert (select response_text from public.tavern_requests where request_id='bf000000-0000-4000-8000-000000000004') is null;
 assert (select response_text from public.tavern_requests where request_id='bf000000-0000-4000-8000-000000000001')='synthetic retained chat';
 assert (select response_text from public.tavern_requests where request_id='bf000000-0000-4000-8000-000000000003')='synthetic retained assist';
 assert not exists((table retention_accounts_before except table public.credit_accounts)
  union all (table public.credit_accounts except table retention_accounts_before)), 'cleanup must not touch balances';
 assert not exists((table retention_ledger_before except table public.credit_transactions)
  union all (table public.credit_transactions except table retention_ledger_before)), 'cleanup must not touch transactions';
 assert not exists((select * from retention_requests_before except select id,to_jsonb(t)-'response_text' from public.tavern_requests t)
  union all (select id,to_jsonb(t)-'response_text' from public.tavern_requests t except select * from retention_requests_before)), 'only response_text may be pruned';
end; $$;
rollback;
