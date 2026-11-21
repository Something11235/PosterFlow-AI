-- For the isolated Storage HTTP fixture. Changes are rolled back after the check.
begin;
insert into storage.objects(bucket_id, name, created_at)
select 'posterflow-images', 'posterflow/reference-upload-parts/' || repeat('a', 64) || '/' || n || '.part',
       now() - interval '13 hours'
from generate_series(0, 3) n;
insert into storage.objects(bucket_id, name, created_at) values
    ('posterflow-images', 'posterflow/reference-upload-parts/' || repeat('b', 64) || '/0.part', now()),
    ('posterflow-images', 'posterflow/reference-upload-parts/' || repeat('a', 64) || '/4.part', now() - interval '13 hours'),
    ('posterflow-images', 'posterflow/reference-upload-parts/' || repeat('a', 63) || '/0.part', now() - interval '13 hours'),
    ('posterflow-images', 'posterflow/user-another/references/' || repeat('c', 32) || '.png', now() - interval '13 hours'),
    ('another-bucket', 'posterflow/reference-upload-parts/' || repeat('a', 64) || '/0.part', now() - interval '13 hours');
do $$
begin
    if (private.prune_image_reference_copies(true)->>'eligible_objects')::int <> 4 then
        raise exception 'Unexpected number of expired reference parts';
    end if;
    if (private.prune_image_reference_copies(false)->>'deleted_objects')::int <> 4 then
        raise exception 'The four expired pieces did not clear through the Storage API';
    end if;
    if (select count(*) from storage.objects) <> 5 then
        raise exception 'Fresh pieces and unrelated references must remain';
    end if;
end;
$$;
rollback;
