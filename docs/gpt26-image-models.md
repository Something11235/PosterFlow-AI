# GPT Image 2.6 双版本与画布编辑

2026-11-10：Flare／Sunburst 的新平台请求已从 APIMart 切换至 BuyToken，沿用 GPT2.5 的 OpenAI 兼容图片协议。已从本地代码部署正式站，GitHub尚未推送。用户已反馈提示词生成GIF成功；代理未进行收费生成。既有 APIMart 任务仍查询原线路。

| 网站名称 | BuyToken model | 无图片输入／张 | 有图片输入／张 |
| --- | --- | --- | --- |
| GPT Image 2.6 Flare | gpt-image-2.6-flare | 1积分 | 1.5积分 |
| GPT Image 2.6 Sunburst | gpt-image-2.6-sunburst | 1积分 | 1.5积分 |

平台复用 GPT2.5 的服务端 PLATFORM_IMAGE_* 配置，完整生成地址须为 `https://api.buytoken.work/v1/images/generations`；不读取浏览器 Key，不将 APIMart Key 发给 BuyToken。两版本不带 Ext 或 version，quality 固定 auto，无画质选择器。保留网站 1K 档、最多8参考、普通及迭代1–4张、默认1张；画布单个操作仍1张。没有新增2K／4K选项。自带Key按显式地址选择适配器，仍不扣网站积分。

## 编辑与输入

参考图、局部重绘和无限画布按既有 GPT2.5 协议适配；BuyToken 公开文档未明确列出2.6的参考／蒙版能力，真实可用性仍需用户实测，不能把合成测试当作已出图。

无图片输入每张成功结果1积分，任何图片输入每张1.5积分，含普通参考、previous_image迭代、画布原图及说明图；多张参考不重复乘价。按所选数量预留、实际保存张数结算，例如带图4张预留6，只返回2张则收3退3。

先鉴权读取私有原图／蒙版，再校验和预留。蒙版必须PNG带Alpha、与第一张原图同尺寸、含全透明编辑区域，不能混入参考图编号；校验失败不预留或提交，临时素材统一清理。无图使用JSON POST `/v1/images/generations`；有图使用multipart POST `/v1/images/edits`，原图为image或image[]，蒙版独立mask，不再上传至APIMart。

## 动图结果

暂不显示GIF格式选项，也不发送未经文档确认的GIF参数。用户可以在提示词中提出动图要求，已有用户实测成功；不据此保证蒙版编辑或所有配置均能返回动图。若实际返回GIF，按文件内容校验预算后保留原始动画字节、帧时长和循环，保存.gif；若返回静态图，保存.png，不因提示词要求而改扩展名。旧GIF播放、下载及私有读取不受影响。

## 提交与恢复

每个请求编号最多一次收费POST。同步服务没有可查询的上游task_id，禁止伪造远端任务编号或转用APIMart查询。提交前持久化发送标记，成功响应先保存私有结果URL，再下载保存；下载失败可查询原任务重试保存，不重复生成。超时、断线、429、5xx或无法确认的成功响应保留任务与预留；明确参数／鉴权拒绝才退回预留。没有自动切回昂贵APIMart的生成兜底。

旧网页向APIMart发起新的平台GPT2.6请求会在扣分前收到409提示刷新；旧APIMart任务仍可GET恢复。

## 数据库与发布

本轮新增迁移 `20261109153803_buytoken_gpt26_image_provider.sql` 已应用到正式环境，远端记录为 `20261109165114_buytoken_gpt26_image_provider`；版本映射已记录，禁止为对齐编号改名或重放。只新增任务来源／私有结果URL列及4个service_role专用RPC；复用既有1／1.5快照结算和退款函数，保留原函数定义、ACL、任务、余额和流水。本轮按用户部署指令应用此新增迁移并发布匹配代码，正式核对原141个函数定义／ACL保持。没有改动用户余额或重放收费请求。

既有已执行迁移（包括 `20261109023710_gpt26_official_reference_pricing.sql`，正式记录20261109032458）均不修改、不重放。回滚应用可继续使用旧APIMart路线，但BuyToken待保存任务应保留并用匹配代码恢复。

## 供应商依据

- [BuyToken图片接入文档](https://buytoken.work/docs#image)：标准JSON生成、URL结果、生成耗时及断线计费提醒。
- [BuyToken价格](https://buytoken.work/pricing)：两个2.6版本列出1K ¥0.11、2K ¥0.15、4K ¥0.18／张；不据此推断未列出的参考编辑或GIF能力。
- [旧APIMart官方接口](https://docs.apimart.ai/cn/api-reference/images/gpt-image-2.6/generation)：仅保留旧任务及显式自带Key的适配，不代表新BuyToken功能保证。
