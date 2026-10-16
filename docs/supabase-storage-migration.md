# Supabase Storage 图片迁移

图片 bucket 必须设为私有。参考图通过 Flask 生成的一次性 signed upload URL 由浏览器直传 Supabase Storage，浏览器不会接触 Service Role/Secret Key；生成结果的预览、下载仍由 Flask 后端代理。

## 配置

1. 在 Supabase Dashboard 的 Storage 页面创建私有 bucket，建议命名为 `posterflow-images`。
2. 在 Vercel 项目的 Production 环境变量中设置：

```text
IMAGE_STORAGE_BACKEND=supabase
SUPABASE_STORAGE_BUCKET=posterflow-images
```

3. 确认服务端已有 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`（新式 Secret Key 也可使用 `SUPABASE_SECRET_KEY`）。这些变量不得添加 `VITE_` 前缀。
4. 如果还有旧 Vercel Blob 图片，先按下面的迁移脚本复制到 Supabase Storage；应用运行时不再从 Vercel Blob 回退读取。

参考图会临时保存到 `posterflow/{用户或客户端}/references/`。生成接口只接收这些对象路径，服务端读取并校验图片后，在生成成功或失败时删除临时对象。浏览器只拿到单个文件的上传地址，不会把 Base64 图片塞进 Vercel Function 请求体。

`IMAGE_STORAGE_BACKEND=auto` 会优先选择 Supabase Storage，配置不完整时使用本地文件系统。线上建议显式设置为 `supabase`，配置错误时让健康检查直接暴露问题。

## 复制旧图片

先在本地 `.env`（不要提交）配置 Supabase 服务端变量和 `BLOB_READ_WRITE_TOKEN`。先查看对象数量：

```powershell
python scripts/migrate_vercel_blob_to_supabase.py --dry-run
```

复制全部 `posterflow/` 对象；默认不会删除源 Blob，可以安全重复运行：

```powershell
python scripts/migrate_vercel_blob_to_supabase.py --execute
```

只有在确认复制完成且不再需要回滚后，才考虑显式使用 `--execute --delete-source`。部署后检查 `/api/health` 的 `storage_backend` 为 `supabase-storage`，再验证生成、预览、单张下载、批量下载、局部重绘和管理员清理。

## 切换完成后

确认 Supabase 对象完整且线上功能正常后，可从 Vercel 删除 `BLOB_READ_WRITE_TOKEN`。迁移完成后，仍留在旧 Blob 中而未复制的图片将无法通过应用访问；Bucket 中的对象不会通过公开 URL 暴露，API 鉴权和现有用户存储命名空间保持不变。若用户在上传后关闭页面，临时对象可能会暂时保留；管理员执行“清除历史记录”时会一并清理 `posterflow/` 下的对象，因此应继续保留该清理能力。
