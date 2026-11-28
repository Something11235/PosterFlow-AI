# 第三方依赖与素材说明

核查日期：2026-11-15。本文件说明当前源码仓库的第三方许可边界，不是对全部代码、素材或任意打包产物的完整法律合规保证。项目的 [PolyForm Noncommercial 许可](LICENSE) 仅适用于 [NOTICE.md](NOTICE.md) 界定的自有代码及文档，不替代下述第三方许可，也不限制第三方原许可已经授予的商业使用等权利。

## 软件依赖

前端以 [package-lock.json](frontend/package-lock.json) 的锁定版本为准；后端以 [requirements.txt](backend/requirements.txt) 和实际安装版本为准。下表为本次核对的直接依赖，不是全部传递依赖或操作系统组件清单。安装包中的 LICENSE、COPYING、NOTICE 及附带组件声明应保留；分发构建产物时须按实际纳入的组件履行相应义务。

| 前端依赖 | 核对版本 | 原许可 |
| --- | --- | --- |
| `@supabase/supabase-js` | 2.116.0 | MIT |
| `@tailwindcss/vite`、`tailwindcss` | 4.3.3 | MIT |
| `@vercel/analytics` | 2.0.1 | MIT |
| `fabric` | 7.4.0 | MIT |
| `fflate` | 0.8.3 | MIT |
| `libheif-js` | 1.23.5 | LGPL-3.0。HEIC/HEIF 的浏览器备用解码器按需独立加载，含 libheif 1.23.5 与 libde265 1.0.15。[许可证、源码和构建说明](frontend/public/licenses/heif-decoder.txt) |
| `lucide-react` | 1.29.0 | ISC；Feather 派生部分另含 MIT 声明 |
| `qrcode.react` | 4.2.0 | ISC；内嵌 Project Nayuki `qrcodegen` 为 MIT |
| `react`、`react-dom` | 19.2.8 | MIT |
| `@types/react` / `@types/react-dom` | 19.2.18 / 19.2.4 | MIT |
| `@vitejs/plugin-react` | 6.0.5 | MIT |
| `oxlint` | 1.77.0 | MIT |
| `vite` | 8.2.1 | MIT；另附其打包组件声明 |

| 后端依赖 | 核对的本地版本 | 原许可 |
| --- | --- | --- |
| Flask | 3.1.3 | BSD-3-Clause |
| flask-cors | 6.0.5 | MIT |
| requests | 2.34.2 | Apache-2.0，另附 NOTICE |
| Pillow | 13.0.0 | MIT-CMU，另附原生组件许可 |
| pillow-heif | 1.8.1 | Python 源码 BSD-3-Clause；预编译 wheel 另见下节 |
| pypdf | 6.21.3 | BSD-3-Clause |
| tinytag | 2.3.2 | MIT |
| PyJWT | 2.15.1 | MIT |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| gunicorn | 23.0.0 | MIT |

前端锁文件中 193 个依赖条目均包含许可字段，其中 24 个 MPL-2.0 条目属于 Lightning CSS 及不同版本、平台包。后端本地核查的 23 个适用发行包中，`certifi` 2026.10.19 亦为 MPL-2.0。这些组件及其修改文件继续遵循原许可；本项目声明不改变 MPL 文件的源码提供等义务，参见 [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)。不同安装平台和后续依赖升级可能改变实际组件集合。

