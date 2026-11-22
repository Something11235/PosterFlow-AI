-- The current user message can fill the model's context. Keep the full input
-- under the same 72-hour deadline and the existing atomic reservation.
set local lock_timeout = '5s';

alter table public.tavern_requests drop constraint tavern_requests_input_text_check;

create or replace function private.begin_tavern_request_with_input(
  p_user_id uuid,p_request_id uuid,p_fingerprint text,p_model text,p_kind text,
  p_reserved_credits numeric,p_input_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_input_text is null or p_input_text = '' then
    return jsonb_build_object('ok',false,'code','TAVERN_INPUT_INVALID');
  end if;

  result := private.begin_tavern_request(
    p_user_id,p_request_id,p_fingerprint,p_model,p_kind,p_reserved_credits);
  if result->>'ok'='true' and result->>'leader'='true' then
    update public.tavern_requests
      set input_text=p_input_text,input_expires_at=created_at+interval '72 hours'
      where user_id=p_user_id and request_id=p_request_id;
  end if;
  return result;
end; $$;
