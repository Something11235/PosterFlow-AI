import { musicApi } from "./music.js";

export const MAX_MUSIC_REFERENCE_BYTES = 20 * 1024 * 1024;
export const AUDIO_OPERATIONS = { generate: "文字创作", inspo: "参考音频创作", upload_cover: "音频改编", flow_cover: "音频改编" };
export const musicOperations = model => model === "suno" ? ["generate", "inspo", "upload_cover"] : model === "flowmusic" ? ["generate", "flow_cover"] : ["generate"];

// Local selection IDs identify this batch without retaining files or upload receipts in job history.
export function musicReferenceSelection(operation, items) {
  if (operation === "generate" || !items.length) return "";
  return JSON.stringify([operation, ...items.map(item => item.id).sort()]);
}

export function isRejectedMusicSelection(jobs, selection) {
  return Boolean(selection) && jobs.some(job =>
    job.referenceSelection === selection && job.status === "failed" &&
    ["MUSIC_AUDIO_POLICY_REJECTED", "MUSIC_AUDIO_COPYRIGHT", "MUSIC_AUDIO_MATCH"].includes(job.error_code)
  );
}

export function musicFailedBeforeSubmission(error) {
  return !error.submission_unknown && !error.reason_code && (String(error.code || "").startsWith("MUSIC_REFERENCE_") || (error.status >= 400 && error.status < 500));
}

export function musicAudioFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_MUSIC_REFERENCE_BYTES) throw new Error("音频文件须大于 0，且不超过 20 MB。");
  const extension = String(file.name || "").split(".").at(-1).toLowerCase();
  if (!["mp3", "wav"].includes(extension)) throw new Error("参考音频目前支持 MP3、WAV。");
  return { filename: file.name, size: file.size, content_type: extension === "mp3" ? "audio/mpeg" : "audio/wav" };
}

export async function uploadMusicReference(file, options, signal) {
  const metadata = musicAudioFile(file);
  const ticket = await musicApi("/references/uploads", { ...options, body: metadata, signal });
  const url = new URL(ticket.signed_url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.pathname.startsWith("/storage/v1/object/upload/sign/")) throw new Error("音频上传地址无效。");
  const response = await fetch(url.href, { method: "PUT", headers: { "Content-Type": ticket.content_type, "x-upsert": "false" }, body: file, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", signal });
  if (!response.ok) throw new Error("音频上传未完成，请重新添加。");
  const data = await musicApi("/references/complete", { ...options, body: { upload_ticket: ticket.upload_ticket }, signal });
  if (!data.reference?.receipt || !Number.isFinite(data.reference.duration)) throw new Error("音频未通过校验，请重新添加。");
  return data.reference;
}

export function buildAudioOperationParameters(values, operation) {
  if (operation === "flow_cover") {
    if (values.model !== "flowmusic") throw new Error("请选择 Flow Music 音频改编。");
    const prompt = String(values.prompt || "").trim(), title = String(values.title || "").trim();
    if (!prompt || Array.from(prompt).length > 3000) throw new Error("请填写改编描述，最多 3000 字符。");
    if (Array.from(title).length > 200) throw new Error("歌曲标题不能超过 200 字符。");
    const strength = values.strength === "" || values.strength == null ? .5 : Number(values.strength);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error("改编强度须为 0–1 之间的数字。");
    return { model: "flowmusic", version: values.version || "lyria-3-pro", prompt, strength, ...(title ? { title } : {}) };
  }
  if (!["inspo", "upload_cover"].includes(operation) || values.model !== "suno") throw new Error("请选择支持的音频创作方式。");
  const custom = operation === "inspo" || Boolean(values.custom);
  const prompt = String(values.prompt || "").trim();
  if (Array.from(prompt).length > (custom ? 5000 : 3000)) throw new Error("歌词或描述过长，请缩短后重试。");
  if (operation === "upload_cover" && !custom && !prompt) throw new Error("请描述希望改编成的风格或效果。");
  if (operation === "upload_cover" && custom && !values.instrumental && !prompt) throw new Error("请填写改编歌词，或开启纯音乐。");
  const body = { model: "suno", version: values.version || "v6", ...(prompt ? { prompt } : {}) };
  if (operation === "upload_cover") Object.assign(body, { custom, instrumental: Boolean(values.instrumental) });
  if (custom) {
    for (const key of ["title", "style", "negative_tags", "vocal_gender"]) if (String(values[key] || "").trim()) body[key] = String(values[key]).trim();
    for (const key of ["style_weight", "weirdness_constraint", "audio_weight"]) {
      if (values[key] !== "" && values[key] != null) {
        const value = Number(values[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("音乐权重须为 0–1 之间的数字。");
        body[key] = value;
      }
    }
    if (values.auto_lyrics) body.auto_lyrics = true;
    if (operation === "upload_cover" && values.duration !== "" && values.duration != null) {
      const duration = Number(values.duration);
      if (!Number.isInteger(duration) || duration < 10 || duration > 360) throw new Error("目标时长须为 10–360 秒整数。");
      body.duration = duration;
    }
  }
  for (const key of ["variety", "audio_format"]) if (values[key]) body[key] = values[key];
  return body;
}
