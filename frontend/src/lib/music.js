export const SUNO_VERSIONS = ["v6", "v6-wild", "v6-mini"];
export const FLOW_VERSIONS = [{ value: "lyria-3-pro", label: "标准版" }, { value: "lyria-3.5", label: "Lyria 3.5" }];
export const MUSIC_REQUEST_PRICE = 2;
export function musicJobCost(job) {
  if (job?.billing_mode === "own_key") return 0;
  if (job?.billing_unit === "request") return job.credits_per_request ?? MUSIC_REQUEST_PRICE;
  // Old completed jobs retain their actual charge; legacy unsettled jobs may
  // still be served by an older candidate while deployments are being tested.
  return job?.charged_credits || (job?.generated_count || 0) * (job?.credits_per_song || 2);
}
export const musicLength = value => Array.from(String(value || "").trim()).length;
export const defaultSuno = () => ({ model: "suno", version: "v6", custom: false, instrumental: true, prompt: "", title: "", style: "", vocal_gender: "", audio_format: "", duration: "", negative_tags: "", variety: "", style_weight: "", weirdness_constraint: "", audio_weight: "", auto_lyrics: false });
export const defaultFlow = () => ({ model: "flowmusic", version: "lyria-3-pro", operation: "generate", prompt: "", strength: "0.5", sound_prompt: "", lyrics: "", title: "", bpm: "", length: "", seed: "" });

function checkText(value, label, limit) {
  const result = String(value || "").trim();
  if (musicLength(result) > limit) throw new Error(`${label}不能超过 ${limit} 个字符。`);
  return result;
}
function numberOption(value, label, low, high, integer = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < low || number > high || (integer && !Number.isInteger(number))) throw new Error(`${label}须在 ${low}–${high} 之间${integer ? "，且为整数" : ""}。`);
  return number;
}

export function buildMusicParameters(values, { allowCustom = false } = {}) {
  const model = values.model || "suno";
  if (model === "custom") {
    if (!allowCustom) throw new Error("平台积分模式请选择已配置的音乐模型。");
    const customModel = String(values.custom_model || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(customModel)) throw new Error("请填写有效的自定义模型标识。");
    const format = values.parameter_format || "suno";
    if (!["suno", "flowmusic"].includes(format)) throw new Error("请选择参数格式。");
    const body = buildMusicParameters({ ...values, model: format, version: format === "suno" ? "v6" : "lyria-3-pro" });
    body.model = customModel;
    body.parameter_format = format;
    delete body.version;
    const version = checkText(values.custom_version, "模型版本", 128);
    if (version) body.version = version;
    return body;
  }
  if (model === "flowmusic") {
    const version = values.version || "lyria-3-pro";
    if (!FLOW_VERSIONS.some(item => item.value === version)) throw new Error("请选择可用的音乐版本。");
    // Local version identifies the standard Flow route; server omits its API
    // version field according to the documented base endpoint.
    const body = { model, version };
    for (const [key, label, limit] of [["sound_prompt", "音乐描述", 6000], ["lyrics", "歌词", 6000], ["title", "歌曲标题", 200], ["seed", "随机种子", 128]]) {
      const value = checkText(values[key], label, limit);
      if (value) body[key] = value;
    }
    if (!body.sound_prompt && !body.lyrics) throw new Error("请填写音乐描述或歌词。");
    if (values.length !== "" && values.length != null) body.length = numberOption(values.length, "时长", 1, 240, true);
    if (values.bpm !== "" && values.bpm != null) {
      const bpm = String(values.bpm).trim();
      if (!/^[0-9]{1,4}(?:\.[0-9]{1,2})?$/.test(bpm) || Number(bpm) < 1) throw new Error("BPM 须为不小于 1 的数字。");
      body.bpm = bpm;
    }
    return body;
  }
  if (model !== "suno") throw new Error("不支持的音乐模型。");
  const version = values.version || "v6";
  if (!SUNO_VERSIONS.includes(version)) throw new Error("请选择可用的音乐版本。");
  const custom = Boolean(values.custom), instrumental = Boolean(values.instrumental);
  const prompt = checkText(values.prompt, custom ? "歌词" : "音乐描述", custom ? 5000 : 3000);
  if (!prompt && (!custom || !instrumental)) throw new Error(custom ? "请填写歌词，或开启纯音乐。" : "请先描述音乐的风格、情绪或主题。");
  const body = { model, version, custom, instrumental, ...(prompt ? { prompt } : {}) };
  if (custom) {
    for (const [key, label, limit] of [["title", "歌曲标题", 80], ["style", "音乐风格", 1000], ["negative_tags", "排除风格", 1000]]) {
      const value = checkText(values[key], label, limit);
      if (value) body[key] = value;
    }
    if (values.auto_lyrics) body.auto_lyrics = true;
    if (values.duration !== "" && values.duration != null) body.duration = numberOption(values.duration, "时长", 10, 360, true);
  }
  for (const key of ["style_weight", "weirdness_constraint", "audio_weight"]) {
    if (values[key] !== "" && values[key] != null) body[key] = numberOption(values[key], "音乐权重", 0, 1);
  }
  for (const [key, choices] of [["vocal_gender", ["Male", "Female"]], ["variety", ["off", "normal", "high", "extra", "max"]], ["audio_format", ["mp3", "m4a", "wav"]]]) {
    if (values[key]) {
      if (!choices.includes(values[key])) throw new Error("音乐参数选项无效。");
      body[key] = values[key];
    }
  }
  return body;
}

