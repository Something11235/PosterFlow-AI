# PosterFlow AI 项目交接文档

> 用途：在上下文过长、需要新开对话继续开发时，交给下一位开发者快速恢复上下文。
> 当前快照日期：2026-09-10
> 当前分支：`main`

## 1. 项目定位

PosterFlow AI 是一个面向企业出海招商海报、以及通用图片生成的 AI 绘图前端工程。支持：

- 提示词编辑、预设库、自定义预设与封面
- 文生图 / 图生图 / 局部重绘 / 无限画布
- 多服务商 Key（JOJO Code、米醋 API、OpenRouter、自定义 OpenAI 兼容服务）
- 历史记录、批量导出、图片下载、放大预览、复制提示词
- 正在迭代中的：Supabase 用户注册登录、邮箱验证、免费积分、平台限额密钥扣费、运营统计

已上线地址：

- 生产：https://www.posterflow-ai.xyz
- 代码仓库：https://github.com/Something11235/PosterFlow-AI

## 2. 工作区与技术栈

工作区路径：

```text
D:\Projects\Codex工作台\AI绘画程序
```

技术栈：

- 前端：React 19 + Vite 8 + Tailwind CSS 4 + Fabric.js + lucide-react + Supabase JS
- 后端：Flask 3 + flask-cors + requests + PyJWT + gunicorn，兼容 Vercel Serverless Functions（`api/index.py`）
- 数据库：Supabase（Postgres + Auth）
- 部署：Vercel，本地开发脚本为 `start-dev.bat`、`build.bat`

## 3. 当前 Git 状态

分支：`main`

最近提交：

```text
fd368f6 fix: keep canvas redraw requests within hosting limits
4de5975 fix: restore infinite canvas image rendering
71ba1f0 ci: scan tracked files for API keys
28ff201 release: PosterFlow AI v0.2.0
049c2f8 Add Micu API provider preset
```

当前未提交改动（下一阶段必须接手完成）：

```text
M .env.example
M backend/requirements.txt
M backend/server.py
M frontend/package-lock.json
M frontend/package.json
M frontend/src/App.jsx
M frontend/src/components/ProviderSettings.jsx
M frontend/src/components/Sidebar.jsx
M frontend/src/lib/provider.js
M requirements.txt
?? backend/supabase_service.py
?? frontend/src/components/AccountPanel.jsx
?? frontend/src/components/AdminMetricsPanel.jsx
?? frontend/src/components/AuthModal.jsx
?? frontend/src/lib/supabase.js
?? supabase/
```

这些改动尚未提交，也尚未推送 GitHub / Vercel。

## 4. 本地开发命令

使用 PowerShell：

```powershell
# 首次或依赖变化后安装依赖（建议使用项目虚拟环境，见 start-dev.bat）
cd "D:\Projects\Codex工作台\AI绘画程序"

# 启动后端
python backend/server.py

# 启动前端开发服务器
cd frontend
npm install
npm run dev
```

也可以直接运行：

```powershell
.\start-dev.bat
```

`start-dev.bat` 会创建/使用项目内虚拟环境，不污染系统 Python；删除项目目录即可卸载该虚拟环境。

常用验证命令：

```powershell
# 后端单测
python -m unittest discover -s tests -v

# 前端 lint 与生产构建
cd frontend
npm run lint
npm run build
```

## 5. 环境变量与密钥安全

`.env.example` 是模板，只允许占位符和空值，禁止提交真实密钥。

服务端变量（只放在 Vercel / 本机环境变量，绝不能进前端 bundle 或日志）：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_JWT_SECRET
PLATFORM_IMAGE_API_KEY
PLATFORM_IMAGE_API_ENDPOINT
PLATFORM_IMAGE_MODEL=gpt-image-2.5-flare
PLATFORM_IMAGE_AUTH_TYPE
PLATFORM_DAILY_IMAGE_LIMIT
USER_DAILY_IMAGE_LIMIT
ADMIN_USER_IDS
BLOB_READ_WRITE_TOKEN
```

浏览器安全变量（可以 `VITE_` 开头）：

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
VITE_TURNSTILE_SITE_KEY
```

红线：

