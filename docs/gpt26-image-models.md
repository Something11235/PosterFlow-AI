# GPT Image 2.6 Ext 双版本

2026-11-05：本文描述接入实现；发布状态与生产迁移映射见本地交接和发布证据。

| 网站名称 | 网站逻辑 ID | 上游 model | 上游 version | 网站积分／张 |
| --- | --- | --- | --- | --- |
| GPT Image 2.6 Flare | gpt-image-2.6-flare | gpt-image-2.6-ext | flare | 1 |
| GPT Image 2.6 Sunburst | gpt-image-2.6-sunburst | gpt-image-2.6-ext | sunburst | 1 |

按 Flare → Sunburst 排在所有图片模型最前，平台默认 Flare，仅这两项默认显示红色“热”；Seedream 三款保留“新”。当前共十款图片模型。GPT Image 2（旧 ID gpt-image-2，用户称 2.0）退出新建任务与模型一览，平台和自带 Key 新请求均阻止使用；保留旧任务、图片、记录、旧 RPC 与既有结算能力。旧个人配置加载时清空已下线模型的选择，保留其他配置并要求重新选择，不自动换服务商或重发收费请求。

## 官方契约与网站能力

来源：[APIMart GPT Image 2.6 Ext 官方文档](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.6-ext/generation)。原文留存本地 artifacts/gpt26-20261105/gpt26.md。

- 当前仅 1K、n=1。界面与服务器同步限制，2K／4K、批量、不合法尺寸在预留前拒绝。上游 resolution 为 1k，账务快照为 1K。
- 两个逻辑 ID 映射到同一上游 model 和不同 version；请求指纹包含版本，不允许浏览器覆盖所选版本。只提交一次收费 POST，随后查询原任务，不回退其他收费模型。
- 官方最多 16 张参考图、每张 20MB；本站沿用更严格的 8 张与共享上传上限，额外校验每张不超过 20MB。参考图编辑仍每张成功结果 1 网站积分，自带 Key 不扣网站积分。
- 尺寸只使用 auto 或支持的比例，禁用精确像素入口，切换模型时清除旧自定义尺寸。质量接受文档枚举，网站现有默认 auto。
- 官方明确不支持 markup／markup_url 标注局部编辑，未声明蒙版契约。按用户要求禁用两款的局部重绘及无限画布 AI，普通参考图创作保留；后端也拒绝 mask、markup 和 canvas_workflow。
- PNG 为默认格式，GIF 动图位于第二项；GIF 仅文字生成、自动尺寸、单个输出。动画保存与下载详 [GIF 实现](gpt26-gif.md)。SVG 等独立输出流程尚未接入。

## 管理员角标

改为“模型下拉框＋角标选择”，下方显示预览和保存按钮。切换模型保留全部未保存草稿，保存完整配置。保留管理员校验、版本冲突保护及失败保留草稿。新增迁移一次性清除旧热门标记、移除旧模型角标，并添加两个 2.6 热门标记；保留其他新／空标记，之后仍可由管理员修改。

## 数据库与发布

新增未应用迁移 supabase/migrations/20261105141914_gpt26_ext_image_model.sql，通过隔离目录 Supabase CLI 3 migration new 生成。新增 GPT26 专用预留、结算、退款、begin_gpt26_image_job，以及 apply_image_job_v3 分派；旧任务委托既有 apply_image_job_v2，旧函数定义和 ACL 保留。新私有 definer 固定空 search_path，公共包装 invoker，仅 service_role 可执行。价格按任务快照，每张成功保存结算 1 分；明确失败退款，未知状态保留预留，重复回调幂等。

以后获得明确推送部署授权后，先核对正式迁移清单，再依次仅应用尚未执行的三份新增迁移：20261105040811_seedream_image_models.sql、20261105043134_model_badge_settings.sql、20261105141914_gpt26_ext_image_model.sql，之后发布依赖新 RPC 的代码。不得 db push 重放历史或修改已执行文件。

本轮验证为模拟请求、合成素材和隔离 PGlite；没有真实收费出图、上游账号权限或正式持久化验收。证据、截图、交接只留本地 artifacts，不提交。
