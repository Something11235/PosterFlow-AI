-- PosterFlow server reads account snapshots through PostgREST with the
-- server-only Supabase Secret key. RLS bypass does not replace SQL grants.
-- Keep these privileges limited to service_role; never grant them to anon.

grant usage on schema public to service_role;
grant select on table public.profiles to service_role;
grant select on table public.credit_accounts to service_role;
grant select on table public.credit_transactions to service_role;
grant select on table public.generation_jobs to service_role;
