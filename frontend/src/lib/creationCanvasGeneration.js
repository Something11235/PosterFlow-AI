import { imageGenerationFetch, imageTaskPendingState, readImageTask, readLegacyImageTask, usesBuyToken } from './apimartImages.js';
import { fetchImageBlob } from './client.js';
import { imageRefundError } from './imageRefund.js';
import { APIMART_IMAGE_MODELS, apimartImageModel, DEFAULT_PLATFORM_MODEL, IMAGE_MODEL_OPTIONS, imageCreditCost, imageResolutionSpec, isRetiredImageModel } from './provider.js';
import { cleanupReferencePaths, uploadReferenceBlobs } from './referenceUpload.js';
import { SEEDANCE25, SEEDANCE25_FLASH, isSeedance25, seedance25AutoVideo } from './seedance25.js';
import { FLUX3 } from './flux3.js';
import { OMNI_FLASH } from './omniFlash.js';
import { WAN30 } from './wan30.js';
import { isMinimaxH3 } from './minimaxH3.js';
import { VIDEO_MODELS } from './studioCatalog.js';
import { buildVideoParameters, uploadVideoReference, validateVideoReferenceDuration, videoApi, videoFile, videoQuote, videoReferenceInput } from './video.js';
import { videoMentionError } from './videoMentions.js';
import { canvasModelCapabilities, canvasParameters } from './creationCanvasCapabilities.js';
import { videoSubmissionFailure } from './videoJobs.js';

export { canvasModelCapabilities };

const pending = message => ({ status: 'pending', message: message || '结果暂未确认，请查询原任务。' });
const failed = message => ({ status: 'failed', message: message || '本次生成未完成。' });

const APIMART_IMAGES = 'https://api.apimart.ai/v1/images/generations';
const BUYTOKEN_IMAGES = 'https://api.buytoken.work/v1/images/generations';
const APIMART_VIDEOS = 'https://api.apimart.ai/v1/videos/generations';
const imageOption = ({ value, label }) => ({ value, label });

function billingFor(kind, context) {
  return (kind === 'video' ? context.videoConnection?.mode : context.billingMode) || 'platform';
}

function imageEndpoint(headers) {
  return (headers.get('X-Provider-Endpoint') || '').trim().replace(/\/+$/, '');
}

function providerOrigin(endpoint) {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin;
  } catch { /* Configuration can be incomplete. */ }
  return '';
}

export function canvasModelOptions(kind, context = {}) {
  if (kind === 'video') {
    const connection = context.videoConnection || {};
    const available = VIDEO_MODELS.filter(model => model.available);
    const custom = connection.mode === 'own_key' && connection.endpoint && connection.endpoint !== APIMART_VIDEOS;
    return available.filter(model => !custom || model.id === connection.model)
      .map(({ id: value, name: label }) => ({ value, label }));
  }
  if (kind !== 'image') return [];
  if (billingFor(kind, context) === 'platform') return IMAGE_MODEL_OPTIONS.map(imageOption);
  const headers = new Headers(context.providerHeaders);
  const configured = headers.get('X-Provider-Model') || context.imageModel;
  const endpoint = imageEndpoint(headers);
  let models = [];
  if (endpoint === APIMART_IMAGES && (headers.get('X-Provider-Auth-Type') || 'bearer') === 'bearer') {
    models = APIMART_IMAGE_MODELS;
  } else if (endpoint === BUYTOKEN_IMAGES) {
    models = IMAGE_MODEL_OPTIONS.filter(item => item.provider === 'buytoken' || item.value.startsWith('gpt-image-2.5-'));
  }
  const acceptsConfigured = endpoint === APIMART_IMAGES || !apimartImageModel(configured)
    || (endpoint === BUYTOKEN_IMAGES && configured?.startsWith('gpt-image-2.6-'));
  if (configured && acceptsConfigured && !isRetiredImageModel(configured) && !models.some(item => item.value === configured)) {
    models = [...models, imageResolutionSpec(configured) || { value: configured, label: configured }];
  }
  return models.map(imageOption);
}

function configuredOrigin(kind, context) {
  return kind === 'video' ? providerOrigin(context.videoConnection?.endpoint || APIMART_VIDEOS)
    : providerOrigin(imageEndpoint(new Headers(context.providerHeaders)));
}

