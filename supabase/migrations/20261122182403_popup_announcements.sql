set local lock_timeout = '5s';

alter table public.announcements
  add column is_popup boolean not null default false;

create index announcements_active_popup_idx
  on public.announcements (published_at desc nulls last, created_at desc, id)
  where is_popup and status = 'published' and deleted_at is null;

create table private.announcement_acknowledgements (
  user_id uuid not null references auth.users(id) on delete cascade,
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, announcement_id)
);
create index announcement_acknowledgements_announcement_idx
  on private.announcement_acknowledgements (announcement_id);
alter table private.announcement_acknowledgements enable row level security;
alter table private.announcement_acknowledgements force row level security;
revoke all on private.announcement_acknowledgements from public, anon, authenticated;
grant select, insert on private.announcement_acknowledgements to service_role;

-- Use the same public fields and publication window for the banner, popups and receipts.
create view private.visible_announcements with (security_invoker = true) as
  select id, title, content, announcement_type, is_pinned, is_popup,
    starts_at, ends_at, published_at, created_at, updated_at
  from public.announcements
  where status = 'published' and deleted_at is null
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at > now());
revoke all on private.visible_announcements from public, anon, authenticated;
grant select on private.visible_announcements to service_role;

create or replace function public.get_public_announcements(p_limit integer default 5)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(a order by a.is_pinned desc, a.published_at desc nulls last, a.created_at desc, a.id), '[]'::jsonb)
  from (
    select * from private.visible_announcements
    order by is_pinned desc, published_at desc nulls last, created_at desc, id
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ) a;
$$;

create or replace function public.get_admin_announcements(
  p_search text default '', p_status text default 'all', p_limit integer default 100
)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(a order by a.is_pinned desc, a.updated_at desc, a.id), '[]'::jsonb)
  from (
    select n.id, n.title, n.content, n.announcement_type, n.status, n.is_pinned, n.is_popup,
      n.starts_at, n.ends_at, n.created_by, n.created_at, n.updated_at, n.published_at, n.deleted_at,
      p.username as creator_username
    from public.announcements n left join public.profiles p on p.id = n.created_by
    where n.deleted_at is null
      and (coalesce(p_search, '') = '' or n.title ilike '%' || p_search || '%' or n.content ilike '%' || p_search || '%')
      and (coalesce(p_status, 'all') = 'all' or n.status = p_status)
    order by n.is_pinned desc, n.updated_at desc, n.id
    limit greatest(1, least(coalesce(p_limit, 100), 200))
  ) a;
$$;

-- Drop the old arities so PostgREST can resolve calls that omit the new optional parameter.
drop function public.create_announcement(uuid, text, text, text, text, boolean, timestamptz, timestamptz);
drop function public.update_announcement(uuid, uuid, text, text, text, text, boolean, timestamptz, timestamptz);

create function public.create_announcement(
  p_admin_user_id uuid, p_title text, p_content text,
  p_announcement_type text default 'info', p_status text default 'draft',
  p_is_pinned boolean default false, p_starts_at timestamptz default null,
  p_ends_at timestamptz default null, p_is_popup boolean default false
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.announcements%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_admin_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 120 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TITLE_INVALID');
  end if;
  if char_length(trim(coalesce(p_content, ''))) not between 1 and 5000 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_CONTENT_INVALID');
  end if;
  if p_announcement_type is null or p_announcement_type not in ('info', 'important', 'maintenance') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TYPE_INVALID');
  end if;
  if p_status is null or p_status not in ('draft', 'published', 'offline') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_STATUS_INVALID');
  end if;
  if p_ends_at <= p_starts_at then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TIME_INVALID');
  end if;
  insert into public.announcements (
    title, content, announcement_type, status, is_pinned, starts_at, ends_at, is_popup, created_by, published_at
  ) values (
    trim(p_title), trim(p_content), p_announcement_type, p_status, coalesce(p_is_pinned, false),
    p_starts_at, p_ends_at, coalesce(p_is_popup, false), p_admin_user_id,
    case when p_status = 'published' then now() end
  ) returning * into v_row;
  return jsonb_build_object('ok', true, 'announcement', to_jsonb(v_row));
end;
$$;

create function public.update_announcement(
  p_admin_user_id uuid, p_id uuid, p_title text, p_content text,
  p_announcement_type text default 'info', p_status text default 'draft',
  p_is_pinned boolean default false, p_starts_at timestamptz default null,
  p_ends_at timestamptz default null, p_is_popup boolean default null
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.announcements%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_admin_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 120 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TITLE_INVALID');
  end if;
  if char_length(trim(coalesce(p_content, ''))) not between 1 and 5000 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_CONTENT_INVALID');
  end if;
  if p_announcement_type is null or p_announcement_type not in ('info', 'important', 'maintenance') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TYPE_INVALID');
  end if;
  if p_status is null or p_status not in ('draft', 'published', 'offline') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_STATUS_INVALID');
  end if;
  if p_ends_at <= p_starts_at then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TIME_INVALID');
  end if;
  update public.announcements
  set title = trim(p_title), content = trim(p_content), announcement_type = p_announcement_type,
    status = p_status, is_pinned = coalesce(p_is_pinned, false), starts_at = p_starts_at, ends_at = p_ends_at,
    is_popup = coalesce(p_is_popup, is_popup), updated_at = now(),
    published_at = case when p_status = 'published' then coalesce(published_at, now()) end
  where id = p_id and deleted_at is null
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true, 'announcement', to_jsonb(v_row));
end;
$$;

create function public.get_pending_popup_announcements(p_user_id uuid default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(a order by a.published_at desc nulls last, a.created_at desc, a.id), '[]'::jsonb)
  from private.visible_announcements a
  where a.is_popup and not exists (
    select 1 from private.announcement_acknowledgements r
    where r.user_id = p_user_id and r.announcement_id = a.id
  );
$$;

create function public.acknowledge_popup_announcement(p_user_id uuid, p_announcement_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'AUTH_REQUIRED');
  end if;
  insert into private.announcement_acknowledgements (user_id, announcement_id)
    select p_user_id, a.id from private.visible_announcements a
    where a.id = p_announcement_id and a.is_popup
    on conflict (user_id, announcement_id) do nothing;
  if not found and not exists (
    select 1 from private.announcement_acknowledgements
    where user_id = p_user_id and announcement_id = p_announcement_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.create_announcement(uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean),
  public.update_announcement(uuid, uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean),
  public.get_pending_popup_announcements(uuid), public.acknowledge_popup_announcement(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_announcement(uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean),
  public.update_announcement(uuid, uuid, text, text, text, text, boolean, timestamptz, timestamptz, boolean),
  public.get_pending_popup_announcements(uuid), public.acknowledge_popup_announcement(uuid, uuid)
  to service_role;
