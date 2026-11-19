-- Extend the existing 12-hour video-reference cleaner to Flash image formats.
do $$
declare
    definition text := pg_get_functiondef('private.prune_video_references(boolean)'::regprocedure);
    old_suffix constant text := '[.](png|jpe?g|webp|mp3|wav|mp4|mov)$';
    new_suffix constant text := '[.](png|jpe?g|webp|bmp|gif|tiff?|heic|heif|mp3|wav|mp4|mov)$';
begin
    if (length(definition) - length(replace(definition, old_suffix, ''))) / length(old_suffix) <> 2 then
        raise exception 'Unexpected video reference cleanup predicates';
    end if;
    execute replace(definition, old_suffix, new_suffix);
end;
$$;
