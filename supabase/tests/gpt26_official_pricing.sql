-- Synthetic in-memory fixtures only. Never execute against hosted projects.
begin;
insert into auth.users(id,email,email_confirmed_at)
values('98989898-9898-4989-8989-989898989898','official-fixture@example.invalid',now());
select public.ensure_signup_bonus('98989898-9898-4989-8989-989898989898');
update public.credit_accounts set balance=100 where user_id='98989898-9898-4989-8989-989898989898';
do $$
declare u uuid:='98989898-9898-4989-8989-989898989898'; req uuid; r jsonb; t uuid; m text; refs integer; price numeric; b numeric; gid uuid; requested integer; output_images jsonb;
begin
 foreach m in array array['gpt-image-2.6-flare','gpt-image-2.6-sunburst'] loop
  foreach refs in array array[0,1,8] loop
   price:=case when refs=0 then 1 else 1.5 end;
   select balance into b from public.credit_accounts where user_id=u;
   req:=gen_random_uuid();
   r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',refs,'1K');
   if r->>'ok'<>'true' or (r->>'balance')::numeric<>b-price or (r->'job'->>'unit_credit_cost')::numeric<>price then raise exception 'official price reserve %',r; end if;
   gid:=(r->'job'->>'generation_job_id')::uuid;
   if (select reserved_credits from public.generation_jobs where id=gid)<>price then raise exception 'ledger reservation differs';end if;
   r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',refs,'1K');
   if r->>'existing'<>'true' or (r->>'balance')::numeric<>b-price then raise exception 'duplicate charged';end if;
   r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform',m,1,repeat('a',64),'fixture',case when refs=0 then 1 else 0 end,'1K');
   if r->>'code'<>'IMAGE_REQUEST_CONFLICT' then raise exception 'reference-price change reused request';end if;
   r:=public.apply_image_job_v3('user-'||u,req,'submitted','task_official_fixture');
   r:=public.apply_image_job_v3('user-'||u,req,'unknown');
   if (select balance from public.credit_accounts where user_id=u)<>b-price then raise exception 'unknown refunded';end if;
   t:=gen_random_uuid();r:=public.apply_image_job_v3('user-'||u,req,'claim',null,'[]',t);
   r:=public.apply_image_job_v3('user-'||u,req,'completed',null,'["fixture.png"]',t);
   if r->'job'->>'status'<>'completed' or (select charged_credits from public.generation_jobs where id=gid)<>price then raise exception 'settlement mismatch %',r;end if;
   r:=public.apply_image_job_v3('user-'||u,req,'failed');
   if (r->>'balance')::numeric<>b-price then raise exception 'late failure refunded';end if;
  end loop;
 end loop;
 select balance into b from public.credit_accounts where user_id=u;
 req:=gen_random_uuid();
 r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform','gpt-image-2.6-flare',1,repeat('b',64),'fixture',1,'1K');
 r:=public.apply_image_job_v3('user-'||u,req,'failed',null,'[]',null,'REFERENCE_UPLOAD_FAILED');
 r:=public.apply_image_job_v3('user-'||u,req,'failed');
 if (r->>'balance')::numeric<>b then raise exception 'fractional refund not exact/idempotent';end if;
 req:=gen_random_uuid();
 r:=public.begin_gpt26_image_job_v2('own-key-fixture',null,req,'own_key','gpt-image-2.6-sunburst',1,repeat('c',64),'fixture',8,'1K');
 if r->>'ok'<>'true' or (r->'job'->>'unit_credit_cost')::numeric<>0 or r->'job'->>'generation_job_id' is not null then raise exception 'guest own key charged';end if;
 r:=public.begin_gpt26_image_job_v2('user-'||u,u,gen_random_uuid(),'own_key','gpt-image-2.6-flare',1,repeat('c',64),'fixture',1,'1K');
 if r->>'ok'<>'true' or (r->'job'->>'unit_credit_cost')::numeric<>0 then raise exception 'signed own key charged';end if;
 r:=public.begin_gpt26_image_job_v2('foreign',u,gen_random_uuid(),'platform','gpt-image-2.6-flare',1,repeat('d',64),'fixture',1,'1K');
 if r->>'code'<>'INVALID_IMAGE_TASK' then raise exception 'owner validation bypass';end if;
 r:=public.begin_gpt26_image_job_v2('user-'||u,u,gen_random_uuid(),'platform','gpt-image-2.6-flare',1,repeat('d',64),'fixture',9,'1K');
 if r->>'code'<>'INVALID_IMAGE_TASK' then raise exception 'reference limit bypass';end if;
 foreach m in array array['gpt-image-2.6-flare','gpt-image-2.6-sunburst'] loop
  foreach requested in array array[2,3,4] loop
   foreach refs in array array[0,1] loop
    select balance into b from public.credit_accounts where user_id=u;
    price:=case when refs=0 then 1 else 1.5 end;
    req:=gen_random_uuid();
    r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform',m,requested,repeat('e',64),'fixture',refs,'1K');
    if r->>'ok'<>'true' or (r->>'balance')::numeric<>b-requested*price or (r->'job'->>'unit_credit_cost')::numeric<>price then raise exception 'batch reserve mismatch %',r;end if;
    gid:=(r->'job'->>'generation_job_id')::uuid;
    r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform',m,requested,repeat('e',64),'fixture',refs,'1K');
    if r->>'existing'<>'true' or (r->>'balance')::numeric<>b-requested*price then raise exception 'batch duplicate charged';end if;
    r:=public.apply_image_job_v3('user-'||u,req,'submitted','task_official_batch');
    t:=gen_random_uuid();r:=public.apply_image_job_v3('user-'||u,req,'claim',null,'[]',t);
    select jsonb_agg('fixture-'||n||'.png') into output_images from generate_series(1,requested) n;
    r:=public.apply_image_job_v3('user-'||u,req,'completed',null,output_images,t);
    if (select charged_credits from public.generation_jobs where id=gid)<>requested*price then raise exception 'batch settlement mismatch %',r;end if;
   end loop;
  end loop;
 end loop;
 select balance into b from public.credit_accounts where user_id=u;
 req:=gen_random_uuid();
 r:=public.begin_gpt26_image_job_v2('user-'||u,u,req,'platform','gpt-image-2.6-flare',4,repeat('f',64),'fixture',1,'1K');
 gid:=(r->'job'->>'generation_job_id')::uuid;
 if (r->>'balance')::numeric<>b-6 then raise exception 'four-image reference reserve not six';end if;
 r:=public.apply_image_job_v3('user-'||u,req,'submitted','task_official_partial');
 t:=gen_random_uuid();r:=public.apply_image_job_v3('user-'||u,req,'claim',null,'[]',t);
 r:=public.apply_image_job_v3('user-'||u,req,'completed',null,'["one.png","two.png"]',t);
 if (select charged_credits from public.generation_jobs where id=gid)<>3 or (r->>'balance')::numeric<>b-3 then raise exception 'partial result not refunded at snapshot price';end if;
 r:=public.apply_image_job_v3('user-'||u,req,'failed');
 if (r->>'balance')::numeric<>b-3 then raise exception 'late failure changed partial settlement';end if;
 foreach requested in array array[0,5] loop
  r:=public.begin_gpt26_image_job_v2('user-'||u,u,gen_random_uuid(),'platform','gpt-image-2.6-flare',requested,repeat('f',64),'fixture',0,'1K');
  if r->>'code'<>'INVALID_IMAGE_TASK' then raise exception 'batch count boundary bypass';end if;
 end loop;
 update public.credit_accounts set balance=1 where user_id=u;
 r:=public.begin_gpt26_image_job_v2('user-'||u,u,gen_random_uuid(),'platform','gpt-image-2.6-flare',1,repeat('d',64),'fixture',1,'1K');
 if r->>'code'<>'CREDITS_INSUFFICIENT' or (select balance from public.credit_accounts where user_id=u)<>1 then raise exception 'under-reserved official edit';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('reserve_gpt26_credits_v2','begin_gpt26_image_job_v2') and (has_function_privilege('anon',p.oid,'execute') or has_function_privilege('authenticated',p.oid,'execute') or not has_function_privilege('service_role',p.oid,'execute'))) then raise exception 'new RPC privilege leak';end if;
end $$;
rollback;
