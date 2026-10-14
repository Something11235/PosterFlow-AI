# Supabase Storage 图片迁移

图片 bucket 必须设为私有。浏览器不访问 Storage API；预览、下载和局部重绘继续由 Flask 后端代理，Service Role/Secret Key 只配置在服务端。

## 配置

1. 在 Supabase Dashboard 的 Storage 页面创建私有 bucket，建议命名为 `posterflow-images`。
2. 在 Vercel 项目的 Production 环境变量中设置：

```text
IMAGE_STORAGE_BACKEND=supabase
SUPABASE_STORAGE_BUCKET=posterflow-images
```

3. 确认服务端已有 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`（新式 Secret Key 也可使用 `SUPABASE_SECRET_KEY`）。这些变量不得添加 `VITE_` 前缀。
4. 保留 `BLOB_READ_WRITE_TOKEN` 作为旧图片读取回退，直到数据复制并验收完成。

`IMAGE_STORAGE_BACKEND=auto` 会依次选择 Supabase Storage、Vercel Blob、本地文件系统。线上正式切换建议显式设置为 `supabase`，避免环境变量缺失时悄悄写入其他存储。

## 复制旧图片

先在本地 `.env`（不要提交）配置 Supabase 服务端变量和 `BLOB_READ_WRITE_TOKEN`。先查看对象数量：

```powershell
python scripts/migrate_vercel_blob_to_supabase.py --dry-run
```

复制全部 `posterflow/` 对象；默认不会删除源 Blob，可以安全重复运行：

```powershell
python scripts/migrate_vercel_blob_to_supabase.py --execute
```

只有在确认复制完成且不再需要回滚后，才考虑显式使用 `--execute --delete-source`。建议先不要删除源对象，并在 Vercel 部署后检查 `/api/health` 的 `storage_backend` 为 `supabase-storage`，再验证生成、预览、单张下载、批量下载、局部重绘和管理员清理。

## 切换完成后

确认 Supabase 对象完整且线上功能正常后，可从 Vercel 删除 `BLOB_READ_WRITE_TOKEN`。这会关闭旧 Blob 回退；不要在验证前移除该变量。Bucket 中的对象不会通过公开 URL 暴露，API 鉴权和现有用户存储命名空间保持不变。