- 用户自己的 API Key 只能保存在浏览器 `sessionStorage`，不得进数据库、历史记录、日志或前端 bundle。
- `SUPABASE_SERVICE_ROLE_KEY` 和 `PLATFORM_IMAGE_API_KEY` 永远只能服务端读取。
- 不要把 access token 拼进图片 URL；已登录用户的图片资源通过服务端 cookie 鉴权。

## 6. 已完成的实现

后端：

- `backend/supabase_service.py`：Supabase 数据访问层，含注册赠送积分、积分预留/结算/退款、自有 Key 记录、账户快照、管理统计。
- `backend/server.py`：已接入 Supabase Bearer 鉴权、`/api/auth/session`、`/api/account`、`/api/admin/metrics`、平台积分模式、请求幂等、速率限制、登录用户的分目录存储。
- `supabase/migrations/20260910_001_posterflow_auth_credits.sql`：`profiles`、`credit_accounts`、`generation_jobs`、`credit_transactions`、RLS、RPC 函数、管理统计函数。
- 默认模型已迁移为 `gpt-image-2.5-flare`。

前端：

- `frontend/src/lib/supabase.js`：Supabase 客户端初始化。
- `frontend/src/components/AuthModal.jsx`：登录、注册、找回密码、重置密码、显示/隐藏密码、Esc 关闭。
- `frontend/src/components/AccountPanel.jsx`：个人资料、邮箱验证状态、积分余额、收支明细、退出、删除账号。
- `frontend/src/components/AdminMetricsPanel.jsx`：只读管理统计面板，拉取 `/api/admin/metrics`。
- `frontend/src/components/ProviderSettings.jsx`：已加 `platform` / `own_key` 两个计费模式 Tab。
- `frontend/src/components/Sidebar.jsx`：已加账户入口、积分、管理统计入口的组件逻辑。

## 7. 必须继续完成的待办

### 7.1 前端 `App.jsx` 尚未接完

文件：`frontend/src/App.jsx`

已知会阻塞页面运行的 Bug：

- `handleGenerate` 的 `useCallback` 依赖数组里错误地写入了 `previousHistoryId` 和 `previousImages`。这两个是函数块内局部变量，而依赖数组在组件作用域求值，因此组件渲染时会抛出 `ReferenceError`，页面无法显示。请删除这两项。
- 实测补充（2026-09-10）：`npm run lint` 目前退出码为 0，只给出 11 条警告；`npm run build` 也能成功。也就是说，构建通过不代表页面可运行，这个运行时错误必须优先修掉。

其余待办：

- `handleGenerate` 开头的顺序有问题：当前先检查 `providerConfigured`，会拦住平台模式下"未登录/邮箱未验证"的专属提示。建议平台模式先调用 `requireGenerationAccess()`，自有 Key 模式再检查 provider 配置。
- `handleModify` 中存在未定义变量 `nextError`。当前代码用了 `if (nextError.code === ...)`，但只把归一化错误传给了 `setError`。应先 `const nextError = normalizeApiError(...)`，再据此判断 `EMAIL_UNVERIFIED` 等状态。
- `handleGenerate` / `handleModify` 已初步加入 `request_id` 和 `X-Request-Id`，需要继续确保幂等和账户刷新逻辑完整。
- 尚未接线的组件和回调：
  - `Sidebar` 需要传入 `session`、`account`、`onOpenAuth`、`onOpenAccount`、`onOpenMetrics`。
  - `ProviderSettings` 需要传入 `billingMode`、`onBillingModeChange`、`platformReady`、`session`、`account`。
  - `AuthModal`、`AccountPanel`、`AdminMetricsPanel` 已 import，但还没有在 JSX 根节点渲染。
  - 需要新增 `handleSignOut`（调用 `DELETE /api/auth/session`，再 `supabase.auth.signOut()`，清空 `session/account`，关闭账户面板）。
  - 需要新增 `handleDeleteAccount`（调用 `DELETE /api/account`，再登出并清空状态）。
  - `handleDownloadBatch` 目前只带 `CLIENT_HEADERS`，登录用户应改用 `authHeaders`，以便读取按用户隔离的图片文件。

