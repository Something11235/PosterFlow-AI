-- Synthetic accounts and announcements, all changes roll back.
begin;
insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values
  ('eb100000-0000-4000-8000-000000000001', 'popup-publisher@example.invalid', now(), '{"username":"popup_publisher"}'),
  ('eb100000-0000-4000-8000-000000000002', 'popup-reader@example.invalid', now(), '{"username":"popup_reader"}');

set local role service_role;
do $$
declare
  publisher uuid := 'eb100000-0000-4000-8000-000000000001';
  reader uuid := 'eb100000-0000-4000-8000-000000000002';
  first_id uuid;
  next_id uuid;
  hidden_id uuid;
  normal_id uuid;
  pending jsonb;
  result jsonb;
begin
  result := public.create_announcement(publisher, 'Popup test: regular', 'body', p_status => 'published');
  normal_id := (result #>> '{announcement,id}')::uuid;
  assert result #> '{announcement,is_popup}' = 'false'::jsonb;

  result := public.create_announcement(publisher, 'Popup test: first', 'body', p_status => 'published', p_is_popup => true);
  first_id := (result #>> '{announcement,id}')::uuid;
  result := public.get_public_announcements(20);
  assert result @> jsonb_build_array(jsonb_build_object('id', first_id, 'is_popup', true));
  assert public.get_admin_announcements('Popup test: first')
    @> jsonb_build_array(jsonb_build_object('id', first_id, 'is_popup', true));

  -- Pinned banners can fill all 20 banner slots. The popup feed still contains the new notice.
  insert into public.announcements (title, content, is_pinned, status, published_at)
    select 'Popup test: pinned ' || n, 'body', true, 'published', now() from generate_series(1, 21) n;
  assert not (public.get_public_announcements(20) @> jsonb_build_array(jsonb_build_object('id', first_id)));
  result := public.create_announcement(publisher, 'Popup test: second', 'body', p_status => 'published', p_is_popup => true);
  next_id := (result #>> '{announcement,id}')::uuid;
  update public.announcements set published_at = now() - interval '1 day' where id = first_id;
  pending := public.get_pending_popup_announcements();
  assert (select array_agg((entry->>'id')::uuid order by position)
    from jsonb_array_elements(pending) with ordinality as popup(entry, position)
    where (entry->>'id')::uuid in (first_id, next_id)) = array[next_id, first_id];
  assert not (pending @> jsonb_build_array(jsonb_build_object('id', normal_id)));
  assert public.acknowledge_popup_announcement(reader, normal_id)->>'code' = 'ANNOUNCEMENT_NOT_FOUND';

  -- An old admin client can edit the title without resetting the popup flag.
  result := public.update_announcement(publisher, first_id, 'Popup test: edited', 'new body', p_status => 'published');
  assert result #> '{announcement,is_popup}' = 'true'::jsonb;
  assert public.acknowledge_popup_announcement(reader, first_id)->>'ok' = 'true';
  assert public.acknowledge_popup_announcement(reader, first_id)->>'ok' = 'true';
  assert (select count(*) from private.announcement_acknowledgements where announcement_id = first_id) = 1;
  assert not (public.get_pending_popup_announcements(reader) @> jsonb_build_array(jsonb_build_object('id', first_id)));
  assert public.get_pending_popup_announcements(publisher) @> jsonb_build_array(jsonb_build_object('id', first_id));
  assert public.get_pending_popup_announcements(reader) @> jsonb_build_array(jsonb_build_object('id', next_id));
  result := public.update_announcement(publisher, first_id, 'Popup test: edited again', 'body', p_status => 'published');
  assert not (public.get_pending_popup_announcements(reader) @> jsonb_build_array(jsonb_build_object('id', first_id)));
  result := public.update_announcement(publisher, next_id, 'Popup test: turn off', 'body', p_status => 'published', p_is_popup => false);
  assert result #> '{announcement,is_popup}' = 'false'::jsonb;
  assert not (public.get_pending_popup_announcements() @> jsonb_build_array(jsonb_build_object('id', next_id)));

  for hidden_id in
    with hidden as (
      insert into public.announcements (title, content, is_popup, status, starts_at, ends_at, deleted_at) values
        ('draft', 'body', true, 'draft', null, null, null),
        ('offline', 'body', true, 'offline', null, null, null),
        ('future', 'body', true, 'published', now() + interval '1 day', null, null),
        ('expired', 'body', true, 'published', null, now(), null),
        ('deleted', 'body', true, 'published', null, null, now()) returning id
    ) select id from hidden
  loop
    assert not (public.get_pending_popup_announcements(reader) @> jsonb_build_array(jsonb_build_object('id', hidden_id)));
    assert public.acknowledge_popup_announcement(reader, hidden_id)->>'code' = 'ANNOUNCEMENT_NOT_FOUND';
  end loop;

  perform public.delete_announcement(publisher, first_id);
  assert public.acknowledge_popup_announcement(reader, first_id)->>'ok' = 'true';
  assert public.acknowledge_popup_announcement(publisher, first_id)->>'code' = 'ANNOUNCEMENT_NOT_FOUND';
  assert not has_function_privilege('anon', 'public.get_pending_popup_announcements(uuid)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.acknowledge_popup_announcement(uuid,uuid)', 'EXECUTE');
  assert not has_table_privilege('authenticated', 'private.announcement_acknowledgements', 'SELECT');
end;
$$;
rollback;
