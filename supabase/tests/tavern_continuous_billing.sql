-- Synthetic-only regression; run after the continuous billing migration.
begin;
do $$ declare u jsonb := '{"status":"confirmed","input_tokens":2850,"output_tokens":237,"total_tokens":3087}'; begin
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u)=0.0228;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_read_tokens":null}')=0.0228;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_miss_tokens":2850}')=0.0228;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_read_tokens":2000}')=0.0111;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_miss_tokens":850}')=0.0111;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_read_tokens":2851}') is null;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"cache_miss_tokens":2851}') is null;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u||'{"status":"invalid"}') is null;
  assert private.quote_tavern_credits('deepseek-v4.1-flash',u-'input_tokens') is null;
end; $$;
rollback;
