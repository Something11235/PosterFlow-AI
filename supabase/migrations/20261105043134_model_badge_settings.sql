-- Local only: shared presentation metadata; no model prices or jobs change.
create table private.model_badge_settings (
 singleton boolean primary key default true check(singleton),
 revision bigint not null default 1 check(revision>0),
 badges jsonb not null check(jsonb_typeof(badges)='object'),
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now()
);
alter table private.model_badge_settings enable row level security;
revoke all on table private.model_badge_settings from public,anon,authenticated;
insert into private.model_badge_settings(badges) values ('{"gpt-image-2.5-flare":"hot","gpt-image-2.5-sunburst":"hot","gpt-image-2":"","gemini-nano-banana-2.1":"","grok-imagine-image-2.0":"","grok-imagine-2.0-ext":"","seedream-5-0-pro":"new","seedream-5-0-lite":"new","seedream-5-0-flash":"new"}');

create function private.get_model_badges() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('revision',revision,'badges',badges) from private.model_badge_settings where singleton;
$$;
create function public.get_model_badges() returns jsonb language sql stable security invoker set search_path='' as $$
 select private.get_model_badges();
$$;
create function private.update_model_badges(p_admin uuid,p_revision bigint,p_badges jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 -- Flask verifies configured administrator allow-list / profile role. Only
 -- service_role can reach this RPC; recheck active profile here as well.
 if not exists(select 1 from public.profiles where id=p_admin and status='active' and deleted_at is null) then
  return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED');end if;
 if p_revision is null or p_revision<1 or p_badges is null or jsonb_typeof(p_badges)<>'object' or octet_length(p_badges::text)>8192 then
  return jsonb_build_object('ok',false,'code','MODEL_BADGES_INVALID');end if;
 if (select count(*) from jsonb_each(p_badges))>100 or exists(select 1 from jsonb_each(p_badges) where key!~'^[A-Za-z0-9._-]{1,80}$' or jsonb_typeof(value)<>'string' or value#>>'{}' not in ('','new','hot')) then
  return jsonb_build_object('ok',false,'code','MODEL_BADGES_INVALID');end if;
 select revision into current_revision from private.model_badge_settings where singleton for update;
 if current_revision is distinct from p_revision then return jsonb_build_object('ok',false,'code','MODEL_BADGES_CONFLICT');end if;
 update private.model_badge_settings set badges=p_badges,revision=revision+1,updated_by=p_admin,updated_at=now() where singleton returning revision into current_revision;
 return jsonb_build_object('ok',true,'revision',current_revision,'badges',p_badges);
end;
$$;
create function public.update_model_badges(p_admin uuid,p_revision bigint,p_badges jsonb) returns jsonb language sql security invoker set search_path='' as $$
 select private.update_model_badges(p_admin,p_revision,p_badges);
$$;
revoke all on function private.get_model_badges(),public.get_model_badges(),private.update_model_badges(uuid,bigint,jsonb),public.update_model_badges(uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function private.get_model_badges(),public.get_model_badges(),private.update_model_badges(uuid,bigint,jsonb),public.update_model_badges(uuid,bigint,jsonb) to service_role;
