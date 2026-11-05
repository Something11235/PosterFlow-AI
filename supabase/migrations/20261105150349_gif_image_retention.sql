-- Pending GIF release only. Extend the existing twelve-hour cleanup to GIF.
-- Preserve its credentials handling, limits, ACL and cron schedule unchanged.
do $$
declare definition text;
begin
 select pg_get_functiondef('private.prune_generated_images(boolean)'::regprocedure) into definition;
 if md5(definition) <> '7ec051a9d30bee0f2aebfd5f28ec0506' then
  raise exception 'Image retention definition differs from reviewed production baseline';
 end if;
 if (length(definition)-length(replace(definition,'[.]png$','')))/length('[.]png$') <> 2 then
  raise exception 'Unexpected image retention filename filters';
 end if;
 execute replace(definition,'[.]png$','[.](png|gif)$');
end;$$;