export function canvasGenerationSettings({ kind, context = {}, model, params = {}, resolution, duration, billingMode, providerOrigin: savedOrigin }) {
  if (kind !== 'video' && kind !== 'image') throw new Error('请选择生图或视频节点。');
  billingMode ||= billingFor(kind, context);
  if (!['platform', 'own_key'].includes(billingMode)) throw new Error('请选择有效的积分或自带 Key 模式。');
  const scope = kind === 'video' ? { ...context, videoConnection: { ...context.videoConnection, mode: billingMode } } : { ...context, billingMode };
  const options = canvasModelOptions(kind, scope);
  const preferred = kind === 'video' ? context.videoConnection?.model || SEEDANCE25
    : context.imageModel || DEFAULT_PLATFORM_MODEL;
  model ||= options.find(item => item.value === preferred)?.value || options[0]?.value;
  if (!options.some(item => item.value === model)) throw new Error('请在当前服务中选择或配置可用模型。');
  const settings = { model, billingMode };
  if (billingMode === 'own_key') {
    const origin = configuredOrigin(kind, context);
    if (savedOrigin && origin !== savedOrigin) throw new Error('请恢复此任务原来的服务地址和 API Key。');
    if (origin) settings.providerOrigin = origin;
  }
  const values = canvasParameters(kind, model, { ...resolution && {resolution}, ...duration != null && {duration}, ...params },settings);
  return { ...settings, kind, params: values, resolution: values.resolution,
    ...(values.duration != null ? { duration: values.duration } : {}) };
}

const kindNames = {image:'图片',video:'视频',audio:'音频',document:'文档'};
const kindLimits = {image:'maxImages',video:'maxVideos',audio:'maxAudios',document:'maxDocuments'};
function inputKind(ref) {
  const mime = (ref instanceof Blob ? ref.type : ref?.blob?.type) || '';
  return ref?.kind || (mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'image');
}

function imageRoles(settings, refs) {
  const images = refs.filter(ref => inputKind(ref) === 'image');
  const mode = settings.params.imageMode;
  const mixed = images.length !== refs.length;
  const frames = mode === 'frames' || (mode === 'auto' && !mixed && images.length === 1);
  return refs.map(ref => {
    if (inputKind(ref) !== 'image' || settings.model === FLUX3) return undefined;
    if (ref.role) return ref.role;
    if (frames) return images.indexOf(ref) === 0 ? 'first_frame' : 'last_frame';
    return undefined;
  });
}

