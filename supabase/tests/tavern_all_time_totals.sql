-- Isolated database fixtures only. Never run this file against production.
begin;
insert into auth.users(id,email,email_confirmed_at) values
 ('ac000000-0000-4000-8000-000000000001','totals-admin@example.invalid',now()),
 ('ac000000-0000-4000-8000-000000000002','totals-user@example.invalid',now());
update public.profiles set role='admin' where id='ac000000-0000-4000-8000-000000000001';
do $$
declare actor uuid := 'ac000000-0000-4000-8000-000000000001';
 other_user uuid := 'ac000000-0000-4000-8000-000000000002';
 baseline jsonb; actual jsonb; money_before jsonb; rows_before bigint;
begin
 baseline := public.admin_tavern_totals(actor)->'stats';
 select count(*) into rows_before from public.tavern_requests;
 -- >50 records, including a call older than the former 90-day maximum.
 insert into public.tavern_requests(user_id,request_id,request_fingerprint,model,kind,status,billing_status,reserved_credits,charged_credits,created_at)
 select other_user,gen_random_uuid(),repeat('a',64),'deepseek-v4.1-flash','chat','completed','settled',1,0.0001,now()-interval '400 days'
 from generate_series(1,51);
 insert into public.tavern_requests(user_id,request_id,request_fingerprint,model,kind,status,billing_status,reserved_credits,charged_credits) values
 (other_user,gen_random_uuid(),repeat('b',64),'deepseek-v4.1-flash','summary','completed','settled',1,0.1234),
 (other_user,gen_random_uuid(),repeat('c',64),'deepseek-v4.1-flash','assist','unknown','awaiting_review',10,null),
 (other_user,gen_random_uuid(),repeat('d',64),'deepseek-v4.1-flash','assist','failed','refunded',10,0);
 select jsonb_agg(to_jsonb(t) order by id) into money_before from public.credit_transactions t;
 actual := public.admin_tavern_totals(actor);
 assert actual->>'scope'='all';
 assert (select count(*) from jsonb_object_keys(actual->'stats'))=6;
 assert (actual->'stats'->>'requests')::bigint=(baseline->>'requests')::bigint+54;
 assert (actual->'stats'->>'users')::bigint=(baseline->>'users')::bigint+1;
 assert (actual->'stats'->>'chat')::bigint=(baseline->>'chat')::bigint+51;
 assert (actual->'stats'->>'summary')::bigint=(baseline->>'summary')::bigint+1;
 assert (actual->'stats'->>'assist')::bigint=(baseline->>'assist')::bigint+2;
 assert (actual->'stats'->>'credits_spent')::numeric=(baseline->>'credits_spent')::numeric+0.1285;
 assert not actual ? 'requests'; -- no request records, user identifiers or text
 assert (select jsonb_agg(to_jsonb(t) order by id) from public.credit_transactions t) is not distinct from money_before;
 assert (select count(*) from public.tavern_requests)=rows_before+54;
 assert (public.admin_tavern_totals(other_user)->>'code')='ADMIN_REQUIRED';
 assert (public.admin_tavern_totals(null)->>'code')='ADMIN_REQUIRED';
 update public.profiles set status='frozen' where id=actor;
 assert (public.admin_tavern_totals(actor)->>'code')='ADMIN_REQUIRED';
 update public.profiles set status='active' where id=actor;
 update auth.users set email_confirmed_at=null where id=actor;
 assert (public.admin_tavern_totals(actor)->>'code')='ADMIN_REQUIRED';
 assert not has_function_privilege('anon','public.admin_tavern_totals(uuid)','execute');
 assert not has_function_privilege('authenticated','public.admin_tavern_totals(uuid)','execute');
 assert not has_function_privilege('authenticated','private.admin_tavern_totals(uuid)','execute');
 assert has_function_privilege('service_role','public.admin_tavern_totals(uuid)','execute');
end; $$;
rollback;
