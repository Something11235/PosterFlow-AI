-- Isolated fixture only. The matching runner mocks Storage HTTP and cron;
-- never execute this fixture against a hosted application database.
begin;

create function private.reference_test_assert(ok boolean, label text)
returns void language plpgsql as $$
begin if not coalesce(ok,false) then raise exception 'Reference retention: %',label; end if; end;
$$;

select private.reference_test_assert(
  not has_function_privilege('anon','private.prune_image_reference_copies(boolean)','EXECUTE')
  and not has_function_privilege('authenticated','private.prune_image_reference_copies(boolean)','EXECUTE')
  and not has_function_privilege('service_role','private.prune_image_reference_copies(boolean)','EXECUTE'),
  'public API roles cannot run destructive retention');
select private.reference_test_assert(
  (select not prosecdef and 'search_path=""'=any(proconfig)
     from pg_proc where oid='private.prune_image_reference_copies(boolean)'::regprocedure),
  'retention is invoker with fixed empty search_path');
select private.reference_test_assert(
  (select count(*)=1 from cron.job where jobname='posterflow-image-reference-retention-12h'
    and schedule='57 * * * *' and command='select private.prune_image_reference_copies(false);'
    and active), 'new hourly cron registered once');
select private.reference_test_assert(
  (select count(*)=1 from cron.job where jobname='unrelated-retention'
    and schedule='17 * * * *' and command='select 1;' and active),
  'existing cron preserved');

insert into storage.objects(bucket_id,name,created_at)
select 'posterflow-images', 'posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||lpad(n::text,32,'0')||'.'||ext,
       now()-interval '13 hours'
from (values (1,'png'),(2,'jpg'),(3,'webp'),(4,'gif')) as fixtures(n,ext);
insert into storage.objects(bucket_id,name,created_at,archived_at,is_delete_marker) values
 ('posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||repeat('b',32)||'.png',now()-interval '11 hours 59 minutes',null,false),
 ('posterflow-images','posterflow/user-00000000/images/result.png',now()-interval '2 days',null,false),
 ('posterflow-images','posterflow/video-'||repeat('a',64)||'/references/1794240000-'||repeat('c',32)||'.png',now()-interval '2 days',null,false),
 ('posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||repeat('d',32)||'.mp4',now()-interval '2 days',null,false),
 ('posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||repeat('e',32)||'.jpeg',now()-interval '2 days',null,false),
 ('posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-not-a-server-uuid.png',now()-interval '2 days',null,false),
 ('another-bucket','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||repeat('f',32)||'.png',now()-interval '2 days',null,false),
 ('posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||repeat('1',32)||'.png',now()-interval '2 days',now(),false),
 ('posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||repeat('2',32)||'.png',now()-interval '2 days',null,true);

select private.reference_test_assert(
  (private.prune_image_reference_copies(true)->>'eligible_objects')::int=4,
  'dry run sees only expired active exact namespace copies');
select private.reference_test_assert((select count(*)=0 from private.mock_http_calls), 'dry run does not call Storage');
select private.reference_test_assert((select count(*)=13 from storage.objects), 'dry run preserves all objects');

do $$begin
  begin perform private.prune_image_reference_copies(null); raise exception 'accepted null cleanup mode';
  exception when others then
    if sqlerrm<>'Explicit cleanup mode required' then raise; end if;
  end;
end;$$;

-- HTTP failures must not be reported as successful deletes.
select set_config('fixture.http_mode','http_failure',true);
do $$begin
  begin perform private.prune_image_reference_copies(false); raise exception 'accepted HTTP failure';
  exception when others then
    if sqlerrm<>'Storage cleanup request failed (HTTP 503)' then raise; end if;
  end;
end;$$;
select private.reference_test_assert((select count(*)=13 from storage.objects), 'HTTP failure leaves objects intact');
select set_config('fixture.http_mode','noop',true);
do $$begin
  begin perform private.prune_image_reference_copies(false); raise exception 'accepted unverified Storage delete';
  exception when others then
    if sqlerrm<>'Storage cleanup could not verify the completed batch' then raise; end if;
  end;
end;$$;
select private.reference_test_assert((select count(*)=13 from storage.objects), 'unverified delete leaves objects intact');
select set_config('fixture.http_mode','success',true);

select private.reference_test_assert(
  (private.prune_image_reference_copies(false)->>'deleted_objects')::int=4,
  'four supported expired formats deleted through Storage API');
select private.reference_test_assert((select count(*)=9 from storage.objects), 'fresh and unrelated objects retained');

-- PGlite has one database backend, so actual lock contention cannot be induced.
-- Inject just the lock primitive in a temporary function definition to exercise
-- the competing-run branch; restore the exact migration definition immediately.
do $$declare original text; patched text; outcome jsonb; before_calls int; begin
  select pg_get_functiondef('private.prune_image_reference_copies(boolean)'::regprocedure) into original;
  patched:=replace(original,
    'pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext(''posterflow.image_reference_copy_retention.run''))',
    'false');
  if patched=original then raise exception 'missing reviewed advisory lock'; end if;
  select count(*) into before_calls from private.mock_http_calls;
  execute patched;
  outcome:=private.prune_image_reference_copies(false);
  if outcome <> '{"skipped":true,"reason":"already_running"}'::jsonb then raise exception 'competing run did not skip'; end if;
  if (select count(*) from private.mock_http_calls)<>before_calls then raise exception 'competing run called Storage'; end if;
  execute original;
  if pg_get_functiondef('private.prune_image_reference_copies(boolean)'::regprocedure)<>original then raise exception 'failed restoring original lock primitive'; end if;
end;$$;

insert into storage.objects(bucket_id,name,created_at)
select 'posterflow-images','posterflow/image-reference-'||repeat('a',64)||'/references/1794240000-'||lpad(to_hex(n),32,'0')||'.png',now()-interval '13 hours'
from generate_series(100,1204) as n;
truncate private.mock_http_calls;
select private.reference_test_assert(
  (private.prune_image_reference_copies(false)->>'deleted_objects')::int=1000,
  'single run bounded to 1000 objects');
select private.reference_test_assert((select count(*)=10 from private.mock_http_calls), 'single run bounded to ten HTTP batches');
select private.reference_test_assert((select bool_and(path_count<=100) from private.mock_http_calls), 'each HTTP batch bounded to 100 objects');
select private.reference_test_assert((private.prune_image_reference_copies(true)->>'eligible_objects')::int=105, 'remaining expired copies preserved for next run');
select private.reference_test_assert((private.prune_image_reference_copies(false)->>'deleted_objects')::int=105, 'next run cleans remaining expired copies');
select private.reference_test_assert((select count(*)=9 from storage.objects), 'unrelated objects still untouched after full cleanup');

-- A missing retention credential must fail closed and never call Storage.
truncate private.mock_http_calls;
delete from vault.decrypted_secrets;
do $$begin
  begin perform private.prune_image_reference_copies(false); raise exception 'accepted missing Vault config';
  exception when others then
    if sqlerrm<>'Image retention Vault configuration is missing' then raise; end if;
  end;
end;$$;
select private.reference_test_assert((select count(*)=0 from private.mock_http_calls), 'missing credential makes no HTTP request');

rollback;