export function validateCanvasInputs(settings, refs = [], { partial = false } = {}) {
  const { kind, model, params } = settings;
  const caps = canvasModelCapabilities(kind, model, params);
  const counts = { image:0,video:0,audio:0,document:0 };
  for (const ref of refs) {
    const type = inputKind(ref);
    if (!Object.hasOwn(counts,type)) throw new Error('无法识别此素材的类型。');
    if (++counts[type] > caps[kindLimits[type]]) {
      if (kind === 'image' && type === 'image' && !caps.maxImages) throw new Error('当前模型仅支持文字生图，请断开参考图或切换模型。');
      if (kind === 'video' && params.imageMode === 'frames') throw new Error('首尾帧模式只支持首帧、尾帧各一张。');
      if (model === OMNI_FLASH && params.task === 'text_to_video') throw new Error('文生视频只需提示词，请断开参考素材。');
      throw new Error(caps[kindLimits[type]] ? '当前模型最多支持 ' + caps[kindLimits[type]] + ' 份' + kindNames[type] + '素材。' : '当前模型不支持' + kindNames[type] + '素材。');
    }
    if (kind === 'video' && ['audio','video'].includes(type) && ref.duration_ms != null) {
      validateVideoReferenceDuration(ref.duration_ms / 1000, model);
    }
  }
  if (kind !== 'video') return;
  const roles = imageRoles(settings, refs);
  const frames = roles.filter(role => role === 'first_frame' || role === 'last_frame');
  const mixFrames = frames.length && frames.length !== refs.length;
  if (new Set(frames).size !== frames.length || params.imageMode === 'frames' && (counts.image > 2 || refs.length !== counts.image)) throw new Error('首尾帧模式只支持首帧、尾帧各一张。');
  if (mixFrames && !isSeedance25(model) && model !== OMNI_FLASH) throw new Error('当前模型的首尾帧不能与其他参考素材混用。');
  if (model === FLUX3 && counts.video && counts.image) throw new Error('FLUX 的视频续写与有序图片关键帧不能混用。');
  if (model === WAN30 && (counts.document || frames.length) && params.link_url) throw new Error('Wan 网页不能与首尾帧或参考文档混用。');
  if (model === OMNI_FLASH && params.task === 'text_to_video' && refs.length) throw new Error('文生视频只需提示词，请断开参考素材。');
  const durationOf = kind => refs.filter(ref => inputKind(ref) === kind).reduce((sum, ref) => sum + (ref.duration_ms ?? 0), 0);
  if (isSeedance25(model)) {
    if (durationOf('video') > 30000 || durationOf('audio') > 30000) throw new Error('参考视频或音频各自合计最多 30 秒。');
    if ((params.omni_reference_task_type === 'edit' || model === SEEDANCE25 && params.omni_reference_task_type === 'auto')
      && refs.some(ref => inputKind(ref) === 'video' && ref.duration_ms != null && ref.duration_ms < 4000)) {
      throw new Error('自动编辑的视频素材至少需要 4 秒，请切换为参考素材创作或续写。');
    }
  } else if (model === WAN30 || isMinimaxH3(model)) {
    if (durationOf('video') > 15000 || durationOf('audio') > 15000) throw new Error('参考视频或音频各自合计最多 15 秒。');
    if (model === WAN30 && params.duration > 0 && params.duration * 1000 + durationOf('video') > 30000) throw new Error('参考视频与生成时长之和最多 30 秒。');
  } else if (![FLUX3, OMNI_FLASH].includes(model) && (durationOf('video') >= 15200 || durationOf('audio') > 15000)) {
    throw new Error('2.0 系列参考视频总时长需小于 15.2 秒，参考音频合计最多 15 秒。');
  }
  if (partial) return;
  if (params.imageMode === 'frames' && !counts.image) throw new Error('请连接一张首帧图片。');
  if (frames.includes('last_frame') && !frames.includes('first_frame') && (model === OMNI_FLASH || model === WAN30 || model === SEEDANCE25_FLASH)) throw new Error('尾帧须搭配首帧使用。');
  if (['edit','extend'].includes(params.task || params.omni_reference_task_type) && !counts.video) throw new Error('此创作方式至少需要一段视频。');
  if (['reference_to_video','image_to_video'].includes(params.task) && !counts.image) throw new Error('此创作方式至少需要一张图片。');
  if (model === SEEDANCE25_FLASH && params.omni_reference_task_type === 'reference' && !refs.length) throw new Error('参考素材创作至少需要一份素材。');
  if (!isSeedance25(model) && model !== WAN30 && counts.audio && !counts.video && !counts.image) throw new Error('参考音频须与视频或普通参考图搭配。');
}

function videoSettingsForInputs(settings, refs) {
  const { model, params } = settings;
  const values = { ...params, model };
  const locked = new Set();
  const roles = imageRoles(settings, refs);
  const framesOnly = roles.length > 0 && roles.every(role => ['first_frame','last_frame'].includes(role));
  if (framesOnly && (isSeedance25(model) || isMinimaxH3(model) || model === WAN30)) {
    values.size = 'adaptive'; locked.add('size');
  }
  if (seedance25AutoVideo(values, refs.some(ref => inputKind(ref) === 'video'))) {
    values.size = 'adaptive'; values.duration = -1;
    locked.add('size'); locked.add('duration');
  }
  return {values, locked};
}

export function canvasEffectiveControls(settings, referenceInfo = []) {
  const { kind, model, params } = settings;
  const { controls } = canvasModelCapabilities(kind,model,params,settings);
  if (kind !== 'video') return controls.map(c => ({...c, effectiveValue:params[c.key], disabled:c.options?.length === 1}));
  const {values,locked} = videoSettingsForInputs(settings,referenceInfo);
  return controls.map(control => {
    const value = values[control.key];
    const disabled = control.options?.length === 1 || locked.has(control.key);
    return {...control, effectiveValue:value, disabled, ...(disabled && control.options ? {options:control.options.filter(o=>o.value === value)} : {})};
  });
}

function videoParameters(settings, prompt, refs) {
  return buildVideoParameters({...videoSettingsForInputs(settings,refs).values,prompt});
}

