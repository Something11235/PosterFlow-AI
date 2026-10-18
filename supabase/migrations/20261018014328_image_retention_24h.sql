-- Keep at least 24 hours of generated images. Cron runs hourly inside Supabase;
-- only Storage API DELETE requests leave Postgres, never image downloads.
-- Apply this migration, configure its Vault credential with the server-only
-- setup script, verify a dry run, then activate the initially disabled job.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists http with schema extensions;
create extension if not exists supabase_vault with schema vault;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

create table private.image_retention_runs (
    id bigint generated always as identity primary key,
    started_at timestamptz not null,
    finished_at timestamptz not null,
    cutoff timestamptz not null,
    deleted_objects integer not null check (deleted_objects >= 0),
    deleted_bytes bigint not null check (deleted_bytes >= 0)
);
alter table private.image_retention_runs enable row level security;
revoke all on private.image_retention_runs from public, anon, authenticated, service_role;

-- The only API-exposed setup function: service_role only, no secret returned.
-- Credentials are sent in an HTTPS request body, never SQL literals or Git.
create function public.configure_image_retention(
    p_project_url text, p_bucket text, p_storage_key text
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
    v_secret_id uuid;
    v_config text;
begin
    if p_project_url is null or p_project_url !~ '^https://[a-z0-9]+[.]supabase[.]co$'
       or p_bucket is null or p_bucket !~ '^[a-z0-9][a-z0-9_-]{0,62}$'
       or p_storage_key is null or length(p_storage_key) < 30 then
        raise exception 'Invalid image retention configuration';
    end if;
    if not exists (select 1 from storage.buckets where id = p_bucket and not public) then
        raise exception 'A private Storage bucket is required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('posterflow.image_retention.config'));
    v_config := pg_catalog.jsonb_build_object(
        'project_url', p_project_url, 'bucket', p_bucket, 'storage_key', p_storage_key
    )::text;
    select id into v_secret_id from vault.secrets where name = 'posterflow_image_retention';
    if v_secret_id is null then
        perform vault.create_secret(v_config, 'posterflow_image_retention', 'Storage credential for hourly 24h image retention');
    else
        perform vault.update_secret(v_secret_id, v_config);
    end if;
    return true;
end;
$$;
revoke all on function public.configure_image_retention(text,text,text) from public, anon, authenticated;
grant execute on function public.configure_image_retention(text,text,text) to service_role;

-- Not exposed to the Data API and not executable by any application role.
-- SECURITY INVOKER deliberately requires the cron owner's privileges.
create function private.prune_generated_images(p_dry_run boolean default true)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
    v_started timestamptz := pg_catalog.clock_timestamp();
    v_cutoff timestamptz := pg_catalog.statement_timestamp() - interval '24 hours';
    v_config jsonb;
    v_bucket text;
    v_key text;
    v_url text;
    v_headers extensions.http_header[];
    v_response extensions.http_response;
    v_paths text[];
    v_batch_bytes bigint;
    v_deleted integer := 0;
    v_deleted_bytes bigint := 0;
    v_candidates integer;
    v_candidate_bytes bigint;
    v_iteration integer;
begin
    if p_dry_run is null then
        raise exception 'Explicit cleanup mode required';
    end if;
    if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('posterflow.image_retention.run')) then
        return pg_catalog.jsonb_build_object('skipped', true, 'reason', 'already_running');
    end if;
    select decrypted_secret::jsonb into v_config
      from vault.decrypted_secrets where name = 'posterflow_image_retention';
    if v_config is null then
        raise exception 'Image retention Vault configuration is missing';
    end if;
    v_bucket := v_config->>'bucket';
    v_key := v_config->>'storage_key';
    v_url := v_config->>'project_url';
    if v_url is null or v_url !~ '^https://[a-z0-9]+[.]supabase[.]co$'
       or v_bucket is null or v_bucket !~ '^[a-z0-9][a-z0-9_-]{0,62}$'
       or v_key is null or length(v_key) < 30 then
        raise exception 'Invalid image retention Vault configuration';
    end if;

    select count(*), coalesce(sum(coalesce((metadata->>'size')::bigint,0)),0)
      into v_candidates, v_candidate_bytes
      from storage.objects
     where bucket_id = v_bucket and created_at < v_cutoff
       and name ~ '^posterflow/[A-Za-z0-9_-]+/images/[A-Za-z0-9_.-]+[.]png$'
       and archived_at is null and not coalesce(is_delete_marker,false);
    if p_dry_run then
        return pg_catalog.jsonb_build_object('dry_run',true,'cutoff',v_cutoff,
            'eligible_objects',v_candidates,'eligible_bytes',v_candidate_bytes,'max_objects_per_run',1000);
    end if;

    v_headers := array[extensions.http_header('apikey',v_key)];
    if v_key not like 'sb_secret_%' then
        v_headers := pg_catalog.array_append(v_headers,extensions.http_header('Authorization','Bearer ' || v_key));
    end if;
    -- Bound network waits and total work. Never disable certificate validation
    -- or follow redirects with credentials to another host.
    perform pg_catalog.set_config('http.curlopt_timeout_ms','15000',true);
    perform pg_catalog.set_config('http.curlopt_connecttimeout_ms','5000',true);
    for v_iteration in 1..10 loop
        select array_agg(candidate.name order by candidate.created_at,candidate.name),
               coalesce(sum(candidate.bytes),0)
          into v_paths, v_batch_bytes
          from (
              select name, created_at, coalesce((metadata->>'size')::bigint,0) as bytes
                from storage.objects
               where bucket_id = v_bucket and created_at < v_cutoff
                 and name ~ '^posterflow/[A-Za-z0-9_-]+/images/[A-Za-z0-9_.-]+[.]png$'
                 and archived_at is null and not coalesce(is_delete_marker,false)
               order by created_at,name limit 100
          ) candidate;
        exit when v_paths is null;
        select * into v_response from extensions.http((
            'DELETE', v_url || '/storage/v1/object/' || v_bucket, v_headers,
            'application/json', pg_catalog.jsonb_build_object('prefixes',v_paths)::text
        )::extensions.http_request);
        if v_response.status < 200 or v_response.status >= 300 then
            -- Do not include response bodies, paths or credentials in errors.
            raise exception 'Storage cleanup request failed (HTTP %)', v_response.status;
        end if;
        if exists(select 1 from storage.objects where bucket_id=v_bucket and name=any(v_paths)
                  and archived_at is null and not coalesce(is_delete_marker,false)) then
            raise exception 'Storage cleanup could not verify the completed batch';
        end if;
        v_deleted := v_deleted + cardinality(v_paths);
        v_deleted_bytes := v_deleted_bytes + v_batch_bytes;
    end loop;

    insert into private.image_retention_runs(started_at,finished_at,cutoff,deleted_objects,deleted_bytes)
    values(v_started,pg_catalog.clock_timestamp(),v_cutoff,v_deleted,v_deleted_bytes);
    delete from private.image_retention_runs where started_at < v_started - interval '30 days';
    delete from cron.job_run_details
     where jobid = (select jobid from cron.job where jobname='posterflow-image-retention-24h')
       and end_time < v_started - interval '30 days';
    return pg_catalog.jsonb_build_object('dry_run',false,'cutoff',v_cutoff,
        'deleted_objects',v_deleted,'deleted_bytes',v_deleted_bytes,
        'eligible_at_start',v_candidates,'remaining_from_start',greatest(v_candidates-v_deleted,0));
end;
$$;
revoke all on function private.prune_generated_images(boolean) from public, anon, authenticated, service_role;

select cron.schedule('posterflow-image-retention-24h','17 * * * *',
    'select private.prune_generated_images(false);');
-- Fail closed until server-only credentials and the first run are verified.
select cron.alter_job(
    (select jobid from cron.job where jobname='posterflow-image-retention-24h'), active := false
);
