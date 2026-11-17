-- Synthetic fixtures only. All balances and audit rows roll back at the end.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('e1000000-0000-4000-8000-000000000001','refadmin@example.invalid',now(),'{"username":"邀请统计管理员"}'),
 ('e1000000-0000-4000-8000-000000000002','refinviter@example.invalid',now(),'{"username":"邀请%_Alpha"}'),
 ('e1000000-0000-4000-8000-000000000006','deleted-inviter@example.invalid',now(),'{"username":"将注销邀请人"}'),
 ('e1000000-0000-4000-8000-000000000008','ref-unverified-admin@example.invalid',null,'{}'),
 ('e1000000-0000-4000-8000-000000000009','ref-frozen-admin@example.invalid',now(),'{}'),
 ('e1000000-0000-4000-8000-000000000010','ref-ordinary@example.invalid',now(),'{}');
update public.profiles set role='admin' where id in ('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000008','e1000000-0000-4000-8000-000000000009');
update public.profiles set status='frozen' where id='e1000000-0000-4000-8000-000000000009';

do $$
declare
 a uuid:='e1000000-0000-4000-8000-000000000001';i uuid:='e1000000-0000-4000-8000-000000000002';
 u uuid:='e1000000-0000-4000-8000-000000000003';z uuid:='e1000000-0000-4000-8000-000000000004';
 g uuid:='e1000000-0000-4000-8000-000000000005';d uuid:='e1000000-0000-4000-8000-000000000006';
 e uuid:='e1000000-0000-4000-8000-000000000007';
 initial jsonb;r jsonb;r2 jsonb;full_page jsonb;rec jsonb;totals jsonb;ic text;uc text;dc text;
 batch uuid:=gen_random_uuid();proof text;card uuid;codes jsonb;idx integer;before_txs bigint;
