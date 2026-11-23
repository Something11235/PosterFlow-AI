-- Exercise the actual billing RPCs inside a rolled-back synthetic account.
begin;
set local plpgsql.check_asserts = on;
do $$
declare
  u uuid := gen_random_uuid();
  rid uuid := gen_random_uuid();
  fp text := repeat('b', 64);
  j jsonb;
  settled jsonb;
  invalid_result jsonb;
  counts jsonb := '{"status":"confirmed","input_tokens":1000,"output_tokens":250,"total_tokens":1250}';
  response jsonb := '{"reply":"Set the audience and decide the outline."}';
begin
  insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values(u, u::text || '@example.invalid', now(), jsonb_build_object('username','ppt_chat_fixture'));
  update public.credit_accounts set balance=20, total_spent=0, total_refunded=0 where user_id=u;

  j := public.begin_ppt_request(u,rid,'gpt-6.2-astra','chat',fp,1500,1000);
  assert j->>'leader'='true' and j#>>'{request,kind}'='chat';
  assert public.begin_ppt_request(u,rid,'gpt-6.2-astra','chat',fp,1500,1000)->>'leader'='false';
  assert public.begin_ppt_request(u,rid,'gpt-6.2-astra','generate',fp,1500,1000)->>'code'='PPT_REQUEST_CONFLICT';
  for invalid_result in select * from jsonb_array_elements(
    '[{},{"reply":""},{"reply":"   \t\n"},{"reply":null},{"reply":[]},{"reply":3},{"deck":{}},{"reply":"ok","deck":{}}]'
  ) loop
    begin
      perform public.finish_ppt_request(u,rid,invalid_result,counts,null);
      raise exception 'unexpected chat result accepted';
    exception when raise_exception then
      if sqlerrm <> 'invalid PPT result' then raise; end if;
    end;
  end loop;
  assert public.read_ppt_request(u,rid)#>>'{request,billing,status}'='held';
  settled := public.finish_ppt_request(u,rid,response,counts,null);
  assert settled#>>'{request,status}'='succeeded';
  assert settled#>>'{request,reply}'=response->>'reply';
  assert (settled#>>'{request,billing,charged_credits}')::numeric=0.108;
  assert public.read_ppt_request(u,rid)=settled;
  assert public.finish_ppt_request(u,rid,null,null,'PPT_RESULT_EXPIRED')=settled;

  rid := gen_random_uuid();
  perform public.begin_ppt_request(u,rid,'gpt-6.2-sol','chat',fp,1500,1000);
  j := public.finish_ppt_request(u,rid,null,null,'PPT_RESULT_INVALID');
  assert j#>>'{request,status}'='failed' and j#>>'{request,billing,status}'='refunded';
  assert public.finish_ppt_request(u,rid,response,counts,null)=j;

  rid := gen_random_uuid();
  perform public.begin_ppt_request(u,rid,'deepseek-v4.1-flash','chat',fp,1500,1000);
  j := public.finish_ppt_request(u,rid,response,'{"status":"missing"}',null);
  assert j#>>'{request,reply}'=response->>'reply' and j#>>'{request,billing,status}'='refunded';
  assert (select count(*)=1 from public.credit_transactions where user_id=u
          and metadata->>'kind'='chat' and type='spend');
  assert (select balance=19.892 and total_spent=0.108 from public.credit_accounts where user_id=u);
end;
$$;
rollback;
