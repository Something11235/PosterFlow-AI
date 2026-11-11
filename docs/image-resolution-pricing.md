# 图片分辨率与积分规则

2026-11-11 版本的图片价格和分辨率统一说明，覆盖旧文档中的历史价格。两份新增迁移已应用；正式部署与真实出图验收状态以本地交接记录为准。

仅在供应商价格升档时，每张结果加0.5网站积分；同价分辨率保持同价。默认选择最低支持档位。上游Credits与网站积分是不同单位，不直接互换。

| 模型 | 分辨率 | 无图输入积分／张 | 带图输入积分／张 |
| --- | --- | --- | --- |
| GPT Image 2.5 Flare／Sunburst | 1K／2K／4K | 1／1.5／2 | 1／1.5／2 |
| GPT Image 2.6 Flare／Sunburst | 1K／2K／4K | 1／1.5／2 | 1.5／2／2.5 |
| Nano Banana 2.1 官方 | 1K／2K／4K | 1／1.5／2 | 1／1.5／2 |
| Grok Imagine Image 2.0 | 1K／2K | 1／1.5 | 2／2.5 |
| Grok Imagine 2.0 Ext | 自动 | 1 | 普通参考图不支持；单图选区编辑仍1 |
| （即梦）Seedream 5.5 | 1K／1.5K／2K | 1／1／1.5 | 1／1／1.5 |
| （即梦）Seedream 5.0 Pro | 1K／1.5K／2K | 2／2／2.5 | 2／2／2.5 |
| （即梦）Seedream 5.0 Lite | 2K／3K／4K | 1／1／1 | 1／1／1 |
| （即梦）Seedream 5.0 Flash | 1K／1.5K／2K | 0.5／0.5／0.5 | 0.5／0.5／0.5 |

“带图”包括普通参考、上一张结果迭代、局部重绘原图、画布原图／标注说明图；多张参考不重复乘价。先按所选张数预留，按实际保存张数结算；明确失败退款，未知不重发。自带Key不扣网站积分。

界面规则：创作区只显示当前档位和当前输入类型价格；服务设置不显示模型价格、下拉只显示名称及角标；完整价目表只放模型一览。

## Seedream 5.5 的功能对应

在5.0 Pro正上方，单次1张、参考最多8张、默认1K；支持文生图、参考图、标注局部编辑与无限画布。用参考图、bbox坐标与标注说明定位编辑，不发送GPT独立Alpha蒙版。普通入口不开放GIF、透明输出或图层拆分。Data URI沿用现有16MB单图上传限制。

5.5的auto尺寸会按2K处理；未指定比例时发送所选档位作为size，避免默认1K被上游自动升为2K。显式比例使用size比例＋resolution；自定义像素按实际总像素计档，不能由客户端价格字段决定。

## 请求与账务

GPT2.5保持既有同步路由与GET恢复，GPT2.6仍走BuyToken，二者quality固定auto、无画质菜单；新增1K／2K／4K分辨率，使用具体像素size传给BuyToken（最长边1024／2048／4096并按8对齐），不发送供应商文档未声明的resolution字段。高分辨率真实可用性仍待用户亲测。APIMart Grok传小写1k／2k，账务规范为大写。

新增20261111020236_seedream55_image_model.sql和20261111021536_image_resolution_tier_pricing.sql；正式记录分别为20261111030654、20261111030705，已应用，禁止改名／重复执行。旧函数与ACL保持；新预留在同一事务中调整差价，余额不足无孤立预留，结算用任务快照。旧客户端面对已涨价的档位在提交前409提示刷新；旧任务继续原价结算，不补扣历史差额。新RPC仅service_role可执行，public包装invoker／private实现definer固定search_path。

## 价格依据与边界

- [Seedream 5.5 模型价格](https://apimart.ai/zh/model/seedream-5-5)：用户提供的官网价表截图明确1K／1.5K同价0.13上游Credits，2K为0.2275，每参考图0.052；覆盖静态抓取未显示价格时的临时结论。
- [Seedream 5.5 生成文档](https://docs.apimart.ai/cn/api-reference/images/seedream-5-5/generation)：单图、比例／像素尺寸、参考图与交互编辑。
- [Seedream 5.0 Pro](https://apimart.ai/zh/model/seedream-5-0-pro)：1K／1.5K同价，2K升档。
- [Seedream 5.0 Flash](https://apimart.ai/zh/model/seedream-5-0-flash)：模型价格页三个档同价；API文档价表疑似复制Pro，按模型页保留0.5。
- [Seedream Lite](https://apimart.ai/zh/model/seedream-5-lite)：2K／3K／4K同价。
- [Grok 2.0](https://apimart.ai/zh/model/grok-imagine-2-0)：1K／2K价格不同；[接口文档](https://docs.apimart.ai/cn/api-reference/images/grok-imagine-image-2.0/generation)定义resolution。
- [Nano 官方文档](https://docs.apimart.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)：分辨率影响token消耗。Image2.5／2.6是否影响价格由用户明确确认，无需重复查价；像素协议参见[BuyToken图片文档](https://buytoken.work/docs#image)。

自动化生成链路仅用模拟上游验证，不代表真实供应商出图通过；没有代理收费调用或真实用户请求重放。正式迁移只增加兼容结构与RPC，不回填账户或历史账务。