begin
 initial:=public.admin_referral_overview(a);
 assert (initial->>'ok')::boolean;
 select code into ic from private.referral_codes where user_id=i;
 select code into dc from private.referral_codes where user_id=d;
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 (u,'bulk-invitee@example.invalid',now(),jsonb_build_object('username','批量受邀人','referral_code',ic)),
 (z,'zero-invitee@example.invalid',now(),jsonb_build_object('username','零兑换 Beta','referral_code',ic)),
 (e,'deleted-invitee@example.invalid',now(),jsonb_build_object('username','将注销受邀人','referral_code',dc));
 select code into uc from private.referral_codes where user_id=u;
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 (g,'grandchild@example.invalid',now(),jsonb_build_object('username','单层下一位','referral_code',uc));
 select jsonb_agg(jsonb_build_object('hash',md5('admin-referral-'||n)||md5('voucher-'||n),'suffix','AAAA'))
 into codes from generate_series(1,25)n;
 r:=public.create_credit_code_batch(a,batch,'pf20',25,'synthetic report vouchers',repeat('a',64),'synthetic',codes);
 assert (r->>'ok')::boolean;
 for idx in 1..25 loop
   if idx%10=0 then update private.credit_code_attempts set window_start=now()-interval '11 minutes' where user_id=u;end if;
   proof:=md5('admin-referral-'||idx)||md5('voucher-'||idx);
   r:=public.redeem_credit_code(u,proof);assert (r->>'ok')::boolean;
 end loop;
 assert (select balance from public.credit_accounts where user_id=u)=500;
 assert (select balance from public.credit_accounts where user_id=i)=50;
 assert (select count(*) from private.referral_redemptions where invitee_user_id=u)=25;
 assert (select count(*) from private.referral_rewards where invitee_user_id=u)=25;
 before_txs:=(select count(*) from public.credit_transactions);
 r:=public.redeem_credit_code(u,proof);assert (r->>'idempotent')::boolean;
 assert (select count(*) from public.credit_transactions)=before_txs;
 assert (select count(*) from private.referral_redemptions where invitee_user_id=u)=25;
 -- Grandchild awards only its direct inviter. Reporting does not create awards.
 r:=public.create_credit_code_batch(a,gen_random_uuid(),'pf70',1,'direct referral',repeat('b',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',repeat('7',64),'suffix','BBBB')));
 r:=public.redeem_credit_code(g,repeat('7',64));assert (r->>'ok')::boolean;
 assert (select balance from public.credit_accounts where user_id=g)=70;
 assert (select balance from public.credit_accounts where user_id=u)=507;
 assert (select balance from public.credit_accounts where user_id=i)=50;

 -- An inviter deleted before redemption receives no award, but an immutable
 -- audit fact is still written in the same successful full-credit transaction.
 delete from auth.users where id=d;
 r:=public.create_credit_code_batch(a,gen_random_uuid(),'pf20',1,'no award',repeat('c',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',repeat('8',64),'suffix','CCCC')));
 r:=public.redeem_credit_code(e,repeat('8',64));assert (r->>'ok')::boolean;
 select id into card from public.credit_codes where code_hash=repeat('8',64);
 assert (select balance from public.credit_accounts where user_id=e)=20;
 assert exists(select 1 from private.referral_redemptions where code_id=card and inviter_user_id=d and invitee_user_id=e);
 assert not exists(select 1 from private.referral_rewards where code_id=card);
 r:=public.admin_referral_overview(a,'rewards',e::text,20,0);
 assert (r->>'total_count')::int=1;
 assert r#>>'{records,0,status}'='not_issued' and (r#>>'{records,0,reward_credits}')::numeric=0;
 assert r#>>'{records,0,inviter_name}'='已注销用户' and r#>'{records,0,inviter_email}'='null'::jsonb;
 totals:=r->'totals';
 assert (totals->>'inviter_count')::int-(initial#>>'{totals,inviter_count}')::int=3;
 assert (totals->>'invitee_count')::int-(initial#>>'{totals,invitee_count}')::int=4;
 assert (totals->>'redemption_count')::int-(initial#>>'{totals,redemption_count}')::int=27;
 assert (totals->>'redeemed_credits')::numeric-(initial#>>'{totals,redeemed_credits}')::numeric=590;
 assert (totals->>'reward_credits')::numeric-(initial#>>'{totals,reward_credits}')::numeric=57;

 -- Both views search both sides. Wildcard-looking input is literal text.
 r:=public.admin_referral_overview(a,'relations','零兑换',20,0);
 assert (r->>'total_count')::int=1 and (r#>>'{records,0,redemption_count}')::int=0;
 assert (r#>>'{records,0,redeemed_credits}')::numeric=0 and (r#>>'{records,0,reward_credits}')::numeric=0;
 assert r->'totals'=totals;
 r:=public.admin_referral_overview(a,'relations','REFINVITER@EXAMPLE.INVALID',20,0);
 assert (r->>'total_count')::int=2 and r->'totals'=totals;
 r:=public.admin_referral_overview(a,'rewards','REFINVITER@EXAMPLE.INVALID',50,0);
 assert (r->>'total_count')::int=25 and jsonb_array_length(r->'records')=25;
 r:=public.admin_referral_overview(a,'relations',u::text,20,0);assert (r->>'total_count')::int=2;
 r:=public.admin_referral_overview(a,'rewards',u::text,50,0);assert (r->>'total_count')::int=26;
 r:=public.admin_referral_overview(a,'relations','%',20,0);assert (r->>'total_count')::int=2;
 r:=public.admin_referral_overview(a,'rewards','_',50,0);assert (r->>'total_count')::int=25;
 r:=public.admin_referral_overview(a,'relations','%_',20,0);assert (r->>'total_count')::int=2;
 r:=public.admin_referral_overview(a,'rewards','%%%no-literal-match',20,0);
 assert r->'records'='[]'::jsonb and (r->>'total_count')::int=0 and not(r->>'has_more')::boolean;
 assert r->'totals'=totals;

 -- All fixtures share now(), exercising the UUID tie-break across pages.
 full_page:=public.admin_referral_overview(a,'rewards','refinviter@example.invalid',50,0);
 r:=public.admin_referral_overview(a,'rewards','refinviter@example.invalid',20,0);
 r2:=public.admin_referral_overview(a,'rewards','refinviter@example.invalid',20,20);
 assert jsonb_array_length(r->'records')=20 and (r->>'has_more')::boolean;
 assert jsonb_array_length(r2->'records')=5 and not(r2->>'has_more')::boolean;
 assert (r->'records')||(r2->'records')=full_page->'records';
 r:=public.admin_referral_overview(a,'relations','refinviter@example.invalid',1,0);
 r2:=public.admin_referral_overview(a,'relations','refinviter@example.invalid',1,1);
 assert r#>>'{records,0,invitee_id}'<>r2#>>'{records,0,invitee_id}';
 assert (r->>'has_more')::boolean and not(r2->>'has_more')::boolean;
 r:=public.admin_referral_overview(a,'rewards','refinviter@example.invalid',20,1000000);
 assert r->'records'='[]'::jsonb and (r->>'total_count')::int=25 and not(r->>'has_more')::boolean;

 -- Neither redeemed_by clearing nor later metadata edits rewrite attribution.
 update auth.users set raw_user_meta_data=jsonb_build_object('referral_code',ic) where id=g;
 r:=public.admin_referral_overview(a,'relations',g::text,20,0);
 assert r#>>'{records,0,inviter_id}'=u::text;
 delete from auth.users where id=e;
 assert (select redeemed_by from public.credit_codes where id=card) is null;
 r:=public.admin_referral_overview(a,'rewards',e::text,20,0);
 assert r->'totals'=totals and (r->>'total_count')::int=1;
 assert r#>>'{records,0,status}'='not_issued' and r#>>'{records,0,id}'=card::text;
 assert r#>>'{records,0,invitee_name}'='已注销用户' and r#>'{records,0,invitee_email}'='null'::jsonb;
 delete from auth.users where id=u;
 r:=public.admin_referral_overview(a,'rewards',u::text,50,0);
 assert r->'totals'=totals and (r->>'total_count')::int=26;
 select v into rec from jsonb_array_elements(r->'records')v where v->>'invitee_id'=u::text limit 1;
 assert rec->>'invitee_name'='已注销用户' and rec->'invitee_email'='null'::jsonb;
 select v into rec from jsonb_array_elements(r->'records')v where v->>'invitee_id'=g::text limit 1;
 assert rec->>'inviter_name'='已注销用户' and rec->'inviter_email'='null'::jsonb;
 r:=public.admin_referral_overview(a,'relations',u::text,20,0);
 assert (r->>'total_count')::int=2 and r->'totals'=totals;
 begin
   update private.referral_redemptions set redeemed_credits=999 where code_id=card;
   raise exception 'expected immutable audit';
 exception when check_violation then assert sqlerrm='REFERRAL_REDEMPTION_IMMUTABLE';end;
 begin
   delete from private.referral_redemptions where code_id=card;
   raise exception 'expected immutable audit';
 exception when check_violation then assert sqlerrm='REFERRAL_REDEMPTION_IMMUTABLE';end;

 -- Authorisation precedes input validation and returns no counts or identities.
 foreach idx in array array[8,9,10] loop
   r:=public.admin_referral_overview(('e1000000-0000-4000-8000-'||lpad(idx::text,12,'0'))::uuid);
   assert r=jsonb_build_object('ok',false,'code','ADMIN_REQUIRED');
 end loop;
 r:=public.admin_referral_overview(null);assert r->>'code'='ADMIN_REQUIRED';
 update public.profiles set deleted_at=now() where id=a;
 r:=public.admin_referral_overview(a);assert r->>'code'='ADMIN_REQUIRED';
 update public.profiles set deleted_at=null where id=a;
 r:=public.admin_referral_overview(a,'other');assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,'rewards',repeat('x',121));assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,'relations','',51,0);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,'relations','',0,0);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,'relations','',20,1000001);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,'relations','',20,-1);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,null);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.admin_referral_overview(a,'relations',null);assert r->>'code'='INVALID_REFERRAL_INPUT';
end;
$$;

-- Failure in the new audit write must roll back the original purchase, voucher,
-- ledger, balances, and future reward. A reward failure must also roll back audit.
create function pg_temp.fail_referral_audit() returns trigger language plpgsql as $$
begin raise exception 'fixture audit unavailable';end;
$$;
create trigger fixture_fail_referral_audit before insert on private.referral_redemptions
 for each row execute function pg_temp.fail_referral_audit();
do $$
declare a uuid:='e1000000-0000-4000-8000-000000000001';i uuid:='e1000000-0000-4000-8000-000000000002';
 z uuid:='e1000000-0000-4000-8000-000000000004';r jsonb;card uuid;ab numeric;zb numeric;tx bigint;
begin
 r:=public.create_credit_code_batch(a,gen_random_uuid(),'pf20',1,'audit rollback',repeat('d',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',repeat('6',64),'suffix','DDDD')));
 select id into card from public.credit_codes where code_hash=repeat('6',64);
 select balance into ab from public.credit_accounts where user_id=i;
 select balance into zb from public.credit_accounts where user_id=z;
 select count(*) into tx from public.credit_transactions;
 begin perform public.redeem_credit_code(z,repeat('6',64));raise exception 'expected audit failure';
 exception when others then assert sqlerrm='fixture audit unavailable',sqlerrm;end;
 assert (select balance from public.credit_accounts where user_id=i)=ab;
 assert (select balance from public.credit_accounts where user_id=z)=zb;
 assert (select count(*) from public.credit_transactions)=tx;
 assert (select status from public.credit_codes where id=card)='ready';
 assert not exists(select 1 from private.referral_redemptions where code_id=card);
 assert not exists(select 1 from private.referral_rewards where code_id=card);
 assert not exists(select 1 from public.credit_code_events where code_id=card);
end;
$$;
drop trigger fixture_fail_referral_audit on private.referral_redemptions;
create function pg_temp.fail_admin_referral_reward() returns trigger language plpgsql as $$
begin if new.type='referral_bonus' then raise exception 'fixture reward unavailable';end if;return new;end;
$$;
create trigger fixture_fail_admin_referral_reward before insert on public.credit_transactions
 for each row execute function pg_temp.fail_admin_referral_reward();
do $$
declare z uuid:='e1000000-0000-4000-8000-000000000004';card uuid;tx bigint;
begin
 select id into card from public.credit_codes where code_hash=repeat('6',64);
 select count(*) into tx from public.credit_transactions;
 begin perform public.redeem_credit_code(z,repeat('6',64));raise exception 'expected reward failure';
 exception when others then assert sqlerrm='fixture reward unavailable',sqlerrm;end;
 assert (select status from public.credit_codes where id=card)='ready';
 assert not exists(select 1 from private.referral_redemptions where code_id=card);
 assert not exists(select 1 from private.referral_rewards where code_id=card);
 assert (select count(*) from public.credit_transactions)=tx;
end;
$$;
drop trigger fixture_fail_admin_referral_reward on public.credit_transactions;

do $$
declare r text;f text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
   assert not has_table_privilege(r,'private.referral_redemptions','SELECT,INSERT,UPDATE,DELETE');
   assert not has_table_privilege(r,'private.admin_referral_redemptions','SELECT,INSERT,UPDATE,DELETE');
   assert not has_function_privilege(r,'private.capture_referral_redemption()','EXECUTE');
   assert not has_function_privilege(r,'private.prevent_referral_redemption_rewrite()','EXECUTE');
 end loop;
 foreach f in array array['public.admin_referral_overview(uuid,text,text,integer,integer)','private.admin_referral_overview(uuid,text,text,integer,integer)'] loop
   assert not has_function_privilege('anon',f,'EXECUTE');
   assert not has_function_privilege('authenticated',f,'EXECUTE');
   assert has_function_privilege('service_role',f,'EXECUTE');
 end loop;
 assert (select relrowsecurity from pg_class where oid='private.referral_redemptions'::regclass);
 assert (select reloptions @> array['security_invoker=true'] from pg_class where oid='private.admin_referral_redemptions'::regclass);
end;
$$;
rollback;
