set local lock_timeout = '5s';

alter table private.ppt_requests add column diagnostic text
  check (char_length(diagnostic) <= 256);

-- Capture the first failing outcome in the same transaction as its refund.
-- The existing five-argument RPC remains available to older clients and cron.
create function private.finish_ppt_request(p_user_id uuid, p_request_id uuid, p_result jsonb,
  p_usage jsonb, p_error_code text, p_diagnostic text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_error_code = 'PPT_RESULT_INVALID' and p_result is null then
    -- Match the settlement and expiry routines' account-before-request lock order.
    perform 1 from public.credit_accounts where user_id = p_user_id for update;
    update private.ppt_requests set diagnostic = nullif(left(p_diagnostic, 256), '')
      where user_id = p_user_id and request_id = p_request_id and status = 'processing';
  end if;
  return private.finish_ppt_request(p_user_id, p_request_id, p_result, p_usage, p_error_code);
end;
$$;

create function public.finish_ppt_request(p_user_id uuid, p_request_id uuid, p_result jsonb,
  p_usage jsonb, p_error_code text, p_diagnostic text)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.finish_ppt_request(p_user_id, p_request_id, p_result, p_usage, p_error_code, p_diagnostic);
$$;
revoke all on function private.finish_ppt_request(uuid,uuid,jsonb,jsonb,text,text),
  public.finish_ppt_request(uuid,uuid,jsonb,jsonb,text,text) from public, anon, authenticated;
grant execute on function private.finish_ppt_request(uuid,uuid,jsonb,jsonb,text,text),
  public.finish_ppt_request(uuid,uuid,jsonb,jsonb,text,text) to service_role;

create or replace function private.get_admin_ppt_overview(p_from date, p_to date, p_search text, p_limit integer)
returns jsonb language sql stable security definer set search_path = '' as $$
with filters as (
  select p_from::timestamp at time zone 'Asia/Shanghai' as start_at,
         (p_to + 1)::timestamp at time zone 'Asia/Shanghai' as end_at,
         lower(left(trim(coalesce(p_search, '')), 160)) as search
), jobs as (
  select j.request_id, j.user_id, p.username, u.email, j.created_at, j.kind, j.model, j.status,
         case when j.usage->>'status' = 'confirmed' then (j.usage->>'input_tokens')::bigint end as input_tokens,
         case when j.usage->>'status' = 'confirmed' then (j.usage->>'output_tokens')::bigint end as output_tokens,
         j.charged as charged_credits, j.reserved as reserved_credits, j.error_code, j.diagnostic
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
         count(*) filter (where kind = 'outline') as outline,
         count(*) filter (where kind = 'page') as page,
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
