-- Synthetic, transactional fixtures only. Run after referral_rewards migration.
begin;
insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 ('d1000000-0000-4000-8000-000000000001','referrer@example.invalid',now(),'{"username":"邀请人"}'),
 ('d1000000-0000-4000-8000-000000000004','outsider@example.invalid',now(),'{"username":"无关联用户"}'),
 ('d1000000-0000-4000-8000-000000000005','unverified-referrer@example.invalid',null,'{}'),
 ('d1000000-0000-4000-8000-000000000006','no-referral@example.invalid',now(),'{}');

do $$
declare
 a uuid := 'd1000000-0000-4000-8000-000000000001';
 b uuid := 'd1000000-0000-4000-8000-000000000002';
 c uuid := 'd1000000-0000-4000-8000-000000000003';
 o uuid := 'd1000000-0000-4000-8000-000000000004';
 n uuid := 'd1000000-0000-4000-8000-000000000006';
 ac text; bc text; r jsonb; package text; credits integer; hash text; batch uuid; i integer;
 before_b numeric; before_a numeric; v_count bigint; metrics_before jsonb; metrics_after jsonb;
begin
 select code into ac from private.referral_codes where user_id=a;
 assert ac ~ '^PF[0-9A-F]{12}$';
 assert (select count(*) from private.referral_codes where user_id in(a,o,n))=3;
 r:=public.validate_referral_code(lower(ac));assert r=jsonb_build_object('ok',true,'valid',true);
 r:=public.validate_referral_code('  '||ac||' ');assert (r->>'valid')::boolean;
 r:=public.validate_referral_code('PF000000000000');assert not(r->>'valid')::boolean;
 r:=public.validate_referral_code(null);assert not(r->>'valid')::boolean;
 r:=public.validate_referral_code(repeat('x',1000));assert not(r->>'valid')::boolean;

 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
 values(b,'invitee@example.invalid',now(),jsonb_build_object('username','直接受邀人','referral_code',lower(ac)));
 select code into bc from private.referral_codes where user_id=b;
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
 values(c,'downstream@example.invalid',now(),jsonb_build_object('username','第二层用户','referral_code',bc));
 assert (select inviter_user_id from private.referral_bindings where invitee_user_id=b)=a;
 assert (select inviter_user_id from private.referral_bindings where invitee_user_id=c)=b;
 assert not exists(select 1 from private.referral_bindings where invitee_user_id=n);
 -- Later metadata edits neither rebind a referral nor attach an old account.
 update auth.users set raw_user_meta_data=jsonb_build_object('referral_code',bc) where id=b;
 update auth.users set raw_user_meta_data=jsonb_build_object('referral_code',ac) where id=n;
 assert (select inviter_user_id from private.referral_bindings where invitee_user_id=b)=a;
 assert not exists(select 1 from private.referral_bindings where invitee_user_id=n);
 begin
   update private.referral_bindings set inviter_user_id=o where invitee_user_id=b;
   raise exception 'expected immutable binding';
 exception when check_violation then assert sqlerrm='REFERRAL_BINDING_IMMUTABLE';end;
 begin
   delete from private.referral_bindings where invitee_user_id=b;
   raise exception 'expected immutable binding';
 exception when check_violation then assert sqlerrm='REFERRAL_BINDING_IMMUTABLE';end;
 begin
   insert into private.referral_bindings(invitee_user_id,inviter_user_id) values(o,o);
   raise exception 'expected self referral rejected';
 exception when check_violation then null;end;

 -- Invalid supplied input rolls back the entire signup, including profile/code.
 begin
   insert into auth.users(id,email,raw_user_meta_data) values('d1000000-0000-4000-8000-000000000020','invalid-invite@example.invalid','{"referral_code":"not-a-code"}');
   raise exception 'expected invalid code';
 exception when invalid_parameter_value then assert sqlerrm='REFERRAL_CODE_INVALID';end;
 assert not exists(select 1 from auth.users where id='d1000000-0000-4000-8000-000000000020');
 assert not exists(select 1 from public.profiles where id='d1000000-0000-4000-8000-000000000020');
 assert not exists(select 1 from private.referral_email_claims where email_hash=encode(extensions.digest('invalid-invite@example.invalid','sha256'),'hex'));
 update public.profiles set status='frozen' where id=a;
 r:=public.validate_referral_code(ac);assert not(r->>'valid')::boolean;
 r:=public.referral_snapshot(a);assert r->>'code'='ACCOUNT_FROZEN';
 begin
   insert into auth.users(id,email,raw_user_meta_data) values('d1000000-0000-4000-8000-000000000020','invalid-invite@example.invalid',jsonb_build_object('referral_code',ac));
   raise exception 'expected frozen inviter rejected';
 exception when invalid_parameter_value then assert sqlerrm='REFERRAL_CODE_INVALID';end;
 update public.profiles set status='active' where id=a;
 update public.profiles set role='admin' where id=o;

 -- Non-voucher credits never award a referral bonus, even to a bound account.
 select balance into before_a from public.credit_accounts where user_id=a;
 perform public.ensure_signup_bonus(b);
 perform public.admin_adjust_credits(o,b,5,'fixture administrative grant','referral-test-adjustment');
 insert into public.credit_transactions(user_id,type,delta,idempotency_key,metadata)
 values(b,'purchase',10,'fixture-non-voucher-purchase','{"source":"other_payment"}'),
       (b,'refund',10,'fixture-non-voucher-refund','{}');
 assert (select balance from public.credit_accounts where user_id=a)=before_a;
 assert not exists(select 1 from private.referral_rewards where invitee_user_id=b);
 select balance into before_b from public.credit_accounts where user_id=b;
 metrics_before:=public.get_admin_metrics(current_date-1,current_date+1);

 -- All five existing voucher packages award 10% in addition to full credit.
 for i in 1..5 loop
   package:=(array['pf20','pf70','pf120','pf200','pf260'])[i];
   credits:=(array[20,70,120,200,260])[i];
   hash:=md5('referral-voucher-'||i)||md5('referral-other-'||i);batch:=gen_random_uuid();
   r:=public.create_credit_code_batch(o,batch,package,1,'赠送或购买均参与',repeat('a',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',hash,'suffix','AAAA')));
   assert (r->>'ok')::boolean;
   r:=public.redeem_credit_code(b,hash);assert (r->>'ok')::boolean and not(r->>'idempotent')::boolean;
   assert (r->>'credits')::numeric=credits;
   assert (select reward_credits from private.referral_rewards where code_id=(select id from public.credit_codes where code_hash=hash))=credits*0.1;
 end loop;
 assert (select balance from public.credit_accounts where user_id=b)=before_b+670;
 assert (select balance from public.credit_accounts where user_id=a)=before_a+67;
 assert (select total_granted from public.credit_accounts where user_id=a)=67;
 assert (select count(*) from public.credit_transactions where user_id=a and type='referral_bonus')=5;
 assert (select count(*) from private.referral_rewards where inviter_user_id=a)=5;
 metrics_after:=public.get_admin_metrics(current_date-1,current_date+1);
 assert (metrics_after->>'credits_granted')::numeric-(metrics_before->>'credits_granted')::numeric=737;
 assert metrics_after->'topup_amount_yuan'=metrics_before->'topup_amount_yuan';
 assert metrics_after->'purchase_credits'=metrics_before->'purchase_credits';
 assert metrics_after->'credits_refunded'=metrics_before->'credits_refunded';
 v_count:=(select count(*) from public.credit_transactions where user_id in(a,b));
 r:=public.redeem_credit_code(b,hash);assert (r->>'idempotent')::boolean;
 assert (select count(*) from public.credit_transactions where user_id in(a,b))=v_count;
 assert (select count(*) from private.referral_rewards where inviter_user_id=a)=5;
 r:=public.redeem_credit_code(o,hash);assert r->>'code'='CREDIT_CODE_UNAVAILABLE';

 -- Snapshot totals/pagination are restricted to the supplied server identity.
 r:=public.referral_snapshot(a,2,0);
 assert (r->>'invited_count')::int=1 and (r->>'total_rewards')::numeric=67;
 assert (r->>'rate')::numeric=0.1 and r->>'code'=ac;
 assert jsonb_array_length(r->'records')=2 and (r->>'has_more')::boolean;
 assert r#>>'{records,0,invitee_name}'='直接受邀人';
 assert not (r#>'{records,0}' ?| array['invitee_user_id','email','code_id','code_hash']);
 r:=public.referral_snapshot(a,2,4);assert jsonb_array_length(r->'records')=1 and not(r->>'has_more')::boolean;
 r:=public.referral_snapshot(a,2,100);assert r->'records'='[]'::jsonb;
 r:=public.referral_snapshot(o);assert r->'records'='[]'::jsonb and (r->>'total_rewards')::numeric=0;
 r:=public.referral_snapshot(null);assert r->>'code'='ACCOUNT_FROZEN';
 r:=public.referral_snapshot(a,0,0);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.referral_snapshot(a,101,0);assert r->>'code'='INVALID_REFERRAL_INPUT';
 r:=public.referral_snapshot(a,20,-1);assert r->>'code'='INVALID_REFERRAL_INPUT';

 -- Only the direct inviter earns; a reward never recursively rewards another.
 batch:=gen_random_uuid();hash:=repeat('d',64);
 r:=public.create_credit_code_batch(o,batch,'pf20',1,'direct only',repeat('b',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',hash,'suffix','BBBB')));
 r:=public.redeem_credit_code(c,hash);assert (r->>'ok')::boolean;
 assert (select balance from public.credit_accounts where user_id=b)=before_b+672;
 assert (select balance from public.credit_accounts where user_id=a)=before_a+67;
 assert (select count(*) from private.referral_rewards where invitee_user_id=c and inviter_user_id=b)=1;
 -- Users with no relation still receive full voucher value, with no reward.
 batch:=gen_random_uuid();hash:=repeat('e',64);
 r:=public.create_credit_code_batch(o,batch,'pf20',1,'no referral',repeat('b',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',hash,'suffix','CCCC')));
 r:=public.redeem_credit_code(n,hash);assert (r->>'ok')::boolean;
 assert (select balance from public.credit_accounts where user_id=n)=20;
 assert not exists(select 1 from private.referral_rewards where invitee_user_id=n);

 -- Frozen/unverified invitees cannot redeem or reward the inviter.
 update public.profiles set status='frozen' where id=b;
 r:=public.redeem_credit_code(b,repeat('d',64));assert r->>'code'='ACCOUNT_FROZEN';
 update public.profiles set status='active' where id=b;
 update auth.users set email_confirmed_at=null where id=b;
 r:=public.redeem_credit_code(b,repeat('d',64));assert r->>'code'='EMAIL_UNVERIFIED';
 update auth.users set email_confirmed_at=now() where id=b;
end;
$$;

-- Forced award-ledger failure proves full transaction atomicity, including the
-- invitee purchase, both balances, voucher state, event, and reward fact.
create function pg_temp.reject_referral_bonus() returns trigger language plpgsql as $$
begin if new.type='referral_bonus' then raise exception 'fixture reward ledger failure';end if;return new;end;
$$;
create trigger fixture_reject_referral before insert on public.credit_transactions
  for each row execute function pg_temp.reject_referral_bonus();
do $$
declare
 a uuid:='d1000000-0000-4000-8000-000000000001';b uuid:='d1000000-0000-4000-8000-000000000002';
 o uuid:='d1000000-0000-4000-8000-000000000004';batch uuid:=gen_random_uuid();card uuid;r jsonb;
 ab numeric;bb numeric;tx bigint;rewards bigint;
begin
 r:=public.create_credit_code_batch(o,batch,'pf20',1,'atomic award',repeat('c',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',repeat('f',64),'suffix','DDDD')));
 select id into card from public.credit_codes where batch_id=batch;
 select balance into ab from public.credit_accounts where user_id=a;
 select balance into bb from public.credit_accounts where user_id=b;
 select count(*) into tx from public.credit_transactions;
 select count(*) into rewards from private.referral_rewards;
 begin
   perform public.redeem_credit_code(b,repeat('f',64));raise exception 'expected award ledger failure';
 exception when others then assert sqlerrm='fixture reward ledger failure',sqlerrm;end;
 assert (select balance from public.credit_accounts where user_id=a)=ab;
 assert (select balance from public.credit_accounts where user_id=b)=bb;
 assert (select status from public.credit_codes where id=card)='ready';
 assert not exists(select 1 from public.credit_code_events where code_id=card);
 assert (select count(*) from public.credit_transactions)=tx;
 assert (select count(*) from private.referral_rewards)=rewards;
end;
$$;
drop trigger fixture_reject_referral on public.credit_transactions;

do $$
declare
 a uuid:='d1000000-0000-4000-8000-000000000001';b uuid:='d1000000-0000-4000-8000-000000000002';
 n uuid:='d1000000-0000-4000-8000-000000000006';ac text;r jsonb;ab numeric;bb numeric;
begin
 select code into ac from private.referral_codes where user_id=a;
 -- Frozen inviters may accrue earned credits, without blocking redemption.
 update public.profiles set status='frozen' where id=a;
 select balance into ab from public.credit_accounts where user_id=a;
 r:=public.redeem_credit_code(b,repeat('f',64));assert (r->>'ok')::boolean;
 assert (select balance from public.credit_accounts where user_id=a)=ab+2;
 update public.profiles set status='active' where id=a;

 -- Deletion does not remove the email marker, old attribution, or reward facts.
 delete from auth.users where id=n;
 begin
   insert into auth.users(id,email,raw_user_meta_data) values('d1000000-0000-4000-8000-000000000021',' NO-REFERRAL@EXAMPLE.INVALID ',jsonb_build_object('referral_code',ac));
   raise exception 'expected old email referral rejected';
 exception when invalid_parameter_value then assert sqlerrm='REFERRAL_CODE_INVALID';end;
 insert into auth.users(id,email,raw_user_meta_data) values('d1000000-0000-4000-8000-000000000021','no-referral@example.invalid','{}');
 assert not exists(select 1 from private.referral_bindings where invitee_user_id='d1000000-0000-4000-8000-000000000021');
 update auth.users set email='changed-email@example.invalid' where id='d1000000-0000-4000-8000-000000000021';
 delete from auth.users where id='d1000000-0000-4000-8000-000000000021';
 begin
   insert into auth.users(id,email,raw_user_meta_data) values('d1000000-0000-4000-8000-000000000022','changed-email@example.invalid',jsonb_build_object('referral_code',ac));
   raise exception 'expected changed old email rejected';
 exception when invalid_parameter_value then assert sqlerrm='REFERRAL_CODE_INVALID';end;
 delete from auth.users where id=b;
 assert exists(select 1 from private.referral_bindings where invitee_user_id=b and inviter_user_id=a);
 r:=public.referral_snapshot(a);assert r#>>'{records,0,invitee_name}'='已注销用户';
 begin
   insert into auth.users(id,email,raw_user_meta_data) values('d1000000-0000-4000-8000-000000000022','invitee@example.invalid',jsonb_build_object('referral_code',ac));
   raise exception 'expected deleted invitee cannot rebind';
 exception when invalid_parameter_value then assert sqlerrm='REFERRAL_CODE_INVALID';end;
 -- B was C's inviter. C still redeems when B's account has been deleted.
 r:=public.create_credit_code_batch(a,gen_random_uuid(),'pf20',1,'deleted inviter',repeat('c',64),'synthetic',jsonb_build_array(jsonb_build_object('hash',repeat('9',64),'suffix','EEEE')));
 assert (r->>'ok')::boolean;
 select balance into bb from public.credit_accounts where user_id='d1000000-0000-4000-8000-000000000003';
 r:=public.redeem_credit_code('d1000000-0000-4000-8000-000000000003',repeat('9',64));assert (r->>'ok')::boolean;
 assert (select balance from public.credit_accounts where user_id='d1000000-0000-4000-8000-000000000003')=bb+20;
 assert not exists(select 1 from private.referral_rewards where code_id=(select id from public.credit_codes where code_hash=repeat('9',64)));
end;
$$;

do $$
declare t text;f text;r text;
begin
 foreach t in array array['referral_codes','referral_bindings','referral_email_claims','referral_rewards'] loop
   assert (select relrowsecurity from pg_class where oid=('private.'||t)::regclass);
   foreach r in array array['anon','authenticated','service_role'] loop
     assert not has_table_privilege(r,'private.'||t,'SELECT,INSERT,UPDATE,DELETE');
   end loop;
 end loop;
 foreach f in array array['public.referral_snapshot(uuid,integer,integer)','private.referral_snapshot(uuid,integer,integer)',
   'public.validate_referral_code(text)','private.validate_referral_code(text)'] loop
   assert not has_function_privilege('anon',f,'EXECUTE');
   assert not has_function_privilege('authenticated',f,'EXECUTE');
   assert has_function_privilege('service_role',f,'EXECUTE');
 end loop;
 assert not has_function_privilege('authenticated','private.ensure_referral_code(uuid)','EXECUTE');
 assert not has_function_privilege('service_role','private.prevent_referral_rebind()','EXECUTE');
 assert not has_function_privilege('anon','public.handle_new_user()','EXECUTE');
 assert not has_function_privilege('authenticated','public.redeem_credit_code(uuid,text)','EXECUTE');
 assert has_function_privilege('service_role','public.redeem_credit_code(uuid,text)','EXECUTE');
end;
$$;
rollback;