export function canvasGenerationQuoteDetails(options) {
  const settings = canvasGenerationSettings(options);
  const refs = options.referenceInfo ?? Array.from({length: options.referenceCount || 0}, () => ({kind:'image'}));
  validateCanvasInputs(settings, refs, {partial:true});
  if (settings.billingMode === 'own_key') return {credits:0,reservedCredits:0};
  if (options.kind === 'video') {
    if (refs.some(r => inputKind(r) === 'video' && !(Number.isSafeInteger(r.duration_ms) && r.duration_ms > 0))) throw new Error('请等待读取参考视频时长后核对报价。');
    const result = videoQuote(videoParameters(settings,'费用预估',refs),refs,undefined,{verified:false});
    return {credits:Number(result.text),reservedCredits:Number(result.reservedText ?? result.text)};
  }
  const credits = imageCreditCost(settings.model, refs.length, settings.resolution);
  return {credits,reservedCredits:credits};
}

export function canvasGenerationQuote(options) {
  return canvasGenerationQuoteDetails(options).credits;
}

function imageHeaders(context, settings, recovery = false) {
  if (settings.billingMode === 'own_key') {
    const provided = new Headers(context.providerHeaders);
    const configured = provided.get('X-Provider-Model');
    const origin = configuredOrigin('image', context);
    if (!provided.get('X-Provider-Api-Key') || !configured || !origin ||
      (settings.providerOrigin && origin !== settings.providerOrigin) ||
      (configured !== settings.model && (recovery && !settings.providerOrigin ||
        !canvasModelOptions('image', { ...context, billingMode: 'own_key' }).some(item => item.value === settings.model)))) {
      throw new Error('请在图片服务中配置此任务原来的服务地址、模型和 API Key。');
    }
    provided.set('X-Provider-Model', settings.model);
    provided.set('X-Billing-Mode', 'own_key');
    return Object.fromEntries(provided);
  }
  return { ...context.authHeaders, 'X-Billing-Mode': 'platform' };
}

function videoOptions(context, settings, signal) {
  const connection = settings.billingMode === 'own_key' ? context.videoConnection : {};
  if (settings.billingMode === 'own_key') {
    const origin = configuredOrigin('video', context);
    if (!connection?.key || !origin || settings.providerOrigin && settings.providerOrigin !== origin ||
      connection.queryTemplate && providerOrigin(connection.queryTemplate) !== origin) {
      throw new Error('请先配置此任务原来的视频服务地址和 API Key。');
    }
  }
  return { ...connection, authHeaders: context.authHeaders, mode: settings.billingMode, model: settings.model, signal };
}

function mediaUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Media is optional when a CDN permits playback but not cross-origin reads.
// Enforce the limit even when the server does not send a Content-Length.
async function cacheMedia(url, kind, signal) {
  if (!url || signal?.aborted) return undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = setTimeout(abort, 20000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
    const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const limit = (kind === 'image' ? 16 : 64) * 1024 * 1024;
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit ||
      (type && type !== 'application/octet-stream' && !type.startsWith(kind + '/'))) return undefined;
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return undefined;
      chunks.push(value);
    }
    if (total) return new Blob(chunks, { type: type.startsWith(kind + '/') ? type : kind === 'image' ? 'image/png' : 'video/mp4' });
  } catch { /* The URL remains available for playback or server-side frame import. */ }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); controller.abort(); }
}

async function videoResult(data, signal) {
  const job = data?.job;
  if (job?.status === 'failed' || job?.status === 'not_submitted') return failed(data.failure_reason || job.failure_reason);
  const media = data?.videos?.[0];
  const url = mediaUrl(media?.url);
  if (job?.status !== 'completed' || !['settled', 'not_applicable'].includes(job.billing_status) || !url) {
    return pending(data?.warning || '正在等待原视频任务的结果。');
  }
  const lastFrameUrl = mediaUrl(media.last_frame_url);
  const [blob, lastFrameBlob] = await Promise.all([cacheMedia(url, 'video', signal), cacheMedia(lastFrameUrl, 'image', signal)]);
  return { status: 'completed', message: '视频已生成。', url, lastFrameUrl, blob, lastFrameBlob };
}

async function imageResult(data, context, settings) {
  const refund = imageRefundError(data, settings.billingMode);
  if (refund) return failed(refund.message);
  const status = data?.job?.status || data?.status;
  if (status === 'failed' || status === 'refunded') return failed(data.job?.failure_reason || data.error || data.failure_reason);
  const filename = data?.images?.[0]?.filename || data?.job?.image_keys?.[0];
  if (filename && (!status || ['succeeded', 'completed'].includes(status))) {
    try {
      let blob = await fetchImageBlob(filename, { authenticated: context.authenticated, headers: context.authHeaders });
      if (!blob.type || blob.type === 'application/octet-stream') {
        const ext = filename.split('.').at(-1).toLowerCase();
        if (['png', 'webp', 'jpg', 'jpeg', 'gif'].includes(ext)) blob = blob.slice(0, blob.size, 'image/' + (ext === 'jpg' ? 'jpeg' : ext));
      }
      return { status: 'completed', message: '图片已生成。', filename, blob };
    } catch (error) {
      return { ...pending('原任务已出图，读取图片时遇到问题。' + error.message), filename };
    }
  }
  return pending(data?.detail || data?.error || '正在等待原生图任务的结果。');
}

