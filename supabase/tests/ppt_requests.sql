-- Synthetic users only. This transaction rolls back every change.
begin;
insert into auth.users (id,email,email_confirmed_at,raw_user_meta_data) values
  ('ed000000-0000-4000-8000-000000000001','ppt-test@example.invalid',now(),'{"username":"ppt_billing_fixture"}');
update public.credit_accounts set balance=20,total_spent=0,total_refunded=0
  where user_id='ed000000-0000-4000-8000-000000000001';
do $$
declare u uuid:='ed000000-0000-4000-8000-000000000001'; rid uuid; item record; j jsonb;
  use_tokens jsonb:='{"status":"confirmed","input_tokens":10000,"output_tokens":1000,"cache_read_tokens":8000,"total_tokens":11000}';
  deck jsonb:='{"deck":{"title":"fixture","slides":[]}}';
begin
  assert not has_function_privilege('authenticated','public.begin_ppt_request(uuid,uuid,text,text,text,integer,integer)','EXECUTE');
  assert not has_function_privilege('anon','public.read_ppt_request(uuid,uuid)','EXECUTE');
  assert has_function_privilege('service_role','public.finish_ppt_request(uuid,uuid,jsonb,jsonb,text)','EXECUTE');
  assert not has_table_privilege('authenticated','private.ppt_requests','SELECT');
  for item in select * from (values ('gpt-6.2-astra',0.3552),('gpt-6.2-sol',0.0888),
    ('deepseek-v4.1-flash',0.0740)) prices(model,expected) loop
    rid:=gen_random_uuid();
    j:=public.begin_ppt_request(u,rid,item.model,'generate',repeat('a',64),15000,2000);
    assert j->>'leader'='true' and j#>>'{request,billing,status}'='held';
    j:=public.begin_ppt_request(u,rid,item.model,'generate',repeat('a',64),15000,2000);
    assert j->>'leader'='false' and j#>>'{request,status}'='processing';
    assert public.begin_ppt_request(u,rid,item.model,'generate',repeat('b',64),15000,2000)->>'code'='PPT_REQUEST_CONFLICT';
    j:=public.finish_ppt_request(u,rid,deck,use_tokens,null);
    assert j#>>'{request,status}'='succeeded' and (j#>>'{request,billing,charged_credits}')::numeric=item.expected;
    assert public.finish_ppt_request(u,rid,null,null,'PPT_RESULT_EXPIRED')=j;
    assert public.read_ppt_request(u,rid)=j;
    assert public.read_ppt_request(gen_random_uuid(),rid)->>'code'='PPT_NOT_FOUND';
  end loop;
  assert (select balance=19.4820 and total_spent=0.5180 from public.credit_accounts where user_id=u);
  -- Cache writes are reported inside total input. Only the written subset earns
  -- the write price; the 8k read and the other 1k input keep their own rates.
  rid:=gen_random_uuid();
  j:=public.begin_ppt_request(u,rid,'gpt-6.2-astra','generate',repeat('a',64),15000,2000);
  assert (j#>>'{request,billing,reserved_credits}')::numeric=1.3800;
  j:=public.finish_ppt_request(u,rid,deck,use_tokens||'{"cache_write_tokens":1000}',null);
  assert (j#>>'{request,billing,charged_credits}')::numeric=0.3672;
  assert (j#>>'{request,billing,usage,cache_write_tokens}')::integer=1000;
  for item in select * from (values
    ('{"status":"missing"}'::jsonb,deck,'PPT_USAGE_UNCONFIRMED'),
    (use_tokens||'{"cache_read_tokens":12000}'::jsonb,deck,'PPT_USAGE_UNCONFIRMED'),
    (use_tokens||'{"cache_write_tokens":2500}'::jsonb,deck,'PPT_USAGE_UNCONFIRMED'),
    (use_tokens||'{"output_tokens":900000,"total_tokens":910000}'::jsonb,deck,'PPT_USAGE_UNCONFIRMED'),
    (use_tokens,null::jsonb,'PPT_RESULT_INVALID')) cases(usage,doc,err) loop
    rid:=gen_random_uuid();
    perform public.begin_ppt_request(u,rid,'gpt-6.2-astra','generate',repeat('a',64),15000,2000);
    j:=public.finish_ppt_request(u,rid,item.doc,item.usage,case when item.doc is null then item.err end);
    assert j#>>'{request,error_code}'=item.err and j#>>'{request,billing,status}'='refunded';
    assert (j#>>'{request,billing,charged_credits}')::numeric=0;
    assert (j#>>'{request,status}'='succeeded')=(item.doc is not null);
  end loop;
  rid:=gen_random_uuid();
  perform public.begin_ppt_request(u,rid,'gpt-6.2-sol','edit',repeat('a',64),15000,2000);
  update private.ppt_requests set created_at=now()-interval '16 minutes' where user_id=u and request_id=rid;
  j:=public.read_ppt_request(u,rid);
  assert j#>>'{request,error_code}'='PPT_RESULT_EXPIRED' and j#>>'{request,billing,status}'='refunded';
  assert public.finish_ppt_request(u,rid,'{"slide":{"title":"late"}}'::jsonb,use_tokens,null)=j;
  assert (select count(*)=4 from public.credit_transactions where user_id=u and metadata->>'media_type'='ppt' and type='spend');
  assert (select balance=19.1148 and total_spent=0.8852 from public.credit_accounts where user_id=u);
  update public.credit_accounts set balance=0 where user_id=u;
  assert public.begin_ppt_request(u,gen_random_uuid(),'gpt-6.2-sol','edit',repeat('a',64),15000,2000)->>'code'='INSUFFICIENT_CREDITS';
end;
$$;
rollback;
