# Nano 官方路由与 Seedream 5.0 接入

2026-11-11 版本更新：新增Seedream 5.5及分辨率价格档位；当前规则统一见[图片分辨率与积分](image-resolution-pricing.md)。两份新增迁移已应用。下方旧价格、分辨率入口和Git状态属于历史记录，以新说明及本地交接为准。

2026-11-10 参考图修复：Nano官方及三个Seedream改用Base64 Data URI，不再单独上传APIMart；格式校验、价格和参考顺序保持。真实收费生成仍待用户验收，详见[参考图传输修复](apimart-image-generation.md)。下方旧Git及部署状态仅为历史记录。

2026-11-09 更新：按用户要求，Nano 已切回官方 `gemini-nano-banana-2.1`，不再调用 Ext 或发送 `official_fallback`。本次已从本地工作树直接部署至正式站，用户确认真实生成成功；尚未提交或推送，GitHub 仍为 6617df0，正式代码包含其后的本地路由修改。下方迁移与最初验收记录属于 2026-11-05 历史阶段，相关迁移早已执行，禁止重放；当前状态以本地 HANDOFF.md 为准。

## 官方契约与网站支持

| 网站显示 | 上游 model | 网站积分／张 | 清晰度 | 网站单次出图 | 网站参考图 | 画布编辑 |
| --- | --- | --- | --- | --- | --- | --- |
| Nano Banana 2.1 | gemini-nano-banana-2.1 | 1K/2K 1；4K 2 | 1K/2K/4K | 1 | 8 | 参考图指令编辑，不发送蒙版 |
| （即梦）Seedream 5.0 Pro | seedream-5-0-pro | 2 | 1K/1.5K/2K | 1 | 8 | 坐标／手绘标记编辑 |
| （即梦）Seedream 5.0 Lite | seedream-5-0-lite | 1 | 2K/3K/4K | 1–4 | 8 | 未确认局部编辑契约，禁用局部重绘与无限画布 AI 入口 |
| （即梦）Seedream 5.0 Flash | seedream-5-0-flash | 0.5 | 1K/1.5K/2K | 1 | 8 | 坐标／手绘标记编辑 |

顺序保留既有六款，再加入 Pro → Lite → Flash。Lite 仍可通过普通创作入口使用参考图；切换模型保留已有素材与画布数据，不静默删除。画布内切到 Lite 后可选择其他模型恢复操作。未支持的参数在服务器积分预留前拒绝。

Seedream Pro/Flash 官方参考图上限10，本站沿用已有安全上传链路上限8；Lite 官方参考图加输出张数不超过15，本站8参考图+最多4输出同样满足。Lite 官方单图限10MB、PNG/JPEG、比例1:3–3:1；上传通道可能优化成WebP，服务端先转换为PNG并重新校验真实字节、尺寸和大小。Pro/Flash 校验单边大于14、总像素不超过3600万、比例1:16–16:1，并沿用本站16MiB更严格的上传上限。

Lite 不提供精确像素输入入口，只接受受支持比例／档位；文生图未指定尺寸时用1:1，参考图用auto。Pro/Flash 的精确像素支持921600–4624220总像素、比例1:16–16:1；精确像素时不发送无效的resolution。标注矩形／圆形边界框转换为主图0–1000的bbox坐标，画笔、箭头、文字通过标注说明图定位；不发送GPT专用Alpha蒙版。

Pro/Flash 官方还提供图层拆分和受限透明图编辑。本轮未开放这两种独立操作，服务端显式拒绝相关参数，避免把最多17张图层输出当作一张普通成品结算。Lite 的说明没有明确局部／手绘编辑协议，因此按用户要求保守禁用；不凭同系列模型名称推断能力。

## Nano 官方路由与价格

网站逻辑模型 ID 与上游模型均为 gemini-nano-banana-2.1，用于历史、统计和既有网站价格快照。上游请求发送官方 model、n=1，不带 official_fallback，也不接受浏览器覆盖上游模型或添加回退参数。平台积分与自带 Key 模式共用这一官方路由；本站不因超时、未知状态或失败自动再提交一次收费请求。

切回官方版后，网站仍保持单次1张、最多8张参考图、参考图合计50MB的现有限制；本次只切换路由，不扩大批量或上传上限。官方版按实际 token 向上游计费；网站仍按原快照收取1K/2K每张1积分、4K每张2积分。用户自带Key不扣网站积分，其上游费用由用户自身账户承担。部署后用户已确认此次真实出图成功；代理仅执行本地模拟与线上只读检查，没有发起收费测试或重放用户请求。

## 新计费迁移与发布顺序

新增 supabase/migrations/20261105040811_seedream_image_models.sql（通过隔离目录的 Supabase CLI migration new 创建），不修改任何已执行迁移。新增 Seedream 专用 begin、reserve、settle、refund 及 apply_image_job_v2 RPC；公共包装invoker、私有实现definer，固定空search_path，仅service_role可执行。

generation_jobs 的reserved_credits／charged_credits扩为numeric(18,4)，apimart_image_jobs的unit_credit_cost扩为numeric，保留旧整数的文本兼容；模型和分辨率约束只扩展。旧函数定义和ACL不变，旧任务按原价格快照结算。新apply包装按任务模型分派，旧模型仍调用原apply实现；Flash全程按精确0.5计费，不经integer舍入。收费新任务鉴权→校验→幂等预留→一次提交→查询→保存→结算，明确失败退款，未知状态保持。

未来获明确发布授权后，先核对正式迁移版本与当前函数／权限，再单独应用新增迁移，随后发布依赖这些RPC的代码；不得db push重放历史。数据库回滚不删除任务或余额，网站回退可继续使用旧RPC。当前没有访问或修改任何云端数据库，也没有收费测试。

## 官方来源

- [Nano 2.1 / Ext / official_fallback](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)
- [Seedream 5.0 Pro](https://docs.apimart.ai/cn/api-reference/images/seedream-5-0-pro/generation)
- [Seedream 5.0 Lite](https://docs.apimart.ai/cn/api-reference/images/seedream-5-lite/generation)
- [Seedream 5.0 Flash](https://docs.apimart.ai/cn/api-reference/images/seedream-5-0-flash/generation)

Flash 文档的别名处疑似复制了Pro名称，代码只使用该页面明确给出的主ID seedream-5-0-flash。Lite 概述还残留“2K/3K”字样，正文参数及完整像素表明确支持4K，代码按正文契约处理。查询同时兼容data包裹的completed与文档展示的根级success，不能将响应结构差异误判为生成失败。

验证使用合成图片、模拟上游与独立PGlite数据库；相关脚本和官方文档快照在本地artifacts/seedream-20261105。模拟通过不代表真实上游权限、余额或出图效果已验收。
