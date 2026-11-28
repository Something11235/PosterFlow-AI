begin;
do $$
declare
  owner_id uuid := gen_random_uuid();
  second_id uuid := gen_random_uuid();
  label text := 'overview-ppt-' || left(owner_id::text, 12);
  report_date date := '2093-04-05';
  start_at timestamptz := report_date::timestamp at time zone 'Asia/Shanghai';
  r jsonb;
  m jsonb;
  fn text;
begin
  foreach fn in array array['public.get_admin_ppt_overview(date,date,text,integer)',
                            'private.get_admin_ppt_overview(date,date,text,integer)'] loop
    assert has_function_privilege('service_role', fn, 'execute');
    assert not has_function_privilege('anon', fn, 'execute');
    assert not has_function_privilege('authenticated', fn, 'execute');
  end loop;

  insert into auth.users (id,email,email_confirmed_at,raw_user_meta_data) values
    (owner_id, label || '@example.invalid', now(), '{}'),
    (second_id, label || '-second@example.invalid', now(), '{}');
  update public.profiles set username = 'Beta%_' || label where id = owner_id;
  insert into private.ppt_requests
    (user_id,request_id,fingerprint,model,kind,status,reserved,charged,input_rate,output_rate,cache_rate,usage,result,created_at)
  select owner_id,gen_random_uuid(),repeat('9',64),v.model,v.kind,v.status,4,v.charged,12,60,0.6,v.usage,
         '{"reply":"private test content"}',start_at + v.age
  from (values
    ('gpt-6.2-astra','generate','succeeded',0.0031,'{"status":"confirmed","input_tokens":90,"output_tokens":13}'::jsonb,interval '0 sec'),
    ('gpt-6.2-sol','edit','failed',0,'{"status":"invalid","input_tokens":12}'::jsonb,interval '1 hour'),
    ('gpt-6.2-sol','chat','processing',null,null,interval '23 hours 59 minutes'),
    ('gpt-6.2-sol','generate','succeeded',2,null,interval '1 day'),
    ('gpt-6.2-sol','generate','succeeded',1,null,interval '-1 microsecond')
  ) v(model,kind,status,charged,usage,age);

  r := public.get_admin_ppt_overview(report_date, report_date, 'BETA%_' || label, 1);
  assert r->'metrics' = '{"requests":3,"users":1,"generate":1,"outline":0,"page":0,"edit":1,"chat":1,"completed":1,"failed":1,
                           "pending":1,"input_tokens":90,"output_tokens":13,"credits":0.0031}'::jsonb;
  assert jsonb_array_length(r->'jobs') = 1 and r#>>'{jobs,0,status}' = 'processing';
  assert r#>'{jobs,0,input_tokens}' = 'null'::jsonb and r#>'{jobs,0,charged_credits}' = 'null'::jsonb;
  assert r#>>'{jobs,0,reserved_credits}' is not null;
  select value into strict m from jsonb_array_elements(r->'models') where value->>'model'='gpt-6.2-astra';
  assert (m->>'requests')::int=1 and (m->>'credits')::numeric=0.0031 and (m->>'input_tokens')::int=90;
  assert jsonb_array_length(r->'models')=2;

  r := public.get_admin_ppt_overview(report_date, report_date, owner_id::text);
  assert jsonb_array_length(r->'jobs')=3;
  assert not exists(select 1 from jsonb_array_elements(r->'jobs') j where
                    (j - array['request_id','user_id','username','email','created_at','kind','model','status',
                               'input_tokens','output_tokens','charged_credits','reserved_credits','error_code']) <> '{}');
  r := public.get_admin_ppt_overview(report_date, report_date, label || '-absent');
  assert (r#>>'{metrics,requests}')::int=0 and r->'models'='[]' and r->'jobs'='[]';

  insert into private.ppt_requests
    (user_id,request_id,fingerprint,model,kind,status,reserved,input_rate,output_rate,cache_rate,created_at)
  select second_id,gen_random_uuid(),repeat('8',64),'deepseek-v4.1-flash','chat','processing',1,12,48,0.24,start_at
  from generate_series(1,101);
  r := public.get_admin_ppt_overview(report_date, report_date, upper(label) || '-SECOND@', 1000);
  assert jsonb_array_length(r->'jobs')=100 and (r#>>'{metrics,requests}')::int=101;
  assert (r#>>'{models,0,requests}')::int=101;
  r := public.get_admin_ppt_overview(report_date, report_date, label);
  assert (r#>>'{metrics,users}')::int=2 and (r#>>'{metrics,requests}')::int=104;
end;
$$;
rollback;
