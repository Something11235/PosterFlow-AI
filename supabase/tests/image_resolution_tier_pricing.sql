begin;
insert into auth.users(id,email,email_confirmed_at) values('55559999-1111-4111-8111-111111111111','tiers@example.invalid',now());
select public.ensure_signup_bonus('55559999-1111-4111-8111-111111111111');
update public.credit_accounts set balance=100 where user_id='55559999-1111-4111-8111-111111111111';
do $$
declare u uuid:='55559999-1111-4111-8111-111111111111'; owner text:='user-'||u::text;rid uuid;r jsonb;tok uuid:=gen_random_uuid();j uuid;model text;res text;b numeric;
begin
 if private.image_tier_cost('seedream-5-5','1K',8)<>1 or private.image_tier_cost('seedream-5-5','1.5K',0)<>1 or private.image_tier_cost('seedream-5-5','2K',8)<>1.5 then raise exception '55 price';end if;
 if private.image_tier_cost('seedream-5-0-pro','1.5K',2)<>2 or private.image_tier_cost('seedream-5-0-pro','2K',0)<>2.5 then raise exception 'pro price';end if;
 if private.image_tier_cost('gpt-image-2.6-flare','4K',1)<>2.5 or private.image_tier_cost('gpt-image-2.5-flare','4K',1)<>2 then raise exception 'GPT reference price';end if;
 foreach model in array array['gemini-nano-banana-2.1','grok-imagine-image-2.0','seedream-5-0-pro','seedream-5-5'] loop
  rid:=gen_random_uuid();res:=case when model='gemini-nano-banana-2.1' then '4K' else '2K' end;
  select balance into b from public.credit_accounts where user_id=u;
  r:=public.begin_image_tier_job(owner,u,rid,'platform',model,1,repeat('c',64),'fixture',1,res);
  if not (r->>'ok')::boolean or (r->'job'->>'unit_credit_cost')::numeric<>private.image_tier_cost(model,res,1) then raise exception 'reserve %: %',model,r;end if;
  j:=(r->'job'->>'generation_job_id')::uuid;
  perform public.apply_image_tier_job(owner,rid,'submitted','task_tier_fixture');
  perform public.apply_image_tier_job(owner,rid,'claim',null,'[]',tok);
  perform public.apply_image_tier_job(owner,rid,'completed',null,'["fixture.png"]',tok);
  if (select charged_credits from public.generation_jobs where id=j)<>private.image_tier_cost(model,res,1) then raise exception 'settle %',model;end if;
 end loop;
 rid:=gen_random_uuid();
 r:=public.begin_buytoken_image_tier_job(owner,u,rid,'platform','gpt-image-2.6-sunburst',4,repeat('e',64),'fixture',1,'4K');
 if (r->'job'->>'unit_credit_cost')::numeric<>2.5 then raise exception 'BuyToken reserve: %',r;end if;
 perform public.apply_buytoken_image_tier_job(owner,rid,'sending');
 perform public.apply_buytoken_image_tier_job(owner,rid,'received','["https://example.invalid/1.png","https://example.invalid/2.png"]');
 perform public.apply_buytoken_image_tier_job(owner,rid,'claim','[]','[]',tok);
 perform public.apply_buytoken_image_tier_job(owner,rid,'completed','[]','["one.png","two.png"]',tok);
 if (select charged_credits from public.generation_jobs where id=(r->'job'->>'generation_job_id')::uuid)<>5 then raise exception 'partial charge';end if;
 r:=public.reserve_legacy_image_tier_credits(u,gen_random_uuid(),1,'api.buytoken.work','gpt-image-2.5-flare','fixture','2K');
 if not (r->>'ok')::boolean then raise exception 'legacy reserve %',r;end if;
 perform public.settle_image_tier_generation((r->>'job_id')::uuid,1,1000,'["legacy.png"]');
 if (select charged_credits from public.generation_jobs where id=(r->>'job_id')::uuid)<>1.5 then raise exception 'legacy settle';end if;
 update public.credit_accounts set balance=1 where user_id=u;
 rid:=gen_random_uuid();
 r:=public.begin_image_tier_job(owner,u,rid,'platform','gemini-nano-banana-2.1',1,repeat('a',64),'fixture',0,'2K');
 if r->>'code'<>'CREDITS_INSUFFICIENT' or exists(select 1 from public.generation_jobs where request_id=rid) or (select balance from public.credit_accounts where user_id=u)<>1 then raise exception 'atomic insufficient balance';end if;
 r:=public.begin_buytoken_image_tier_job(owner,u,gen_random_uuid(),'own_key','gpt-image-2.6-flare',4,repeat('f',64),'fixture',2,'4K');
 if (r->'job'->>'unit_credit_cost')::numeric<>0 or (select balance from public.credit_accounts where user_id=u)<>1 then raise exception 'own key';end if;
 -- Old jobs retain their original snapshots even through the new BuyToken API.
 update public.credit_accounts set balance=100 where user_id=u;
 rid:=gen_random_uuid();
 r:=public.begin_buytoken_gpt26_image_job(owner,u,rid,'platform','gpt-image-2.6-flare',1,repeat('b',64),'old fixture',1,'1K');
 if (r->'job'->>'pricing_policy_version')::integer<>1 then raise exception 'old policy';end if;
 perform public.apply_buytoken_image_tier_job(owner,rid,'sending');
 perform public.apply_buytoken_image_tier_job(owner,rid,'received','["https://example.invalid/old.png"]');
 perform public.apply_buytoken_image_tier_job(owner,rid,'claim','[]','[]',tok);
 perform public.apply_buytoken_image_tier_job(owner,rid,'completed','[]','["old.png"]',tok);
 if (select charged_credits from public.generation_jobs where id=(r->'job'->>'generation_job_id')::uuid)<>1.5 then raise exception 'old BuyToken snapshot changed';end if;
 rid:=gen_random_uuid();
 r:=public.begin_apimart_image_job_v3(owner,u,rid,'platform','gemini-nano-banana-2.1',1,repeat('d',64),'old fixture',0,'2K');
 perform public.apply_image_job_v3(owner,rid,'submitted','task_old_fixture');
 perform public.apply_image_job_v3(owner,rid,'claim',null,'[]',tok);
 perform public.apply_image_job_v3(owner,rid,'completed',null,'["old-nano.png"]',tok);
 if (select charged_credits from public.generation_jobs where id=(r->'job'->>'generation_job_id')::uuid)<>1 then raise exception 'old Nano 2K snapshot changed';end if;
 -- Refund uses reserved credits, including the extra tier reservation, exactly once.
 select balance into b from public.credit_accounts where user_id=u;
 r:=public.reserve_legacy_image_tier_credits(u,gen_random_uuid(),4,'api.buytoken.work','gpt-image-2.5-flare','fixture','4K');
 j:=(r->>'job_id')::uuid;
 perform public.refund_generation(j,'fixture rejected');
 perform public.refund_generation(j,'fixture rejected');
 if (select balance from public.credit_accounts where user_id=u)<>b then raise exception 'legacy tier refund mismatch';end if;
end;$$;
do $$
declare row record;
begin
 for row in select p.oid,p.proname,p.prosecdef,p.proconfig,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('private','public') and p.proname in ('image_tier_cost','adjust_image_tier_reservation','begin_image_tier_job','begin_buytoken_image_tier_job','reserve_legacy_image_tier_credits','settle_image_tier_generation','refund_image_tier_generation','apply_image_tier_job','apply_buytoken_image_tier_job') loop
  if has_function_privilege('anon',row.oid,'execute') or has_function_privilege('authenticated',row.oid,'execute') or not has_function_privilege('service_role',row.oid,'execute') then raise exception 'unsafe tier permissions %',row.proname;end if;
  if row.nspname='public' and row.prosecdef then raise exception 'public definer %',row.proname;end if;
  if row.proconfig is null or not ('search_path=""'=any(row.proconfig)) then raise exception 'unsafe search path %',row.proname;end if;
 end loop;
end;$$;
rollback;
