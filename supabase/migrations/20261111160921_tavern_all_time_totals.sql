-- Lifetime platform usage. Read-only; billing and historical rows stay intact.
create function private.admin_tavern_totals(p_actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare stats jsonb;
begin
 if not exists(select 1 from public.profiles p join auth.users a on a.id=p.id
   where p.id=p_actor_id and p.role='admin' and p.status='active' and p.deleted_at is null and a.email_confirmed_at is not null) then
  return jsonb_build_object('ok',false,'code','ADMIN_REQUIRED'); end if;
 select jsonb_build_object(
   'requests',count(*),'users',count(distinct user_id),
   'chat',count(*) filter(where kind='chat'),
   'summary',count(*) filter(where kind='summary'),
   'assist',count(*) filter(where kind='assist'),
   'credits_spent',coalesce(sum(charged_credits) filter(where billing_status='settled'),0)::text)
 into stats from public.tavern_requests;
 return jsonb_build_object('ok',true,'scope','all','stats',stats);
end; $$;
create function public.admin_tavern_totals(p_actor_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$ select private.admin_tavern_totals(p_actor_id); $$;
revoke all on function private.admin_tavern_totals(uuid),public.admin_tavern_totals(uuid) from public,anon,authenticated;
grant execute on function private.admin_tavern_totals(uuid),public.admin_tavern_totals(uuid) to service_role;
