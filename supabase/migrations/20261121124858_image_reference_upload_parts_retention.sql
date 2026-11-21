-- The hourly reference cleaner also reclaims pieces left by interrupted uploads.
-- Keep the existing 12-hour cutoff, bucket, batch limits and grants.
do $$
declare
    definition text := pg_catalog.pg_get_functiondef('private.prune_image_reference_copies(boolean)'::regprocedure);
    old_pattern constant text := '^posterflow/image-reference-[a-f0-9]{64}/references/[0-9]{10}-[a-f0-9]{32}[.](png|jpg|webp|gif)$';
    new_pattern constant text := '^posterflow/(image-reference-[a-f0-9]{64}/references/[0-9]{10}-[a-f0-9]{32}[.](png|jpg|webp|gif)|reference-upload-parts/[a-f0-9]{64}/[0-3][.]part)$';
begin
    if (length(definition) - length(replace(definition, old_pattern, ''))) / length(old_pattern) <> 2 then
        raise exception 'Unexpected reference retention predicates';
    end if;
    execute replace(definition, old_pattern, new_pattern);
end;
$$;
