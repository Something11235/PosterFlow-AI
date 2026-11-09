import { buildVideoParameters } from "./video.js";
import { buildMusicParameters, defaultSuno } from "./music.js";
import { buildAudioOperationParameters, musicOperations } from "./musicReferences.js";
import { imagePricingLabel } from "./provider.js";
// Connected models are selectable; remaining entries preserve the integration roadmap.
export const STUDIO_AREAS = [
  { id: "image", label: "图像创作", short: "图像", en: "IMAGE", description: "把灵感变成可见的画面", status: "已有功能", model: "GPT Image · Nano Banana · Grok", prompt: "一颗悬浮在深蓝色空间中的透明玻璃球，冰蓝色折射，极简产品摄影，柔和侧光。" },
  { id: "music", label: "音乐创作", short: "音乐", en: "MUSIC", description: "为想象写一段专属旋律", status: "创作与试听", model: "suno · flowmusic", prompt: "适合深夜工作时聆听的纯音乐，温暖的电钢琴、轻柔鼓点、模拟合成器，lo-fi 氛围。" },
  { id: "video", label: "视频创作", short: "视频", en: "VIDEO", description: "让文字与素材成为会动的故事", status: "创作与预览", model: "Seedance 2.5", prompt: "" },
];

export const IMAGE_MODELS = [
  { id: "gpt-image-2.6-flare", name: "GPT Image 2.6 Flare", maker: "GPT Image", summary: "1K 批量创作、多图参考与画布选区编辑", capability: "文生图 · 参考图编辑 · 蒙版重绘 · 无限画布", available: true, provider: "apimart" },
  { id: "gpt-image-2.6-sunburst", name: "GPT Image 2.6 Sunburst", maker: "GPT Image", summary: "1K 批量创作、多图参考与画布选区编辑", capability: "文生图 · 参考图编辑 · 蒙版重绘 · 无限画布", available: true, provider: "apimart" },
  { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", maker: "GPT Image", summary: "海报设计与创意画面 · 支持多图参考", capability: "文生图 · 参考图编辑", available: true },
  { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", maker: "GPT Image", summary: "场景构图与图片改写 · 支持多图参考", capability: "文生图 · 参考图编辑", available: true },
  { id: "nano-banana-2.1", name: "Nano Banana 2.1", maker: "Nano Banana", summary: "多图参考与细节编辑 · 支持最高 4K", capability: "文生图 · 参考图编辑", available: true, provider: "apimart" },
  { id: "grok-imagine-image-2.0", name: "Grok Imagine Image 2.0", maker: "Grok", summary: "最多 3 张参考图 · 支持 1K / 2K", capability: "文生图 · 参考图编辑", available: true, provider: "apimart" },
  { id: "grok-imagine-2.0-ext", name: "Grok Imagine 2.0 Ext", maker: "Grok", summary: "文字创作与画布单图选区修改", capability: "文生图 · 画布选区编辑", available: true, provider: "apimart" },
  { id: "seedream-5-0-pro", name: "（即梦）Seedream 5.0 Pro", maker: "即梦", summary: "单图创作 · 多图参考与标注编辑", capability: "文生图 · 参考图 · 标注编辑", available: true, provider: "apimart" },
  { id: "seedream-5-0-lite", name: "（即梦）Seedream 5.0 Lite", maker: "即梦", summary: "2K / 3K / 4K · 参考图创作与组图", capability: "文生图 · 参考图 · 组图", available: true, provider: "apimart" },
  { id: "seedream-5-0-flash", name: "（即梦）Seedream 5.0 Flash", maker: "即梦", summary: "单图创作 · 多图参考与标注编辑", capability: "文生图 · 参考图 · 标注编辑", available: true, provider: "apimart" },
];
export const MUSIC_MODELS = [
  { id: "suno", name: "suno", maker: "Suno", summary: "灵感成曲 · 参考音频创作 · 音频改编", draftReady: true },
  { id: "flowmusic", name: "flowmusic", maker: "Flowmusic", summary: "标准版 · Lyria 3.5 · 文字成曲与音频改编", draftReady: true },
];
export const VIDEO_MODELS = [
  { id: "seedance-2.5", name: "Seedance 2.5", maker: "Seedance", available: true, summary: "30 秒 · 多模态参考 · 视频编辑与延长" },
  { id: "seedance-2.0", name: "Seedance 2.0", maker: "Seedance", available: true, summary: "4–15 秒 · 最高 4K · 多模态参考与首尾帧" },
  { id: "seedance-2.0-fast", name: "Seedance 2.0 Fast", maker: "Seedance", available: true, summary: "快速生成 · 4–15 秒 · 多模态参考与首尾帧" },
  { id: "seedance-2.0-mini", name: "Seedance 2.0 Mini", maker: "Seedance", available: true, summary: "4–15 秒 · 多模态参考 · 首尾帧与声音" },
  { id: "gemini-omni-1.1-flash", name: "Gemini Omni 1.1 Flash", maker: "Gemini", available: true, summary: "自动时长 · 最高 4K · 首尾帧、视频编辑与续写" },
  { id: "MiniMax-H3", name: "MiniMax H3", maker: "MiniMax", available: true, summary: "4–15 秒 · 原生 2K · 首尾帧与多模态参考" },
  { id: "MiniMax-H3-Max", name: "MiniMax H3 Max", maker: "MiniMax", available: true, summary: "快速生成 · 5–15 秒 · 最高 1080P · 多模态参考" },
  { id: "wan3.0-video", name: "Wan 3.0", maker: "Wan", available: true, summary: "2–30 秒 · 首尾帧与多模态参考 · 文档与网页成片" },
  { id: "flux-3-video", name: "FLUX 3 Video", maker: "FLUX", available: true, summary: "5–20 秒 · 有序关键帧 · 视频续写与草稿转正式片" },
];
export const MODEL_CATALOG = [
  ...IMAGE_MODELS.map(model => {
    const providerModel = model.id === "nano-banana-2.1" ? "gemini-nano-banana-2.1" : model.id;
    const pricing = imagePricingLabel(providerModel);
    return { ...model, area: "image", pricing };
  }),
  ...MUSIC_MODELS.map(model => ({ ...model, area: "music" })),
  ...VIDEO_MODELS.map(model => ({ ...model, area: "video", summary: model.summary || "视频模型预览 · 暂未开放生成" })),
];
export const textLength = value => Array.from(String(value || "")).length;
export const defaultMusic = defaultSuno;

// Drafts share request whitelists and never retain source files or credentials.
export function buildStudioDraft(kind, values) {
  if (kind === "video") { const body = buildVideoParameters(values); return { kind, title: Array.from(body.prompt).slice(0,72).join("") || "参考素材视频", endpoint: "/api/video/generations", encoding: "application/json", body, note: "只保留文字与设置，需重新添加参考素材。" }; }
  if (kind !== "music") throw new Error("不支持的草稿类型。");
  const audio = values.operation !== "generate" && musicOperations(values.model).includes(values.operation);
  const body = audio ? { ...buildAudioOperationParameters(values, values.operation), operation: values.operation } : buildMusicParameters(values, { allowCustom: true });
  const title = body.title || body.prompt || body.sound_prompt || body.lyrics || "未命名纯音乐";
  return { kind, title: Array.from(title).slice(0, 72).join(""), endpoint: audio ? `/api/music/operations/${values.operation}` : "/v1/music/generations", encoding: "application/json", body, ...(audio ? { note: "仅保存创作设置；重新添加音频素材后才能提交。" } : {}) };
}
