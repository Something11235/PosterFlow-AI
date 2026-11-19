-- Local fixture with an emulated Storage API, like video_generation.sql.
begin;
insert into storage.objects (bucket_id,name,created_at)
select 'posterflow-images','posterflow/video-' || repeat('a',64) ||
       '/references/1700000000-' || repeat('a',32) || '.' || ext, now()-interval '13 hours'
from unnest(array['bmp','gif','tif','tiff','heic','heif']) as ext;
insert into storage.objects (bucket_id,name,created_at) values
 ('posterflow-images','posterflow/video-' || repeat('a',64) || '/references/1700000000-' || repeat('b',32) || '.gif', now()),
 ('posterflow-images','posterflow/video-' || repeat('a',64) || '/references/unrelated.gif', now()-interval '13 hours');
do $$
begin
    assert (private.prune_video_references(true)->>'eligible_objects')::int = 6;
    assert (private.prune_video_references(false)->>'deleted_objects')::int = 6;
    assert (select count(*) from storage.objects where name like 'posterflow/video-%') = 2;
    assert not has_function_privilege('service_role','private.prune_video_references(boolean)','execute');
end;
$$;
rollback;