分发时尤其应保留 `lucide-react/LICENSE` 中的 Feather / Cole Bemis 声明、`qrcode.react` 使用的 [Project Nayuki qrcodegen MIT 许可](https://github.com/zpao/qrcode.react/blob/v4.2.0/src/third-party/qrcodegen/LICENSE)、Requests 的 NOTICE，以及 Pillow 的完整 LICENSE 和附带原生组件说明。上表不能代替这些原文。

## HEIF 原生库与二进制分发

`pillow-heif` 的 Python 源码采用 BSD-3-Clause，但其 [1.8.1 版本官方 LICENSES_bundled.txt](https://github.com/bigcat88/pillow_heif/blob/v1.8.1/LICENSES_bundled.txt) 将预编译 wheel 标注为 GPLv2，并列出以下组件：

- `libheif` 1.23.6：LGPLv3。
- `libde265` 1.1.3：LGPLv3。
- `x265` 4.3：GPLv2。
- Windows wheel 还包含各自许可下的 MinGW-w64 运行时组件。

当前 Git 源码仓库未包含这些 wheel 或原生库文件，但 [Dockerfile](Dockerfile) 会在构建时安装 Python 依赖。因此，发布预装依赖的 Docker 镜像、安装包或其他二进制产物时，必须另外核查并满足相应的版权声明、对应源码提供、组合及链接等许可义务。**不能把含有这些组件的整体发行物简单标为本项目的非商业许可，也不能仅靠本文件中的排除声明认定其整体许可兼容。** 本次核查与许可证添加未发布预构建容器或安装包。

## 格式兼容与历史版本

一键 PPT 的设计流程和[动效规划指引](backend/ppt_assets/web-motion.md)改编自 Hugo He 的 [PPT Master 6.10.0](https://github.com/hugohe3/ppt-master)，仓库内附[上游工作流](backend/ppt_assets/quick-generate.md)和 [MIT 许可证](backend/ppt_assets/LICENSE-ppt-master)。浏览器的 PPTX 导出使用 PptxGenJS（MIT），PDF 文本提取使用 PDF.js（Apache-2.0）。

角色卡、世界书、PNG 元数据及导入接口的兼容说明涉及 SillyTavern、Character Card 等外部项目或规范。兼容格式本身不代表取得任何外部项目代码或角色内容的再许可；如实际复用第三方实现，仍须保留并遵守其原许可。SillyTavern 自身采用 [AGPL-3.0](https://github.com/SillyTavern/SillyTavern/blob/release/LICENSE)。本次定向核查未发现明确逐段复制其实现的证据，但没有对全部代码进行来源追溯或完整相似度审计。

当前画布使用 Fabric.js；历史版本曾使用 tldraw SDK，其第三方许可不因当前项目新增 LICENSE 而被追溯改变。使用或分发历史提交时，应核对该版本实际依赖。

## 图片、角色、图标及示例媒体

以下内容不由本项目代码许可统一授予第三方权利：

- `frontend/public/ai-companions/`：初始图片来自维护者笔记引用的图片，导入过程见 [素材说明](docs/creative-materials.md)。当前记录未完整列出逐图作者、原始来源及授权；不能据此保证所有图片均可再分发或商用。
- `frontend/public/style-prompts/` 及相关示例提示词：现有目录与素材清单未完整记录逐项来源和许可。
- `frontend/public/icons.svg` 中的第三方品牌图形、项目 Logo、favicon、示例海报、二维码及文档截图：品牌、形象、原图等权利须分别确认；项目名称或图标的出现不表示相关方背书。
- 测试媒体：`tests/fixtures/reference-tone.mp3` 的提交记录注明为合成音频；两个 MP4 测试文件没有同等完整的来源许可记录。
- 用户导入的角色卡、世界书、图片及其他内容：权利由各自作者或其他权利人保留，上传或导入不代表授予本项目对外再许可权。

本次排除范围不构成对缺失素材授权的补授或确认。复用、再发布这些内容前，应取得对应许可，或替换为权属清楚的素材。发现权属或署名问题时，请通过 [维护者主页](https://github.com/Something11235) 提供的联系方式提交具体文件与来源信息。

## AI 创作画布分镜与提示词

画布服务端从 `backend/canvas_skills/upstream/` 加载 ZenStory 三个技能的原文节选。版本固定为 `7fed9dfcd33c5a3134ff1b51709dd826488b5aab`，原作者为 drama-skills contributors，依 MIT 授权。[许可证](backend/canvas_skills/LICENSE)

| 本站入口 | 上游原文与选段 |
| --- | --- |
| 剧本拆镜 | 工作流第 1、2 步（戏剧落点、运镜与声音），节拍拆镜对照表，镜头目的、接招反应两条规则。[技能正文](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-storyboard/SKILL.md#L28-L33) · [节拍拆镜](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-storyboard/references/shot-craft.md#L3-L12) · [镜头目的](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-storyboard/references/shot-craft.md#L20-L23) |
| 图片提示词 | “核心特征优先落笔”与设定图通用编写顺序六项，包含构图、材质和字迹约束。[技能正文](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-image-prompts/SKILL.md#L22-L27) · [视觉定调指南](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-image-prompts/references/sheet-prompt-guide.md#L3-L12) |
| 视频提示词 | 工作流第 3 步前半段（动作、运镜与声音），单镜动作容量、接触发力、动作先后与多人同框反应。[技能正文](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-video-prompts/SKILL.md#L34-L38) · [表演弧线与动作计时](https://github.com/zenstory-ai/drama-skills/blob/7fed9dfcd33c5a3134ff1b51709dd826488b5aab/skills/short-drama-video-prompts/references/performance-action-timing.md#L3-L16) |

每次文本请求只加载对应路径的选段，同时加载本站同名适配文件，指定助写、润色或补全动作以及 JSON 输出结构。上游的完整项目文件工作流、媒体生产和工具调用未纳入。渲染图片和视频由用户在画布另行确认。