### 7.2 无限画布计费接入

文件：`frontend/src/components/FabricCanvasWorkspace.jsx`

当前只传入：

```text
galleryImages, pendingImport, onImportHandled, onNotice,
providerConfigured, providerName, providerHeaders, onOpenProvider, onCanvasGenerated
```

需要新增并接入：

- `billingMode`
- `onAuthRequired`（平台模式未登录时触发，返回后中断生成）
- `onAccountRefresh`（成功或失败后刷新账户积分）

画布内部发起 `/api/generate` 或 `/api/modify` 时，需要：

- 生成 `request_id`，同时放入 body 和 `X-Request-Id` 头。
- `providerHeaders` 已经包含 `Authorization` 和 `X-Billing-Mode`，保持沿用。
- 成功和失败后都刷新账户，失败时尤其要体现自动退款后的余额。

同时在 `App.jsx` 调用 `CanvasWorkspace` 处补上这些回调。

### 7.3 登录用户的图片资源 URL

文件：`frontend/src/lib/client.js`

当前：

```js
export function apiAssetUrl(kind, filename) {
  const safeFilename = encodeURIComponent(filename);
  return `/api/${kind}/${safeFilename}?client_id=${encodeURIComponent(CLIENT_ID)}`;
}
```

这个 `client_id` 是匿名浏览器作用域，会与登录用户的分目录存储冲突。

建议：

```js
export function apiAssetUrl(kind, filename, authenticated = false) {
  const safeFilename = encodeURIComponent(filename);
  if (authenticated) return `/api/${kind}/${safeFilename}`;
  return `/api/${kind}/${safeFilename}?client_id=${encodeURIComponent(CLIENT_ID)}`;
}
```

需要把"是否使用已登录作用域"贯穿到以下调用方：

```text
frontend/src/components/Gallery.jsx
frontend/src/components/History.jsx
frontend/src/components/ImageModal.jsx
frontend/src/components/FabricCanvasWorkspace.jsx
```

注意：`<img>` 不能带 Authorization 头，因此必须依赖 `/api/auth/session` 建立的服务端 cookie。不要在 URL 里放 access token。最稳妥的做法是：存在已登录 session 时，加载资源不带 `client_id`，用服务端 cookie 鉴权。

### 7.4 后端已知修复

文件：`backend/supabase_service.py`

- `account_snapshot()` 当前调用 `self.ensure_signup_bonus(user_id)` 但没有保存返回值，返回的 snapshot 也没有 `signup_bonus`。请改为 `bonus = self.ensure_signup_bonus(user_id)`，并在返回字典中加入 `"signup_bonus": bonus`。
- `account_snapshot()` 返回内容缺少 `email` 和 `email_verified`。`/api/account` 和 `AccountPanel` 都在期待这些字段。`email` 可从已验证的 token claims 取；`email_verified` 不要凭 claims 臆测，应由服务端调用 Supabase Auth admin 接口读取该用户的 `email_confirmed_at` 后再返回布尔值。

文件：`backend/server.py`

- `execute_generation()` 返回值没有 `provider`，而 `/api/generate` 和 `/api/modify` 在得到结果后又重新 `resolve_provider_config(...)`。请让 `execute_generation()` 返回 `"provider": provider`（含幂等分支），路由侧改用 `execution["provider"]`。
- 孤儿文件问题：`generate_images()` 会先保存图片，再执行 Supabase `settle_generation`。如果结算失败，用户被退款但新图片文件仍留在存储中。请在生成出图片但结算失败时清理刚创建的图片文件/blob；不要删除幂等返回的旧图片。
- `set_optional_storage_scope()` / `require_authenticated_user()` 需要确认登录用户的历史记录和图片都正确使用 `user-{id}` 作用域，blob key 也要按用户隔离。

### 7.5 Supabase SQL 迁移复核

文件：`supabase/migrations/20260910_001_posterflow_auth_credits.sql`

已包含 profiles、accounts、ledger、jobs、注册触发器、注册赠送积分、积分预留/结算/退款、自有 Key 记录、RLS、统计 RPC。

需要复核：

