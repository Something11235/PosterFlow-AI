import { getCanvasAsset } from './creationCanvasProject.js';
import { SEEDANCE25_FLASH } from './seedance25.js';
import { videoFile, videoMediaDuration } from './video.js';
import { WAN30, WAN_DOCUMENTS } from './wan30.js';

const imageTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const imageExtension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const maxImageBytes = 16 * 1024 * 1024;
const extensions = filename => String(filename || '').split('.').at(-1).toLowerCase();
export const CANVAS_REFERENCE_ACCEPT = [...new Set(['png','jpg','jpeg','webp','bmp','tif','tiff','gif','heic','heif',
  'mp4','mov','mp3','wav',...WAN_DOCUMENTS])].map(ext => '.' + ext).join(',');

function remoteUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* A local asset needs no URL. */ }
  return '';
}

function measuredMilliseconds(seconds) {
  const ms = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('没有读到有效的媒体时长，请检查文件能否播放。');
  return ms;
}

export async function readCanvasVideoDuration({ blob, url }, signal) {
  // A playable CDN can expose metadata even when it disallows cross-origin
  // downloads. Never substitute the requested length for the produced length.
  if (blob?.size) {
    try { return measuredMilliseconds(await videoMediaDuration(blob, 'video', signal)); }
    catch (error) { if (signal?.aborted || !remoteUrl(url)) throw error; }
  }
  const source = remoteUrl(url);
  if (!source) throw new Error('请先取得视频文件或可播放的视频链接。');
  return measuredMilliseconds(await videoMediaDuration(source, 'video', signal));
}

export async function prepareCanvasReference(file, signal) {
  if (!(file instanceof Blob) || !file.size || !file.name) throw new Error('请选择有内容的素材文件。');
  const ext = extensions(file.name);
  // The reference may feed different nodes. Use the largest supported upload
  // class here; the receiving node validates its model's limits before submit.
  const model = WAN_DOCUMENTS.includes(ext) ? WAN30 : ['mp3', 'wav'].includes(ext) ? undefined : SEEDANCE25_FLASH;
  const kind = videoFile(file, model);
  const info = { assetKind: kind, filename: file.name };
  if (kind === 'video' || kind === 'audio') {
    info.duration_ms = measuredMilliseconds(await videoMediaDuration(file, kind, signal));
  }
  return info;
}

export function canvasInputInfo(input) {
  const kind = input.type === 'reference' ? input.assetKind || 'image'
    : input.type === 'video' ? 'video' : input.type === 'prompt' ? 'text' : 'image';
  const defaults = { image: 'reference.png', video: 'video.mp4', audio: 'audio.mp3', document: 'document.pdf', text: '提示词' };
  const name = (input.run ? input.run.filename : input.filename) || defaults[kind];
  const duration = input.run ? input.run.duration_ms : input.duration_ms;
  return { kind, name, ...(['video','audio'].includes(kind) && Number.isSafeInteger(duration) && duration > 0 ? { duration_ms: duration } : {}) };
}

async function fetchRemoteImage(url) {
  let response;
  try {
    response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
  } catch {
    throw new Error('无法读取参考图，请下载原图后上传。');
  }
  if (!response.ok || !response.body) throw new Error('无法读取参考图，请下载原图后上传。');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxImageBytes) {
      await reader.cancel();
      throw new Error('生图节点的单张参考图最多 16 MB。');
    }
    chunks.push(value);
  }
  return new Blob(chunks, { type: (response.headers.get('content-type') || '').split(';')[0] });
}

export async function readCanvasReference(owner, projectId, input, targetKind) {
  const info = canvasInputInfo(input);
  if (input.run && input.run.status !== 'completed') throw new Error(`「${input.title}」的生成结果尚未完成。`);
  if (info.kind === 'text' || targetKind === 'image' && info.kind !== 'image') {
    throw new Error('生图节点只接受图片参考；视频、音频和文档请连接视频节点。');
  }
  const assetId = input.run ? input.run.assetId : input.assetId;
  let blob = assetId ? await getCanvasAsset(owner, projectId, assetId) : null;
  const url = remoteUrl(input.run ? input.run.url : input.url);
  if (!blob?.size && !url) throw new Error(`请先为「${input.title}」添加或生成素材。`);
  const filename = input.run ? input.run.filename : input.filename;
  const urlExt = url && extensions(new URL(url).pathname);
  if (targetKind === 'image') {
    if (!blob) blob = await fetchRemoteImage(url);
    if (blob.size > maxImageBytes) throw new Error('生图节点的单张参考图最多 16 MB。');
    const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : imageTypes[filename ? extensions(filename) : urlExt];
    if (!blob.size || !Object.values(imageTypes).includes(type)) throw new Error('生图节点的参考图支持 JPG、PNG 和 WebP。');
    if (type !== blob.type) blob = blob.slice(0, blob.size, type);
  }
  if (!filename && info.kind === 'image') {
    const ext = imageExtension[blob?.type] || (imageTypes[urlExt] && urlExt);
    if (ext) info.name = `reference.${ext}`;
  }
  if (info.kind === 'video' && !info.duration_ms) info.duration_ms = await readCanvasVideoDuration({ blob, url });
  if (info.kind === 'audio' && !info.duration_ms) info.duration_ms = measuredMilliseconds(await videoMediaDuration(blob || url, 'audio'));
  return { ...info, ...(blob ? { blob } : {}), ...(url ? { url } : {}) };
}
