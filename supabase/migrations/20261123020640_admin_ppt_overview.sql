-- Read-only operations report. Credits come from the settled request, not its hold.
set local lock_timeout = '5s';

create index ppt_requests_created_at_idx on private.ppt_requests (created_at);

create function private.get_admin_ppt_overview(p_from date, p_to date, p_search text, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
with filters as (
  select p_from::timestamp at time zone 'Asia/Shanghai' as start_at,
         (p_to + 1)::timestamp at time zone 'Asia/Shanghai' as end_at,
         lower(left(trim(coalesce(p_search, '')), 160)) as search
), jobs as (
  select j.request_id, j.user_id, p.username, u.email, j.created_at, j.kind, j.model, j.status,
         case when j.usage->>'status' = 'confirmed' then (j.usage->>'input_tokens')::bigint end as input_tokens,
         case when j.usage->>'status' = 'confirmed' then (j.usage->>'output_tokens')::bigint end as output_tokens,
         j.charged as charged_credits, j.reserved as reserved_credits, j.error_code
  from private.ppt_requests j
  join public.profiles p on p.id = j.user_id
  join auth.users u on u.id = j.user_id
  cross join filters f
  where j.created_at >= f.start_at and j.created_at < f.end_at
    and (f.search = '' or j.user_id::text = f.search
      or strpos(lower(p.username), f.search) > 0 or strpos(lower(u.email), f.search) > 0)
), metrics as (
  select count(*) as requests, count(distinct user_id) as users,
         count(*) filter (where kind = 'generate') as generate,
         count(*) filter (where kind = 'edit') as edit,
         count(*) filter (where kind = 'chat') as chat,
         count(*) filter (where status = 'succeeded') as completed,
         count(*) filter (where status = 'failed') as failed,
         count(*) filter (where status = 'processing') as pending,
         coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens,
         coalesce(sum(charged_credits), 0) as credits
  from jobs
), models as (
  select model, count(*) as requests, coalesce(sum(input_tokens), 0) as input_tokens,
         coalesce(sum(output_tokens), 0) as output_tokens, coalesce(sum(charged_credits), 0) as credits
  from jobs group by model
), recent as (
  select * from jobs order by created_at desc, request_id desc, user_id desc
  limit greatest(1, least(coalesce(p_limit, 100), 100))
)
select jsonb_build_object(
  'metrics', (select to_jsonb(m) from metrics m),
  'models', coalesce((select jsonb_agg(to_jsonb(m) order by requests desc, model) from models m), '[]'::jsonb),
  'jobs', coalesce((select jsonb_agg(to_jsonb(r) order by created_at desc, request_id desc, user_id desc)
                    from recent r), '[]'::jsonb)
);
$$;

create function public.get_admin_ppt_overview(p_from date, p_to date, p_search text default '', p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select private.get_admin_ppt_overview(p_from, p_to, p_search, p_limit);
$$;

revoke all on function private.get_admin_ppt_overview(date,date,text,integer),
                       public.get_admin_ppt_overview(date,date,text,integer) from public, anon, authenticated;
grant execute on function private.get_admin_ppt_overview(date,date,text,integer),
                          public.get_admin_ppt_overview(date,date,text,integer) to service_role;