- `with (security_invoker = true)` 在当前 Supabase Postgres 版本是否支持。
- `ensure_signup_bonus` 的并发控制和唯一索引是否确实阻止重复赠送。
- 管理权限：后端支持 `ADMIN_USER_IDS` 或 profile role 为 `admin`；把用户设为 admin 的操作必须是服务端行为，不能暴露给浏览器。
- 所有 RPC 是否都从 `public` / `anon` / `authenticated` revoke，只允许 service role 调用。

### 7.6 README

用户要求：

- 保留现有 README 主体内容，不要大范围重写。
- 只在合适位置补充"无限画布"使用说明。
- 不要为 Supabase 部署加入冗长手册，除非确有必要。

## 8. 安全扫描

提交前必须执行：

```powershell
git status --short
git grep -n -i -E "sk-[A-Za-z0-9]|api[_-]?key\s*=\s*[^$[:space:]]+|service_role"
```

人工检查 `.env.example`：

- 只允许空值/占位符。
- 敏感后端值不能以 `VITE_` 开头。

## 9. 提交 / 推送前检查清单

必须全部通过后才能提交、推送和部署：

- [ ] `python -m unittest discover -s tests -v` 通过
- [ ] `cd frontend; npm run lint` 通过
- [ ] `cd frontend; npm run build` 通过
- [ ] `App.jsx` 依赖数组 Bug 已修复
- [ ] 登录/账户/积分/管理统计组件已完整接线
- [ ] 无限画布平台计费已接入
- [ ] 登录用户图片资源鉴权正确
- [ ] 后端 `account_snapshot`、`execute_generation` 修复完成
- [ ] Supabase 迁移复核通过
- [ ] 密钥安全扫描无命中
- [ ] 未向 Git 或 Vercel 暴露真实密钥

## 10. 建议的下一步顺序

1. 先修复 `App.jsx` 依赖数组和 `nextError`，跑通 `npm run lint` 与 `npm run build`。
2. 接线 `Sidebar`、`ProviderSettings`、`AuthModal`、`AccountPanel`、`AdminMetricsPanel` 和登出/删除账号回调。
3. 接入无限画布的计费与账户刷新。
4. 修复后端 `account_snapshot` 与 `execute_generation`，并处理孤儿文件。
5. 处理登录用户的图片资源作用域。
6. 复核 Supabase 迁移。
7. 按 README 要求补无限画布说明。
8. 跑完整测试、构建、安全扫描，再提交、推送 GitHub 与 Vercel。

## 11. 交接文档复核结论（2026-09-10）

已逐条对照当前工作区复核，以下结论保持不变：

- 分支仍为 `main`，工作区仍有第 3 节列出的未提交改动，`HANDOFF.md` 本身也是未跟踪新文件。
- `App.jsx` 的 `handleGenerate` 依赖数组仍包含 `previousHistoryId`、`previousImages`；`handleModify` 仍在未定义 `nextError` 的情况下访问其 `.code`。
- 实测：`frontend` 下 `npm run lint` 退出码为 0（11 条警告，含上述两个依赖项警告）；`npm run build` 成功。依赖数组问题属于运行时 `ReferenceError`，不会被构建阶段拦截。
- `App.jsx` 仍未向 `Sidebar`、`ProviderSettings` 传入账户/计费相关 props；`AuthModal`、`AccountPanel`、`AdminMetricsPanel` 仍未渲染；`handleSignOut`、`handleDeleteAccount` 仍不存在。
- `FabricCanvasWorkspace.jsx` 的画布 AI 请求仍未携带 `request_id` / `X-Request-Id`，也没有平台模式的登录拦截和账户刷新回调。
- `frontend/src/lib/client.js` 的 `apiAssetUrl()` 仍固定带 `client_id`，尚未区分登录用户作用域。
- 后端 `account_snapshot()` 仍未返回 `signup_bonus`，`/api/account` 仍缺少 `email` / `email_verified`；`execute_generation()` 尚未返回 `provider`，`/api/generate` 与 `/api/modify` 仍在结果后重新解析 provider。
- 以上均为待办，不是已完成项。测试、构建、安全扫描尚未在本轮交接中执行，提交与推送必须等这些检查通过后再进行。
