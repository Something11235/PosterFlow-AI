-- Isolated fixtures only. Never run against production.
begin;
insert into auth.users(id,email,email_confirmed_at) values('66666666-6666-4666-8666-666666666666','seedream@example.invalid',now());
select public.ensure_signup_bonus('66666666-6666-4666-8666-666666666666');
update public.credit_accounts set balance=100.25 where user_id='66666666-6666-4666-8666-666666666666';
do $$
declare u uuid:='66666666-6666-4666-8666-666666666666';req uuid;r jsonb;gid uuid;t uuid;b numeric;cost numeric;m text;res text;
begin
 foreach m in array array['seedream-5-0-pro','seedream-5-0-lite','seedream-5-0-flash'] loop
  cost:=case m when 'seedream-5-0-pro' then 2 when 'seedream-5-0-lite' then 1 else 0.5 end;
  res:=case when m='seedream-5-0-lite' then '4K' else '1.5K' end;
  select balance into b from public.credit_accounts where user_id=u;
  req:=gen_random_uuid();
  r:=public.begin_seedream_image_job('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',8,res);
  if r->>'ok'<>'true' or (r->>'balance')::numeric<>b-cost or (r->'job'->>'unit_credit_cost')::numeric<>cost then raise exception 'reserve mismatch %',r;end if;
  gid:=(r->'job'->>'generation_job_id')::uuid;
  r:=public.begin_seedream_image_job('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',8,res);
  if r->>'existing'<>'true' or (r->>'balance')::numeric<>b-cost then raise exception 'duplicate reserve';end if;
  r:=public.begin_seedream_image_job('user-'||u,u,req,'platform',m,1,repeat('b',64),'fixture',8,res);
  if r->>'code'<>'IMAGE_REQUEST_CONFLICT' then raise exception 'conflict ignored';end if;
  r:=public.apply_image_job_v2('foreign',req,'failed');if r->>'code'<>'IMAGE_TASK_NOT_FOUND' then raise exception 'owner bypass';end if;
  r:=public.apply_image_job_v2('user-'||u,req,'submitted','task_seedream_fixture');
  r:=public.apply_image_job_v2('user-'||u,req,'unknown');
  if (select balance from public.credit_accounts where user_id=u)<>b-cost then raise exception 'unknown refunded';end if;
  t:=gen_random_uuid();r:=public.apply_image_job_v2('user-'||u,req,'claim',null,'[]',t);
  r:=public.apply_image_job_v2('user-'||u,req,'completed',null,'["seedream.png"]',t);
  if r->'job'->>'status'<>'completed' or (select charged_credits from public.generation_jobs where id=gid)<>cost then raise exception 'settlement wrong %',r;end if;
  r:=public.apply_image_job_v2('user-'||u,req,'failed');
  if (r->>'balance')::numeric<>b-cost then raise exception 'late failure refunded';end if;
  req:=gen_random_uuid();r:=public.begin_seedream_image_job('user-'||u,u,req,'platform',m,1,repeat('c',64),'fixture',0,res);
  r:=public.apply_image_job_v2('user-'||u,req,'failed',null,'[]',null,'fixture_failed');
  r:=public.apply_image_job_v2('user-'||u,req,'failed');
  if (r->>'balance')::numeric<>b-cost then raise exception 'refund not exact/idempotent';end if;
  r:=public.begin_seedream_image_job('guest-own-key',null,gen_random_uuid(),'own_key',m,1,repeat('d',64),'fixture',0,res);
  if r->>'ok'<>'true' or (r->'job'->>'unit_credit_cost')::numeric<>0 then raise exception 'own-key charged';end if;
 end loop;
 -- Lite partial results must refund precisely at its own snapshot price.
 select balance into b from public.credit_accounts where user_id=u;
 req:=gen_random_uuid();r:=public.begin_seedream_image_job('user-'||u,u,req,'platform','seedream-5-0-lite',4,repeat('e',64),'fixture',0,'3K');
 gid:=(r->'job'->>'generation_job_id')::uuid;
 r:=public.apply_image_job_v2('user-'||u,req,'submitted','task_seedream_partial');t:=gen_random_uuid();r:=public.apply_image_job_v2('user-'||u,req,'claim',null,'[]',t);
 r:=public.apply_image_job_v2('user-'||u,req,'completed',null,'["one.png","two.png"]',t);
 if (r->>'balance')::numeric<>b-2 or (select charged_credits from public.generation_jobs where id=gid)<>2 then raise exception 'partial result price';end if;
 r:=public.begin_seedream_image_job('user-'||u,u,gen_random_uuid(),'platform','seedream-5-0-flash',2,repeat('f',64),'fixture',0,'1K');
 if r->>'ok'='true' then raise exception 'single-image count accepted';end if;
 update public.credit_accounts set balance=0.25 where user_id=u;
 r:=public.begin_seedream_image_job('user-'||u,u,gen_random_uuid(),'platform','seedream-5-0-flash',1,repeat('f',64),'fixture',0,'1K');
 if r->>'code'<>'CREDITS_INSUFFICIENT' then raise exception 'balance bypass';end if;
 if has_function_privilege('anon','public.begin_seedream_image_job(text,uuid,uuid,text,text,integer,text,text,integer,text)','execute') or has_function_privilege('authenticated','public.apply_image_job_v2(text,uuid,text,text,jsonb,uuid,text)','execute') then raise exception 'public billing API';end if;
end;$$;
rollback;