export function musicStorageKey(identity, name) { return `posterflow.music.v1.${identity}.${name}`; }
export function readMusicSession(identity, name) {
  try { return sessionStorage.getItem(musicStorageKey(identity, name)) || ""; } catch { return ""; }
}
export function saveMusicSession(identity, name, value) {
  try {
    if (value) sessionStorage.setItem(musicStorageKey(identity, name), value);
    else sessionStorage.removeItem(musicStorageKey(identity, name));
    return true;
  } catch { return false; }
}

export async function musicApi(path, { mode = "platform", key = "", endpoint = "", queryTemplate = "", authType = "bearer", authHeaders = {}, body, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 55000);
  try {
    const response = await fetch(`/api/music${path}`, {
      method: body ? "POST" : "GET", credentials: "include", signal: controller.signal,
      headers: { ...authHeaders, "X-Billing-Mode": mode, ...(mode === "own_key" && key ? { "X-Music-Api-Key": key, "X-Music-Endpoint": endpoint, "X-Music-Query-Template": queryTemplate, "X-Music-Auth-Type": authType } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error("音乐服务响应异常，请查询原任务，勿重复生成。"); }
    if (!response.ok || payload.error) {
      const error = new Error(typeof payload.error === "string" ? payload.error : "音乐请求未完成，请稍后刷新。");
      error.code = payload.code;
      error.reason_code = payload.reason_code;
      error.status = response.status;
      error.submission_unknown = Boolean(payload.submission_unknown);
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function musicShouldPoll(job) {
  return Boolean(job?.provider_task_id) && ["submitted", "pending", "processing"].includes(job.status);
}

export async function downloadMusic(url, title, format = "audio") {
  // Never send site or APIMart credentials to a media CDN.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error("下载失败，请稍后重试或打开音频链接。");
    const mime = response.headers.get("content-type") || "";
    if (/json|text\/html/i.test(mime)) throw new Error("下载链接没有返回音频。");
    const limit = 80 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > limit) throw new Error("文件较大，请使用打开音频链接保存。");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error("文件较大，请使用打开音频链接保存。");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    const extension = format === "wav" ? "wav" : /wav/i.test(mime) ? "wav" : /mp4|m4a/i.test(mime) ? "m4a" : /mpeg|mp3/i.test(mime) ? "mp3" : "audio";
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: mime || "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    const safeTitle = Array.from(String(title || "音乐")).map(char => char.codePointAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? "_" : char).slice(0, 80).join("");
    anchor.download = `${safeTitle}.${extension}`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } finally { clearTimeout(timer); }
}
