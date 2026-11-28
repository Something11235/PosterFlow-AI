begin;
set local plpgsql.check_asserts=on;
do $$
declare
  owner_id uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid(); fingerprint text:=repeat('f',64);
  receipt jsonb; replay jsonb; original jsonb;
  counts jsonb:='{"status":"confirmed","input_tokens":1000,"output_tokens":100,"total_tokens":1100,"cache_read_tokens":400,"cache_miss_tokens":600}';
  shot jsonb:='{"title":"开门","description":"天刚亮","camera":"固定近景","duration":5,"imagePrompt":"门前","videoPrompt":"推开门"}';
  model_id text:='gpt-6.2-astra';
  astra jsonb:='[{"model":"gpt-6.2-astra","outcome":"succeeded"}]';
  sol jsonb:='[{"model":"gpt-6.2-astra","outcome":"timeout"},{"model":"gpt-6.2-sol","outcome":"succeeded"}]';
  flash jsonb:='[{"model":"gpt-6.2-astra","outcome":"unavailable"},{"model":"gpt-6.2-sol","outcome":"timeout"},{"model":"deepseek-v4.1-flash","outcome":"succeeded"}]';
begin
  insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(
    owner_id,owner_id::text||'@example.invalid',now(),jsonb_build_object('username','canvas_text_fixture'));
  update public.credit_accounts set balance=10,total_spent=0,total_refunded=0 where user_id=owner_id;
  receipt:=public.begin_canvas_text_request(owner_id,rid,model_id,'storyboard',fingerprint,2000,1000);
  assert receipt->>'leader'='true' and (receipt#>>'{request,billing,reserved_credits}')::numeric=0.36;
  assert public.begin_canvas_text_request(owner_id,rid,model_id,'storyboard',fingerprint,2000,1000)->>'leader'='false';
  assert public.begin_canvas_text_request(owner_id,rid,model_id,'prompt',fingerprint,2000,1000)->>'code'='CANVAS_AI_REQUEST_CONFLICT';
  assert public.read_canvas_text_request(gen_random_uuid(),rid)->>'code'='CANVAS_AI_NOT_FOUND';
  begin
    perform public.finish_canvas_text_request(owner_id,rid,'{"shots":[{}]}',counts,null,model_id,astra);
    raise exception 'invalid shot charged';
  exception when raise_exception then
    if sqlerrm<>'invalid canvas shot' then raise; end if;
  end;
  begin
    perform public.finish_canvas_text_request(owner_id,rid,jsonb_build_object('shots',jsonb_build_array(shot)),
      counts,null,'gpt-6.2-sol',jsonb_build_array(sol->1));
    raise exception 'skipped primary accepted';
  exception when raise_exception then
    if sqlerrm<>'invalid canvas attempts' then raise; end if;
  end;
  original:=public.finish_canvas_text_request(owner_id,rid,jsonb_build_object('shots',jsonb_build_array(shot)),counts,null,'deepseek-v4.1-flash',flash);
  assert original#>'{request,shots,0}'=shot and (original#>>'{request,billing,charged_credits}')::numeric=0.0121;
  assert original#>>'{request,model}'='deepseek-v4.1-flash' and original#>'{request,attempts}'=flash;
  assert public.begin_canvas_text_request(owner_id,rid,model_id,'storyboard',fingerprint,2000,1000)->'request'=original->'request';
  replay:=public.finish_canvas_text_request(owner_id,rid,null,null,'CANVAS_AI_RESULT_INVALID',null,'[]');
  assert replay=original and public.read_canvas_text_request(owner_id,rid)=original;
  assert (select count(*)=3 from public.credit_transactions where user_id=owner_id and metadata->>'media_type'='canvas');
  assert (select count(*)=2 from public.credit_transactions where user_id=owner_id
    and type in ('spend','refund') and metadata->>'model'='deepseek-v4.1-flash' and metadata->'attempts'=flash);
  rid:=gen_random_uuid();
  perform public.begin_canvas_text_request(owner_id,rid,model_id,'prompt',fingerprint,2000,1000);
  receipt:=public.finish_canvas_text_request(owner_id,rid,'{"prompt":"提示词"}',
    counts||'{"cache_write_tokens":200}',null,'gpt-6.2-sol',sol);
  -- 400 uncached ×12 + 200 writes ×15 + 400 hits ×0.6 + 100 output ×60 = .01404.
  assert (receipt#>>'{request,billing,charged_credits}')::numeric=0.0141;
  assert receipt#>>'{request,model}'='gpt-6.2-sol' and receipt#>'{request,attempts}'=sol;
  rid:=gen_random_uuid();
  perform public.begin_canvas_text_request(owner_id,rid,model_id,'prompt',fingerprint,2000,1000);
  receipt:=public.finish_canvas_text_request(owner_id,rid,'{"prompt":"最初镜头"}',
    counts||'{"cache_write_tokens":200}',null,model_id,astra);
  assert (receipt#>>'{request,billing,charged_credits}')::numeric=0.0562;
  assert (receipt#>>'{request,billing,usage,cache_write_tokens}')::numeric=200;
  rid:=gen_random_uuid();
  perform public.begin_canvas_text_request(owner_id,rid,model_id,'prompt',fingerprint,2000,1000);
  receipt:=public.finish_canvas_text_request(owner_id,rid,null,null,'CANVAS_AI_PROVIDER_FAILED','deepseek-v4.1-flash',
    jsonb_set(flash,'{2,outcome}','"unavailable"'));
  assert receipt#>>'{request,status}'='failed' and receipt#>>'{request,billing,status}'='refunded'
    and (receipt#>>'{request,billing,charged_credits}')::numeric=0;
  assert (select count(*)=2 and sum(delta)=0 from public.credit_transactions
    where user_id=owner_id and metadata->>'request_id'=rid::text);
  rid:=gen_random_uuid();
  perform public.begin_canvas_text_request(owner_id,rid,model_id,'prompt',fingerprint,2000,1000);
  receipt:=public.finish_canvas_text_request(owner_id,rid,'{"prompt":"提示词"}','{"status":"missing"}',null,model_id,astra);
  assert receipt#>>'{request,status}'='succeeded' and receipt#>>'{request,error_code}'='CANVAS_AI_USAGE_UNCONFIRMED';
  rid:=gen_random_uuid();
  perform public.begin_canvas_text_request(owner_id,rid,model_id,'prompt',fingerprint,2000,1000);
  update private.canvas_text_requests set created_at=now()-interval '16 minutes' where user_id=owner_id and request_id=rid;
  receipt:=public.read_canvas_text_request(owner_id,rid);
  assert receipt#>>'{request,billing,status}'='refunded' and receipt#>>'{request,error_code}'='CANVAS_AI_RESULT_EXPIRED';
  assert (select balance=9.9176 and total_spent=0.0824 from public.credit_accounts where user_id=owner_id);
  assert not has_function_privilege('authenticated','public.finish_canvas_text_request(uuid,uuid,jsonb,jsonb,text,text,jsonb)','execute');
  assert not has_function_privilege('anon','public.read_canvas_text_request(uuid,uuid)','execute');
end;
$$;
rollback;