function refEntry(ref, index) {
  const blob = ref instanceof Blob ? ref : ref?.blob;
  if (!(blob instanceof Blob) || !blob.size || !blob.type.startsWith('image/')) throw new Error('参考图读取失败，请重新加入图片。');
  const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type.slice(6).split('+')[0];
  return { blob, name: ref.name || blob.name || `reference-${index + 1}.${ext}` };
}

async function submitImage({ context, settings, prompt, requestId, references, signal, beforeDispatch, onUploadProgress }) {
  const headers = imageHeaders(context, settings);
  const uploadHeaders = { ...context.authHeaders, 'X-Billing-Mode': settings.billingMode };
  const spec = imageResolutionSpec(settings.model);
  if (!prompt || Array.from(prompt).length > 6000) return failed('请连接一段 1–6000 字的提示词。');
  const maxReferences = spec?.maxReferences ?? 8;
  if (references.length > maxReferences) {
    return failed(maxReferences ? `当前模型最多支持 ${maxReferences} 张参考图。` : '当前模型仅支持文字生图，请断开参考图或切换模型。');
  }
  if (spec && !spec.resolutions.includes(settings.resolution)) return failed('当前模型不支持所选清晰度。');
  const paths = references.length ? await uploadReferenceBlobs(references.map(refEntry), { headers: uploadHeaders, onUploadProgress }) : [];
  try {
    if (signal?.aborted) return failed('参考图准备已取消，尚未提交生成。');
    const body = { request_id: requestId, prompt, count: 1, quality: 'auto',
      ...(settings.billingMode === 'platform' ? { platform_model: settings.model } : {}),
      ...(settings.params.size ? { size: settings.params.size } : {}),
      ...(spec && !spec.automaticResolution ? { resolution: settings.resolution } : {}),
      ...(paths.length ? { reference_storage_paths: paths } : {}) };
    try { await beforeDispatch?.(); } catch (error) { return failed(error.message); }
    const response = await imageGenerationFetch('/api/generate', { method: 'POST', credentials: 'same-origin', signal,
      headers: { ...headers, 'Content-Type': 'application/json', 'X-Request-Id': requestId }, body: JSON.stringify(body) }, { maxWait: 0 });
    const data = await response.json();
    if (!response.ok && data?.error && !data.refunded && !data.job) {
      if (data.submission_unknown || data.code === 'REQUEST_ALREADY_PROCESSED') return pending(data.detail || data.error);
      if (data.generation_submitted === false || data.submission_unknown === false || (response.status < 500 && response.status !== 408)) return failed(data.detail || data.error);
      return pending(data.detail || data.error);
    }
    return await imageResult(data, context, settings);
  } catch (error) { return pending(error.message); }
  finally { await cleanupReferencePaths(paths, uploadHeaders); }
}

