-- Exercise streamed-stage reservations, checkpoints, and retries through the public service RPCs.
begin;
set local plpgsql.check_asserts = on;
do $$
declare
  owner_id uuid := gen_random_uuid();
  outline_id uuid := gen_random_uuid();
  interrupted_id uuid := gen_random_uuid();
  finished_id uuid := gen_random_uuid();
  fp text := repeat('f',64);
  usage jsonb := '{"status":"confirmed","input_tokens":1000,"output_tokens":250,"total_tokens":1250}';
  outline_result jsonb := '{"outline":{"title":"Test","slides":[{"title":"Intro","brief":"Tell the audience about the findings."}]}}';
  page_result jsonb := '{"slide":{"id":"s1","title":"Intro","background":"#FFFFFF","elements":[{"id":"title","type":"text","text":"Findings","x":64,"y":64,"w":300,"h":40}]}}';
  job jsonb;
  settled_outline jsonb;
  failed_page jsonb;
  settled_page jsonb;
  invalid_result jsonb;
  stats jsonb;
  report_date date := (now() at time zone 'Asia/Shanghai')::date;
begin
  insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values(owner_id,owner_id::text || '@example.invalid',now(),jsonb_build_object('username','ppt_stages'));
  update public.credit_accounts set balance=20,total_spent=0,total_refunded=0 where user_id=owner_id;

  job := public.begin_ppt_request(owner_id,outline_id,'gpt-6.2-astra','outline',fp,1500,1000);
  assert job->>'leader'='true' and job#>>'{request,kind}'='outline';
  assert public.begin_ppt_request(owner_id,outline_id,'gpt-6.2-astra','outline',fp,1500,1000)->>'leader'='false';
  assert public.begin_ppt_request(owner_id,outline_id,'gpt-6.2-astra','page',fp,1500,1000)->>'code'='PPT_REQUEST_CONFLICT';
  for invalid_result in select * from jsonb_array_elements(
    '[{},{"outline":{}},{"outline":{"title":"Deck","slides":[]}},{"outline":{"title":"Deck","slides":[{"title":"Intro","brief":null}]}},
      {"outline":{"title":"Deck","slides":[{"title":"Intro","brief":"  "}]}}]'
  ) loop
    begin
      perform public.finish_ppt_request(owner_id,outline_id,invalid_result,usage,null);
      raise exception 'accepted incomplete outline';
    exception when raise_exception then
      if sqlerrm <> 'invalid PPT result' then raise; end if;
    end;
  end loop;
  settled_outline := public.finish_ppt_request(owner_id,outline_id,outline_result,
    usage || '{"cache_read_tokens":100,"cache_write_tokens":50}'::jsonb,null);
  assert settled_outline#>'{request,outline}'=outline_result->'outline';
  assert (settled_outline#>>'{request,billing,charged_credits}')::numeric=0.1041;
  assert public.read_ppt_request(owner_id,outline_id)=settled_outline;

  perform public.begin_ppt_request(owner_id,interrupted_id,'gpt-6.2-sol','page',fp,1500,1000);
  failed_page := public.finish_ppt_request(owner_id,interrupted_id,null,null,'PPT_MODEL_TIMEOUT');
  assert failed_page#>>'{request,billing,status}'='refunded' and (failed_page#>>'{request,billing,charged_credits}')::numeric=0;
  assert public.finish_ppt_request(owner_id,interrupted_id,page_result,usage,null)=failed_page;
  assert public.read_ppt_request(owner_id,outline_id)=settled_outline;

  perform public.begin_ppt_request(owner_id,finished_id,'gpt-6.2-sol','page',fp,1500,1000);
  for invalid_result in select * from jsonb_array_elements(
    '[{"slide":{}},{"slide":{"id":"s1","title":"Intro","elements":[]}},{"slide":{"id":"s1","title":"Intro","elements":[{"type":"text"}]}}]'
  ) loop
    begin
      perform public.finish_ppt_request(owner_id,finished_id,invalid_result,usage,null);
      raise exception 'accepted incomplete slide';
    exception when raise_exception then
      if sqlerrm <> 'invalid PPT result' then raise; end if;
    end;
  end loop;
  settled_page := public.finish_ppt_request(owner_id,finished_id,page_result,usage,null);
  assert settled_page#>'{request,slide}'=page_result->'slide' and settled_page#>>'{request,billing,status}'='settled';
  assert (settled_page#>>'{request,billing,charged_credits}')::numeric=0.027;
  assert public.finish_ppt_request(owner_id,finished_id,null,null,'PPT_RESULT_EXPIRED')=settled_page;
  assert (select total_spent=0.1311 and balance=19.8689 from public.credit_accounts where user_id=owner_id);
  assert (select count(*)=2 from public.credit_transactions where user_id=owner_id and type='spend');
  assert (select count(*)=3 from public.credit_transactions where user_id=owner_id and type='reserve');

  stats := public.get_admin_ppt_overview(report_date,report_date,owner_id::text)->'metrics';
  assert stats @> '{"requests":3,"generate":0,"outline":1,"page":2,"completed":2,"failed":1,"input_tokens":2000,"output_tokens":500,"credits":0.1311}';
  assert not has_function_privilege('authenticated','public.finish_ppt_request(uuid,uuid,jsonb,jsonb,text,text)','execute');
  outline_id := gen_random_uuid();
  perform public.begin_ppt_request(owner_id,outline_id,'gpt-6.2-astra','outline',fp,1500,1000);
  job := public.finish_ppt_request(owner_id,outline_id,null,usage,'PPT_RESULT_INVALID','expected 6, received 5');
  assert job#>>'{request,billing,status}'='refunded' and not ((job->'request') ? 'diagnostic');
  assert public.finish_ppt_request(owner_id,outline_id,null,usage,'PPT_RESULT_INVALID','later detail')=job;
  assert (select count(*)=1 from public.credit_transactions where user_id=owner_id and type='refund'
          and metadata->>'request_id'=outline_id::text);
  assert exists (select from jsonb_array_elements(public.get_admin_ppt_overview(report_date,report_date,owner_id::text)->'jobs') j
    where j->>'request_id'=outline_id::text and j->>'diagnostic'='expected 6, received 5');
end;
$$;
rollback;
