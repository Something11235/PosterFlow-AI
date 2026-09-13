# PosterFlow AI 新对话继续工作提示词

把下面整段内容粘贴到新对话框，即可让新的 Codex 从当前进度继续。

---

你正在继续一个已经有大量上下文积累的生产项目，请先恢复上下文，再动手修改。

## 工作区

```text
D:\Projects\Codex工作台\AI绘画程序
```

## 第一步：必须先读

1. 读取项目根目录的 `HANDOFF.md`，这是上一轮整理的完整交接文档，包含当前 Git 状态、已完成项、全部待办、安全红线和提交前检查清单。
2. 读取以下 UI 规范文档：
   - `C:\Users\Something\.codex\skills\ui-ux-pro-max\SKILL.md`
   - `C:\Users\Something\.codex\skills\frontend-design\SKILL.md`
3. 执行 `git status --short` 和 `git log --oneline -5`，确认工作区状态与交接文档一致。
4. 先阅读将要修改的文件，再动手。不要回退或覆盖用户已有的未提交改动。

## 项目目标

PosterFlow AI 是一个中文 AI 绘图工作台，支持文生图、图生图、局部重绘、无限画布、预设库、历史记录、批量导出，以及多种图片服务商（JOJO Code、米醋 API、OpenRouter、自定义 OpenAI 兼容服务）。

当前迭代的目标是完成 Supabase 用户注册登录与积分体系：

- 用户名 + 邮箱 + 密码注册
- 邮箱验证通过后赠送 10 个免费积分
- 1 张图 = 1 积分
- 平台模式使用服务端限额密钥，扣积分
- 自带 Key 模式使用用户自己的 Key，不扣积分
- 支持积分预留、结算、失败退款、请求幂等、速率限制
- 支持账户中心和管理员运营统计
- 保留现有图片生成、局部重绘、无限画布、预设、历史、导出功能

## 最高优先级待办

严格按照 `HANDOFF.md` 第 7 节执行，建议顺序：

1. 修复 `frontend/src/App.jsx`：
   - 从 `handleGenerate` 的依赖数组中删除 `previousHistoryId`、`previousImages`，它们是块内局部变量，而依赖数组在组件作用域求值，会在渲染时抛出 `ReferenceError`，导致页面无法显示。注意：`oxlint` 和 `vite build` 不会拦截这个运行时错误。
   - 修复 `handleModify` 中未定义 `nextError` 却在访问 `nextError.code` 的问题。
   - 调整生成前检查顺序：平台模式先走 `requireGenerationAccess()`，自有 Key 模式再检查 provider 配置。
   - 接线 `Sidebar`、`ProviderSettings`、`AuthModal`、`AccountPanel`、`AdminMetricsPanel`。
   - 新增 `handleSignOut` 和 `handleDeleteAccount`。
   - `handleDownloadBatch` 改为使用 `authHeaders`，让登录用户能读取自己的隔离图片。
2. 接入 `frontend/src/components/FabricCanvasWorkspace.jsx` 的平台计费：
   - 新增 `billingMode`、`onAuthRequired`、`onAccountRefresh` 等 props。
   - 平台模式未登录时中断请求并触发登录弹窗。
   - 生成请求加入 `request_id` 与 `X-Request-Id`。
   - 成功和失败后都刷新账户积分，失败时体现退款后的余额。
3. 修复登录用户的图片资源作用域：
   - 调整 `frontend/src/lib/client.js` 的 `apiAssetUrl()`，支持登录态不带 `client_id`。
   - 更新 `Gallery.jsx`、`History.jsx`、`ImageModal.jsx`、`FabricCanvasWorkspace.jsx` 的调用。
   - 不要把 access token 放进 URL；已登录用户图片通过服务端 cookie 鉴权。
4. 修复后端：
   - `backend/supabase_service.py` 的 `account_snapshot()` 返回 `signup_bonus`、`email`、`email_verified`。
   - `email_verified` 由服务端读取 Supabase Auth admin 的用户 `email_confirmed_at`，不要凭 claims 臆测。
   - `backend/server.py` 的 `execute_generation()` 返回 `provider`，`/api/generate` 和 `/api/modify` 改用 `execution["provider"]`。
   - 处理结算失败时的孤儿图片文件清理，不能删除幂等返回的旧图片。
5. 复核 `supabase/migrations/20260910_001_posterflow_auth_credits.sql`：
   - 确认 `security_invoker` 兼容性。
   - 确认注册赠送积分的并发安全。
   - 确认所有 RPC 已对 `public` / `anon` / `authenticated` revoke，仅 service role 可调用。
6. README 只补充无限画布使用说明，保持原有主体内容，不要大范围重写。

## 安全红线

- 用户自己的 API Key 只能保存在浏览器 `sessionStorage`，不得进数据库、历史记录、日志或前端 bundle。
- `SUPABASE_SERVICE_ROLE_KEY` 和 `PLATFORM_IMAGE_API_KEY` 只能服务端读取，绝不能以 `VITE_` 开头。
- 不要把真实密钥提交到 Git、Vercel、日志或 README。
- 修改前先看 `git status`，不要回退用户或其他任务的改动。
- 在测试、构建、安全扫描全部通过前，不要提交、不要推送 GitHub、不要部署 Vercel。

## 验收标准

完成后必须全部满足：

- 注册后能收到邮箱验证；验证通过后自动获得 10 积分。
- 平台模式下，未登录用户会看到登录提示，邮箱未验证用户会看到明确提示。
- 平台模式生成按 1 图 1 积分扣费，失败自动退款，重复请求不会重复扣费。
- 自有 Key 模式不扣积分，Key 只在当前浏览器会话内使用。
- 无限画布生成同样遵守平台模式登录、扣费、退款和账户刷新规则。
- 登录用户只能看到自己的历史记录和图片。
- 管理员能打开运营统计面板，普通用户看不到。
- 现有文生图、图生图、局部重绘、预设、历史、导出功能不被破坏。

## 完成前必须执行的检查

```powershell
python -m unittest discover -s tests -v

cd frontend
npm run lint
npm run build
```

以及：

```powershell
git status --short
git grep -n -i -E "sk-[A-Za-z0-9]|api[_-]?key\s*=\s*[^$[:space:]]+|service_role"
```

并人工检查 `.env.example` 只包含空值或占位符。

## 工作方式要求

- 用中文沟通，前端界面文案保持中文。
- 使用 `apply_patch` 做手动代码编辑，不要用 shell 覆盖整个文件。
- 保持现有企业级、商务科技质感的视觉风格，遵循 `ui-ux-pro-max` 与 `frontend-design` 规范。
- 每完成一个阶段就运行相关测试或构建，不要等全部改完才验证。
- 遇到与 `HANDOFF.md` 不一致的实际情况，以当前代码为准，并先说明差异。
- 不要只在计划层面停留；直接实现、验证，再汇报。

## 汇报格式

每次阶段性完成后，用简洁中文汇报：

1. 本轮完成了什么。
2. 修改了哪些关键文件。
3. 跑了哪些测试/构建，结果如何。
4. 还有什么未完成或需要用户确认。

全部完成并通过检查后，再询问是否提交、推送 GitHub 和部署 Vercel。
