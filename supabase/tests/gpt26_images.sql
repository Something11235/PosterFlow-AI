-- Synthetic local fixtures only. Never run against production.
begin;
insert into auth.users(id,email,email_confirmed_at) values('99999999-9999-4999-8999-999999999999','gpt26@example.invalid',now());
select public.ensure_signup_bonus('99999999-9999-4999-8999-999999999999');
update public.credit_accounts set balance=10.5 where user_id='99999999-9999-4999-8999-999999999999';
do $$
declare u uuid:='99999999-9999-4999-8999-999999999999';req uuid;r jsonb;m text;gid uuid;t uuid;b numeric;v text;
begin
 foreach m in array array['gpt-image-2.6-flare','gpt-image-2.6-sunburst'] loop
  select balance into b from public.credit_accounts where user_id=u;
  req:=gen_random_uuid();
  r:=public.begin_gpt26_image_job('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',8,'1K');
  if r->>'ok'<>'true' or (r->>'balance')::numeric<>b-1 or r->'job'->>'model'<>m or (r->'job'->>'unit_credit_cost')::numeric<>1 then raise exception 'reserve %',r;end if;
  gid:=(r->'job'->>'generation_job_id')::uuid;
  r:=public.begin_gpt26_image_job('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',8,'1K');
  if r->>'existing'<>'true' or (r->>'balance')::numeric<>b-1 then raise exception 'duplicate charged';end if;
  r:=public.begin_gpt26_image_job('user-'||u,u,req,'platform',case when m like '%flare' then 'gpt-image-2.6-sunburst' else 'gpt-image-2.6-flare' end,1,repeat('a',64),'fixture',8,'1K');
  if r->>'code'<>'IMAGE_REQUEST_CONFLICT' then raise exception 'version request conflict bypass';end if;
  r:=public.apply_image_job_v3('foreign',req,'failed');if r->>'code'<>'IMAGE_TASK_NOT_FOUND' then raise exception 'owner bypass';end if;
  r:=public.apply_image_job_v3('user-'||u,req,'submitted','task_gpt26_fixture');
  r:=public.apply_image_job_v3('user-'||u,req,'unknown');
  if (select balance from public.credit_accounts where user_id=u)<>b-1 then raise exception 'unknown refunded';end if;
  t:=gen_random_uuid();r:=public.apply_image_job_v3('user-'||u,req,'claim',null,'[]',t);
  r:=public.apply_image_job_v3('user-'||u,req,'completed',null,'["gpt26.png"]',t);
  if r->'job'->>'status'<>'completed' or (select charged_credits from public.generation_jobs where id=gid)<>1 then raise exception 'settle %',r;end if;
  r:=public.apply_image_job_v3('user-'||u,req,'failed');
  if (r->>'balance')::numeric<>b-1 then raise exception 'late refund';end if;
  req:=gen_random_uuid();r:=public.begin_gpt26_image_job('user-'||u,u,req,'platform',m,1,repeat('b',64),'fixture',0,'1K');
  r:=public.apply_image_job_v3('user-'||u,req,'failed',null,'[]',null,'fixture');
  r:=public.apply_image_job_v3('user-'||u,req,'failed');
  if (r->>'balance')::numeric<>b-1 then raise exception 'refund not idempotent';end if;
  req:=gen_random_uuid();r:=public.begin_gpt26_image_job('own-key-fixture',null,req,'own_key',m,1,repeat('c',64),'fixture',0,'1K');
  if r->>'ok'<>'true' or (r->'job'->>'unit_credit_cost')::numeric<>0 then raise exception 'BYOK charged';end if;
  r:=public.apply_image_job_v3('own-key-fixture',req,'submitted','task_gpt26_ownkey');t:=gen_random_uuid();
  r:=public.apply_image_job_v3('own-key-fixture',req,'claim',null,'[]',t);
  r:=public.apply_image_job_v3('own-key-fixture',req,'completed',null,'["own.png"]',t);
  if r->'job'->>'status'<>'completed' then raise exception 'guest cannot complete';end if;
  r:=public.begin_gpt26_image_job('user-'||u,u,gen_random_uuid(),'platform',m,2,repeat('d',64),'fixture',0,'1K');
  if r->>'ok'='true' then raise exception 'batch >1 accepted';end if;
  foreach v in array array['2K','4K','1k'] loop
   r:=public.begin_gpt26_image_job('user-'||u,u,gen_random_uuid(),'platform',m,1,repeat('e',64),'fixture',0,v);
   if r->>'ok'='true' then raise exception 'resolution guard bypass';end if;
  end loop;
 end loop;
 if has_function_privilege('anon','public.begin_gpt26_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text)','execute') or has_function_privilege('authenticated','public.apply_image_job_v3(text,uuid,text,text,jsonb,uuid,text)','execute') then raise exception 'client billing grant';end if;
 if not has_function_privilege('service_role','public.begin_gpt26_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text)','execute') then raise exception 'service role missing';end if;
 r:=public.get_model_badges();
 if r->'badges' ? 'gpt-image-2' or r->'badges'->>'gpt-image-2.6-flare'<>'hot' or r->'badges'->>'gpt-image-2.6-sunburst'<>'hot' or (select count(*) from jsonb_each_text(r->'badges') where value='hot')<>2 then raise exception 'hot badges incorrect %',r;end if;
end;$$;
rollback;
