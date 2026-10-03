-- Public announcements with an administrator-managed lifecycle.
-- Apply this migration in the Supabase SQL editor after 20261003_007_credit_settings.sql.

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 120),
  content text not null check (char_length(trim(content)) between 1 and 5000),
  announcement_type text not null default 'info'
    check (announcement_type in ('info', 'important', 'maintenance')),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'offline')),
  is_pinned boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  deleted_at timestamptz,
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists announcements_public_order_idx
  on public.announcements (status, is_pinned desc, published_at desc, created_at desc)
  where deleted_at is null;
create index if not exists announcements_schedule_idx
  on public.announcements (starts_at, ends_at)
  where deleted_at is null;

alter table public.announcements enable row level security;
alter table public.announcements force row level security;
revoke all on table public.announcements from public, anon, authenticated;
grant select, insert, update, delete on table public.announcements to service_role;

create or replace function public.get_public_announcements(p_limit integer default 5)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(row_to_json(a) order by a.is_pinned desc, a.published_at desc nulls last, a.created_at desc), '[]'::jsonb)
  from (
    select id, title, content, announcement_type, is_pinned, starts_at, ends_at, published_at, created_at, updated_at
    from public.announcements
    where status = 'published'
      and deleted_at is null
      and (starts_at is null or starts_at <= now())
      and (ends_at is null or ends_at > now())
    order by is_pinned desc, published_at desc nulls last, created_at desc
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ) a;
$$;

create or replace function public.get_admin_announcements(
  p_search text default '',
  p_status text default 'all',
  p_limit integer default 100
)
returns jsonb
language sql
security definer
stable
set search_path = public, auth
as $$
  select coalesce(jsonb_agg(row_to_json(a) order by a.is_pinned desc, a.updated_at desc), '[]'::jsonb)
  from (
    select a.id, a.title, a.content, a.announcement_type, a.status, a.is_pinned,
      a.starts_at, a.ends_at, a.created_by, a.created_at, a.updated_at, a.published_at, a.deleted_at,
      p.username as creator_username
    from public.announcements a
    left join public.profiles p on p.id = a.created_by
    where a.deleted_at is null
      and (coalesce(p_search, '') = '' or a.title ilike '%' || p_search || '%' or a.content ilike '%' || p_search || '%')
      and (coalesce(p_status, 'all') = 'all' or a.status = p_status)
    order by a.is_pinned desc, a.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 100), 200))
  ) a;
$$;

create or replace function public.create_announcement(
  p_admin_user_id uuid,
  p_title text,
  p_content text,
  p_announcement_type text default 'info',
  p_status text default 'draft',
  p_is_pinned boolean default false,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_row public.announcements%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_admin_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  if nullif(trim(coalesce(p_title, '')), '') is null or char_length(trim(p_title)) > 120 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TITLE_INVALID');
  end if;
  if nullif(trim(coalesce(p_content, '')), '') is null or char_length(trim(p_content)) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_CONTENT_INVALID');
  end if;
  if p_announcement_type not in ('info', 'important', 'maintenance') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TYPE_INVALID');
  end if;
  if p_status not in ('draft', 'published', 'offline') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_STATUS_INVALID');
  end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at <= p_starts_at then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TIME_INVALID');
  end if;

  insert into public.announcements (
    title, content, announcement_type, status, is_pinned, starts_at, ends_at, created_by, published_at
  ) values (
    trim(p_title), trim(p_content), p_announcement_type, p_status, coalesce(p_is_pinned, false),
    p_starts_at, p_ends_at, p_admin_user_id, case when p_status = 'published' then now() else null end
  ) returning * into v_row;

  return jsonb_build_object('ok', true, 'announcement', row_to_json(v_row));
end;
$$;

create or replace function public.update_announcement(
  p_admin_user_id uuid,
  p_id uuid,
  p_title text,
  p_content text,
  p_announcement_type text default 'info',
  p_status text default 'draft',
  p_is_pinned boolean default false,
  p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_row public.announcements%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_admin_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  if not exists (select 1 from public.announcements where id = p_id and deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_NOT_FOUND');
  end if;
  if nullif(trim(coalesce(p_title, '')), '') is null or char_length(trim(p_title)) > 120 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TITLE_INVALID');
  end if;
  if nullif(trim(coalesce(p_content, '')), '') is null or char_length(trim(p_content)) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_CONTENT_INVALID');
  end if;
  if p_announcement_type not in ('info', 'important', 'maintenance') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TYPE_INVALID');
  end if;
  if p_status not in ('draft', 'published', 'offline') then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_STATUS_INVALID');
  end if;
  if p_ends_at is not null and p_starts_at is not null and p_ends_at <= p_starts_at then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_TIME_INVALID');
  end if;

  update public.announcements
  set title = trim(p_title),
    content = trim(p_content),
    announcement_type = p_announcement_type,
    status = p_status,
    is_pinned = coalesce(p_is_pinned, false),
    starts_at = p_starts_at,
    ends_at = p_ends_at,
    updated_at = now(),
    published_at = case
      when p_status = 'published' then coalesce(published_at, now())
      else null
    end
  where id = p_id
  returning * into v_row;

  return jsonb_build_object('ok', true, 'announcement', row_to_json(v_row));
end;
$$;

create or replace function public.delete_announcement(p_admin_user_id uuid, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not exists (select 1 from public.profiles where id = p_admin_user_id and status = 'active') then
    return jsonb_build_object('ok', false, 'code', 'ADMIN_REQUIRED');
  end if;
  update public.announcements
  set deleted_at = now(), status = 'offline', updated_at = now()
  where id = p_id and deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ANNOUNCEMENT_NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.get_public_announcements(integer) from public, anon, authenticated;
revoke all on function public.get_admin_announcements(text, text, integer) from public, anon, authenticated;
revoke all on function public.create_announcement(uuid, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.update_announcement(uuid, uuid, text, text, text, text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.delete_announcement(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_public_announcements(integer) to service_role;
grant execute on function public.get_admin_announcements(text, text, integer) to service_role;
grant execute on function public.create_announcement(uuid, text, text, text, text, boolean, timestamptz, timestamptz) to service_role;
grant execute on function public.update_announcement(uuid, uuid, text, text, text, text, boolean, timestamptz, timestamptz) to service_role;
grant execute on function public.delete_announcement(uuid, uuid) to service_role;
