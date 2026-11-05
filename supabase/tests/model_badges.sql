-- Synthetic isolated database fixtures only. Never run against production.
begin;
insert into auth.users(id,email,email_confirmed_at) values('77777777-7777-4777-8777-777777777777','badges@example.invalid',now());
select public.ensure_signup_bonus('77777777-7777-4777-8777-777777777777');
do $$
declare r jsonb;initial jsonb;draft jsonb;u uuid:='77777777-7777-4777-8777-777777777777';b numeric;
begin
 initial:=public.get_model_badges();
 if initial->>'revision'<>'1' or (select count(*) from jsonb_each_text(initial->'badges') where value='hot')<>2 or (select count(*) from jsonb_each_text(initial->'badges') where value='new')<>3 then raise exception 'bad defaults %',initial;end if;
 if initial ? 'updated_by' or initial ? 'updated_at' then raise exception 'private metadata exposed';end if;
 select balance into b from public.credit_accounts where user_id=u;
 draft:=jsonb_set(initial->'badges','{seedream-5-0-pro}','""'::jsonb);
 r:=public.update_model_badges('88888888-8888-4888-8888-888888888888',1,draft);
 if r->>'code'<>'ADMIN_REQUIRED' then raise exception 'inactive profile accepted';end if;
 update public.profiles set status='frozen' where id=u;
 r:=public.update_model_badges(u,1,draft);
 if r->>'code'<>'ADMIN_REQUIRED' then raise exception 'frozen profile accepted';end if;
 update public.profiles set status='active' where id=u;
 r:=public.update_model_badges(u,1,'[]');
 if r->>'code'<>'MODEL_BADGES_INVALID' then raise exception 'array accepted';end if;
 r:=public.update_model_badges(u,1,'{"seedream-5-0-pro":"<script>"}');
 if r->>'code'<>'MODEL_BADGES_INVALID' then raise exception 'arbitrary text accepted';end if;
 r:=public.update_model_badges(u,1,draft);
 if r->>'ok'<>'true' or r->>'revision'<>'2' or r->'badges'<>draft then raise exception 'save failed %',r;end if;
 if public.get_model_badges()->'badges'<>draft or public.get_model_badges()->>'revision'<>'2' then raise exception 'not persisted';end if;
 r:=public.update_model_badges(u,1,initial->'badges');
 if r->>'code'<>'MODEL_BADGES_CONFLICT' or public.get_model_badges()->'badges'<>draft then raise exception 'lost update';end if;
 if (select balance from public.credit_accounts where user_id=u)<>b then raise exception 'credits modified';end if;
 if has_table_privilege('anon','private.model_badge_settings','SELECT') or has_table_privilege('authenticated','private.model_badge_settings','UPDATE') then raise exception 'table exposed';end if;
 if has_function_privilege('anon','public.get_model_badges()','execute') or has_function_privilege('authenticated','public.update_model_badges(uuid,bigint,jsonb)','execute') or has_function_privilege('authenticated','private.update_model_badges(uuid,bigint,jsonb)','execute') then raise exception 'client RPC exposed';end if;
 if not has_function_privilege('service_role','public.get_model_badges()','execute') or not has_function_privilege('service_role','public.update_model_badges(uuid,bigint,jsonb)','execute') then raise exception 'server RPC unavailable';end if;
end;$$;
set local role service_role;
select public.get_model_badges();
reset role;
rollback;
