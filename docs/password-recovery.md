# 邮件找回密码

用户点击重置邮件后进入本站 `/api/auth/reset-password`，填写两次新密码并提交。页面明确显示修改成功、密码不符合要求、链接过期或网络异常。没有自动登录或返回登录按钮。

## Supabase 控制台配置

先部署网站代码，再修改模板，避免邮件链接指向尚未发布的页面。

1. Authentication → Email Templates → **Reset password**。这里是密码重置模板，不是 Confirm sign up。
2. Subject 填写：`重置你的 PosterFlow AI 密码`。
3. Body 的 Source 全部替换为 [reset-password.html](templates/reset-password.html)，保存。
4. URL Configuration 的 Site URL 使用 `https://www.posterflow-ai.xyz`，末尾不要加 `/`。
5. Redirect URLs 添加 `https://www.posterflow-ai.xyz/api/auth/reset-password`。旧邮件回跳首页也有兼容处理。

模板直接使用本站域名和 `TokenHash`，浏览器不必先打开 Supabase 验证网址。本站服务端仍需能访问 Supabase Auth；这不保证任意国内网络或邮箱内置浏览器一定可访问。出现邮箱安全拦截时按提示使用系统浏览器。

## 验证与安全

- GET/HEAD 不消耗邮件凭证，只有用户提交表单后才验证。
- 邮件凭证在 URL fragment 中，立即清除地址栏片段，不进入 HTTP 查询、referrer、本地存储或日志。
- 浏览器只访问本站。后端以 recovery 类型验证凭证，再使用所得用户会话调用 Auth 的用户密码更新接口；不使用管理员指定用户改密码。
- 验证成功后使用带签名的 Secure、HttpOnly、SameSite=Strict cookie，限制路径到重置接口，并在服务端限制为 10 分钟。密码校验或上游失败可重试，成功后清除 cookie；不返回 access/refresh token 或用户资料。签名 cookie 包含用户 access token，受 HTTPS 和 HttpOnly 保护，并非加密存储；不存储 refresh token。
- 接口要求同源 Origin、JSON 请求，拒绝跨站提交；页面无外部资源，CSP 限制脚本 nonce 与同源连接。
- 支持 8–128 位密码和特殊字符，两次输入必须相同。Supabase 额外的密码策略仍由上游执行。
- 旧默认邮件仍需要先访问 Supabase；网站启动前将 recovery fragment 转送到独立页面，不将恢复会话写入正常登录存储。

部署后以测试邮箱申请新邮件，确认不使用代理时的实际访问情况、成功修改后能用新密码登录、旧密码失效，以及已使用链接无法重复验证。自动测试不发送真实邮件、不修改真实用户密码。

## 回滚

恢复旧前后端版本时，同时恢复 Reset password 模板，否则新邮件将指向旧版本不存在的页面。没有数据库迁移或环境变量新增；已有服务端 Supabase 密钥用于签名，密钥轮换会使尚未完成的重置 cookie 失效。

依据：[Supabase 密码重置](https://supabase.com/docs/guides/auth/passwords)、[邮件模板](https://supabase.com/docs/guides/auth/auth-email-templates)。