async function submitVideo({ context, settings, prompt, requestId, references, signal, beforeDispatch, expectedCredits, expectedReservedCredits }) {
  validateCanvasInputs(settings,references);
  if (!references.length && !prompt && !settings.params.link_url) return failed('请连接提示词或添加参考素材后再生成。');
  const fallback = references.length && references.every(ref => inputKind(ref) === 'image')
    ? '延续参考图的画面内容和风格，生成自然连贯的镜头。' : '';
  const parameters = videoParameters(settings, prompt || fallback, references);
  if (isSeedance25(settings.model) || settings.model === WAN30) {
    const issue = videoMentionError(parameters.prompt,references.map(ref => ({kind:inputKind(ref)})));
    if (issue) return failed(issue);
  }
  const options = videoOptions(context, settings, signal);
  const roles = imageRoles(settings, references), items = [];
  for (const [i,input] of references.entries()) {
    if (signal?.aborted) return failed('素材准备已取消，尚未提交视频生成。');
    const kind = inputKind(input);
    const blob = input instanceof Blob ? input : input?.blob;
    const name = input.name || blob?.name || (kind === 'image' && blob ? refEntry(input,i).name
      : { image:'last-frame.png',video:'shot.mp4',audio:'sound.wav',document:'reference.pdf' }[kind]);
    let reference;
    if (blob?.size) {
      const file = new File([blob],name,{type:blob.type});
      if (videoFile(file,settings.model) !== kind) return failed('素材格式与文件类型不符，请重新选择。');
      reference = await uploadVideoReference(file, options, signal);
    } else if (mediaUrl(input?.url)) {
      const imported = await videoApi('/references/import-url', { ...options, body: { url: input.url, filename: name } });
      reference = imported.reference;
    } else return failed('素材尚未就绪，请重新选择文件。');
    if (reference?.kind !== kind) return failed('素材的实际类型与连接的输入不符，请重新选择。');
    items.push({reference, state:'ready', role:roles[i]});
  }
  const refs = videoReferenceInput(items, 'unified', settings.model, parameters);
  if (settings.billingMode === 'platform' && (expectedCredits != null || expectedReservedCredits != null)) {
    const verified = videoQuote(parameters,items.map(item => item.reference));
    const reserved = Number(verified.reservedText ?? verified.text);
    if (expectedCredits != null && Number(verified.text) !== expectedCredits || expectedReservedCredits != null && reserved !== expectedReservedCredits) {
      return failed('素材校验后预计使用 ' + verified.text + ' 积分，需预留 ' + reserved + ' 积分。请重新核对素材时长和报价。');
    }
  }
  if (signal?.aborted) return failed('素材准备已取消，尚未提交视频生成。');
  await beforeDispatch?.();
  try {
    const data = await videoApi('/generations', { ...options, body: { request_id: requestId, parameters, references: refs } });
    return await videoResult(data, signal);
  } catch (error) {
    const state = videoSubmissionFailure({}, error);
    return state.status === 'submission_unknown' ? pending(state.failure_reason) : failed(state.failure_reason);
  }
}

export async function submitCanvasGeneration(options) {
  try {
    const settings = canvasGenerationSettings(options);
    if (!options.requestId) return failed('项目尚未保存任务编号。');
    const context = options.context || {};
    if ((settings.billingMode === 'platform' || options.kind === 'video') && !context.authenticated) return failed('请先登录并完成邮箱验证。');
    const input = { ...options, context, settings, references: options.references || [], prompt: (options.prompt || '').trim() };
    if (options.kind === 'image') {
      validateCanvasInputs(settings,input.references);
      if (settings.billingMode === 'platform') {
        const cost = imageCreditCost(settings.model,input.references.length,settings.resolution);
        if (options.expectedCredits != null && cost !== options.expectedCredits || options.expectedReservedCredits != null && cost !== options.expectedReservedCredits) return failed('图片报价已变化，请重新核对。');
      }
    }
    return options.kind === 'video' ? await submitVideo(input) : await submitImage(input);
  } catch (error) { return failed(error.message); }
}

// Restoring the project cannot execute a generation endpoint: only read its saved ID.
export async function queryCanvasGeneration(options) {
  const { requestId, kind, context = {}, signal } = options;
  if (!requestId) return failed('项目没有可查询的任务编号。');
  try {
    // Older snapshots may reference retired models or a different billing mode
    // than today's picker. Read them using their original model and billing mode.
    const settings = { model: options.model || (kind === 'video' ? SEEDANCE25 : DEFAULT_PLATFORM_MODEL),
      billingMode: options.billingMode || 'platform', providerOrigin: options.providerOrigin };
    if (kind === 'video') {
      const data = await videoApi('/tasks/' + encodeURIComponent(requestId), videoOptions(context, settings, signal));
      return await videoResult(data, signal);
    }
    const headers = imageHeaders(context, settings, true);
    const route = usesBuyToken(settings.model, headers) ? 'buytoken' : 'apimart';
    const data = apimartImageModel(settings.model)
      ? await readImageTask(requestId, headers, signal, settings.model, route, { timeoutMs: 30000, allowLegacyFallback: settings.billingMode === 'platform' })
      : await readLegacyImageTask(requestId, context.authHeaders);
    const refund = imageRefundError(data, settings.billingMode);
    if (refund) return failed(refund.message);
    const state = imageTaskPendingState(data.job, route);
    return state ? pending(state.message) : await imageResult(data, context, settings);
  } catch (error) {
    return pending(error.status === 404 ? '暂未查到原任务，请稍后再次查询。' : error.message);
  }
}
