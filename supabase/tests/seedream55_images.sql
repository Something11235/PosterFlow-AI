begin;
insert into auth.users(id,email,email_confirmed_at) values('55550000-1111-4111-8111-111111111111','seedream55@example.invalid',now());
select public.ensure_signup_bonus('55550000-1111-4111-8111-111111111111');
update public.credit_accounts set balance=20 where user_id='55550000-1111-4111-8111-111111111111';
do $$
declare u uuid:='55550000-1111-4111-8111-111111111111'; owner text:='user-'||u::text;
 rid uuid:='55550000-2222-4222-8222-222222222222'; rid2 uuid:='55550000-3333-4333-8333-333333333333';
 token uuid:='55550000-4444-4444-8444-444444444444';r jsonb;j uuid;b numeric;
begin
 r:=public.begin_seedream55_image_job(owner,u,rid,'platform','seedream-5-5',1,repeat('f',64),'fixture',8,'2K');
 if not (r->>'ok')::boolean or (r->'job'->>'unit_credit_cost')::numeric<>1 or (r->>'balance')::numeric<>19 then raise exception 'reserve price';end if;
 j:=(r->'job'->>'generation_job_id')::uuid;
 r:=public.begin_seedream55_image_job(owner,u,rid,'platform','seedream-5-5',1,repeat('f',64),'fixture',8,'2K');
 if not (r->>'existing')::boolean then raise exception 'idempotence';end if;
 perform public.apply_seedream55_image_job(owner,rid,'submitted','task_seedream55_fixture');
 r:=public.apply_seedream55_image_job(owner,rid,'claim',null,'[]',token);
 if not (r->>'claimed')::boolean then raise exception 'claim';end if;
 perform public.apply_seedream55_image_job(owner,rid,'completed',null,'["fixture.png"]',token);
 perform public.apply_seedream55_image_job(owner,rid,'completed',null,'["fixture.png"]',token);
 if (select charged_credits from public.generation_jobs where id=j)<>1 then raise exception 'settlement price';end if;
 r:=public.begin_seedream55_image_job(owner,u,rid2,'platform','seedream-5-5',1,repeat('e',64),'fixture',0,'1K');
 perform public.apply_seedream55_image_job(owner,rid2,'failed',null,'[]',null,'APIMART_TASK_FAILED');
 perform public.apply_seedream55_image_job(owner,rid2,'failed',null,'[]',null,'APIMART_TASK_FAILED');
 select balance into b from public.credit_accounts where user_id=u;
 if b<>19 then raise exception 'refund';end if;
 r:=public.begin_seedream55_image_job(owner,u,token,'own_key','seedream-5-5',1,repeat('a',64),'fixture',1,'1.5K');
 if (r->'job'->>'unit_credit_cost')::numeric<>0 or (select balance from public.credit_accounts where user_id=u)<>19 then raise exception 'own key';end if;
 r:=public.begin_seedream55_image_job(owner,u,gen_random_uuid(),'platform','seedream-5-5',2,repeat('f',64),'fixture',0,'2K');
 if (r->>'ok')::boolean then raise exception 'batch rejected';end if;
 r:=public.begin_seedream55_image_job(owner,u,gen_random_uuid(),'platform','seedream-5-0-pro',1,repeat('f',64),'fixture',0,'2K');
 if (r->>'ok')::boolean then raise exception 'foreign model rejected';end if;
 if has_function_privilege('anon','public.begin_seedream55_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text)','execute')
 or has_function_privilege('authenticated','public.apply_seedream55_image_job(text,uuid,text,text,jsonb,uuid,text)','execute')
 or not has_function_privilege('service_role','public.apply_seedream55_image_job(text,uuid,text,text,jsonb,uuid,text)','execute') then raise exception 'ACL';end if;
end;$$;
rollback;
