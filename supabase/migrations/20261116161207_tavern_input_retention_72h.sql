-- Keep only this request's final user message, not the system prompt/history.
-- Additive rollout: apply before the API switches to the new RPC. The old RPC
-- and all billing/read projections remain compatible with an application rollback.
-- Keep the cleanup function after rollback so retained input still expires.
set local lock_timeout = '5s';

alter table public.tavern_requests
  add column input_text text check (char_length(input_text) <= 65536),
  add column input_expires_at timestamptz,
  add constraint tavern_requests_input_expiry_check
    check (input_text is null or input_expires_at is not null);

create index tavern_requests_input_expiry_idx
  on public.tavern_requests(input_expires_at) where input_text is not null;

comment on column public.tavern_requests.input_text is
  'Final user-role message for a new platform request; retained for 72 hours from creation. No historical backfill; excluded from billing API responses.';
comment on column public.tavern_requests.input_expires_at is
  'Input retention deadline, fixed at request creation plus 72 hours; retries never extend it.';

create function private.begin_tavern_request_with_input(
  p_user_id uuid,p_request_id uuid,p_fingerprint text,p_model text,p_kind text,
  p_reserved_credits numeric,p_input_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_input_text is null or char_length(p_input_text)=0 or char_length(p_input_text)>65536 then
    return jsonb_build_object('ok',false,'code','TAVERN_INPUT_INVALID');
  end if;
  -- The existing reservation owns authorization, account/request locks, and
  -- idempotency. Both reservation and input write commit or roll back together.
  result := private.begin_tavern_request(
    p_user_id,p_request_id,p_fingerprint,p_model,p_kind,p_reserved_credits);
  if result->>'ok'='true' and result->>'leader'='true' then
    update public.tavern_requests
      set input_text=p_input_text,input_expires_at=created_at+interval '72 hours'
      where user_id=p_user_id and request_id=p_request_id;
  end if;
  -- Never backfill an old request or replace/extend a replayed input. The old
  -- explicit projection intentionally excludes the input and its expiry.
  return result;
end; $$;

create function public.begin_tavern_request_with_input(
  p_user_id uuid,p_request_id uuid,p_fingerprint text,p_model text,p_kind text,
  p_reserved_credits numeric,p_input_text text) returns jsonb
language sql security invoker set search_path = '' as $$
  select private.begin_tavern_request_with_input(
    p_user_id,p_request_id,p_fingerprint,p_model,p_kind,p_reserved_credits,p_input_text);
$$;

revoke all on function private.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text)
  from public,anon,authenticated,service_role;
revoke all on function public.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text)
  from public,anon,authenticated,service_role;
grant execute on function private.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text) to service_role;
grant execute on function public.begin_tavern_request_with_input(uuid,uuid,text,text,text,numeric,text) to service_role;

-- Reuse the existing hourly cron: input expires even if no reply ever arrived.
-- Do not extend either deadline or change timestamps, usage, or financial data.
create or replace function private.prune_tavern_responses() returns integer
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  update public.tavern_requests
    set response_text=case when response_expires_at<=now() then null else response_text end,
        input_text=case when input_expires_at<=now() then null else input_text end
    where (response_text is not null and response_expires_at<=now())
       or (input_text is not null and input_expires_at<=now());
  get diagnostics removed=row_count;
  return removed;
end; $$;
revoke all on function private.prune_tavern_responses() from public,anon,authenticated,service_role;
