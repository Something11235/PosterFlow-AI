# 生成图片自动清理

- 保留时间：至少 12 小时。Supabase Cron 每小时第 17 分钟检查一次，正常情况下图片会在生成约 12～13 小时后删除。
- 范围：配置的私有 bucket 中 `posterflow/<scope>/images/*.png` 的生成图片，依据 `storage.objects.created_at`，不依据文件名日期或最后下载时间。
- 不删除参考图、账号、积分、任务记录、其他 bucket 或 Vercel Blob 文件，不修改前端界面。
- 每批最多 100 张，每次最多 1,000 张。积压超过上限时留到下次处理；失败会记录为 Cron 失败，下次重试。下载不会延长保留期。
- 真正删除通过 Storage API，不能用 `DELETE FROM storage.objects` 代替，否则可能留下仍计费的对象文件。
- 计划、筛选和 API 删除均在 Supabase 端执行，不下载图片，也不经过 Vercel。

## 安装与凭据配置

1. 按顺序执行迁移 `supabase/migrations/20261018014328_image_retention_24h.sql` 和后续的 `supabase/migrations/20261018014700_image_retention_12h.sql`。后者将保留期缩短至 12 小时并替换旧 Cron；初始为停用状态，避免凭据尚未配置就开始执行。不要修改或重复执行已经执行的迁移。
2. 在有服务端环境变量的可信环境执行 `python scripts/configure_image_retention.py`。脚本验证私有 bucket，然后通过仅允许 `service_role` 的 RPC 将已有 Storage 凭据存入 Supabase Vault；不会输出密钥或写入 Git。轮换服务端凭据后需重新执行此脚本。
3. 通过 Supabase SQL Editor 执行：

```sql
-- 只统计；不会删除。
select private.prune_generated_images(true);
-- 授权 12 小时保留策略后，验证一次实际删除。
select private.prune_generated_images(false);
-- 启用定时任务。
select cron.alter_job(
  (select jobid from cron.job where jobname='posterflow-image-retention-12h'),
  active := true
);
```

`private.prune_generated_images` 使用 SECURITY INVOKER，只供 Postgres 管理员和 Cron 所有者执行；应用角色不能调用。配置 RPC 不向匿名或登录用户授权，Vault 凭据不出现在定时任务 SQL、日志或返回值中。

## 查看状态与停用

```sql
select jobname,schedule,active from cron.job
where jobname='posterflow-image-retention-12h';

select started_at,finished_at,cutoff,deleted_objects,deleted_bytes
from private.image_retention_runs order by id desc limit 10;

select status,start_time,end_time,return_message from cron.job_run_details
where jobid=(select jobid from cron.job where jobname='posterflow-image-retention-12h')
order by start_time desc limit 10;

-- 停用，不删除任务和 Vault 配置。
select cron.alter_job(
  (select jobid from cron.job where jobname='posterflow-image-retention-12h'),
  active := false
);
```

回滚网站版本不会停用独立运行的 Supabase Cron，需单独执行停用命令。停用不能恢复已删除的图片。删除图片只减少后续存储占用，不会抵扣已经产生的出站流量；保留 12 小时也不能保证高访问量下永不超额。清理审计与该任务的 Cron 历史保留 30 天。

官方参考：[Cron](https://supabase.com/docs/guides/cron/quickstart)、[HTTP 扩展](https://supabase.com/docs/guides/database/extensions/http)、[Vault](https://supabase.com/docs/guides/database/vault)。
