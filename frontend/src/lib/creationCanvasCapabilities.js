import { FLUX3, FLUX_RATIOS } from './flux3.js';
import { isMinimaxH3, MINIMAX_H3_MAX } from './minimaxH3.js';
import { OMNI_FLASH } from './omniFlash.js';
import { apimartImageModel, imageResolutionSpec, MAX_REFERENCE_IMAGES } from './provider.js';
import { SEEDANCE20, SEEDANCE20_FAST } from './seedance20.js';
import { SEEDANCE25, SEEDANCE25_FLASH, isSeedance25 } from './seedance25.js';
import { defaultVideoForModel, VIDEO_SIZES } from './video.js';
import { WAN30 } from './wan30.js';

const imageRatios = { square_1_1: '1:1', landscape_16_9: '16:9', portrait_9_16: '9:16',
  landscape_4_3: '4:3', portrait_3_4: '3:4', landscape_3_2: '3:2', portrait_2_3: '2:3', wide_21_9: '21:9' };
const labels = { auto: '自动', adaptive: '自适应', quality: '由模型决定', generate: '正式生成', draft: '生成样片',
  frames: '首帧 / 首尾帧', reference: '参考素材', keyframes: '有序关键帧', edit: '视频编辑', extend: '视频续写',
  text_to_video: '文生视频', image_to_video: '图生视频', reference_to_video: '参考素材创作', '-1': '自动时长' };
function select(key, label, values, names = labels) {
  return { key, label, type: 'select', options: values.map(value => ({ value, label: names[value] ?? String(value) })) };
}
const toggle = (key, label) => ({ key, label, type: 'checkbox' });

export function canvasModelCapabilities(kind, model, params = {}, service = {}) {
  if (kind === 'image') {
    const spec = imageResolutionSpec(model);
    // The generic adapter enforces a reference upload limit but cannot know a custom model's size or resolution options.
    if (!spec) return { defaults:{}, controls:[], maxImages:MAX_REFERENCE_IMAGES, maxVideos:0, maxAudios:0, maxDocuments:0, referenceSupport:'unknown' };
    const ext = model === 'grok-imagine-2.0-ext';
    const directGpt = model.startsWith('gpt-image-2.6-') && service.billingMode === 'own_key' && service.providerOrigin === 'https://api.apimart.ai';
    const usesRatios = Boolean(apimartImageModel(model)) && (!model.startsWith('gpt-image-2.6-') || directGpt);
    const ratios = Object.keys(imageRatios).filter(key => (!model.startsWith('grok-') || key !== 'wide_21_9')
      && (usesRatios || !['landscape_3_2','portrait_2_3'].includes(key)));
    const allowAuto = usesRatios && !ext;
    const defaults = { resolution:spec.resolutions[0], size:allowAuto ? '' : 'square_1_1' };
    const controls = [select('size', '画幅', allowAuto ? ['', ...ratios] : ratios, { ...imageRatios, '': '自动' })];
    if (!spec.automaticResolution) controls.unshift(select('resolution', '清晰度', directGpt ? ['1K'] : spec.resolutions));
    return { defaults, controls, maxImages: spec.maxReferences, maxVideos: 0, maxAudios: 0, maxDocuments: 0 };
  }
  if (kind !== 'video') throw new Error('请选择生图或视频节点。');
  const flux = model === FLUX3, omni = model === OMNI_FLASH, wan = model === WAN30;
  const newer = isSeedance25(model), flash = model === SEEDANCE25_FLASH, h3 = isMinimaxH3(model), h3Max = model === MINIMAX_H3_MAX;
  const source = defaultVideoForModel(model);
  const defaults = { ...source, imageMode: flux ? 'keyframes' : 'auto' };
  for (const key of ['model', 'prompt', 'draft_request_id', 'continue_request_id']) delete defaults[key];
  if (Object.hasOwn(defaults, 'size')) defaults.size = 'adaptive';
  if (Object.hasOwn(defaults, 'return_last_frame')) defaults.return_last_frame = true;
  const controls = [];
  if (flux || model === SEEDANCE25) controls.push(select('workflow', '制作流程', ['generate', 'draft']));
  const draft = params.workflow === 'draft' && (flux || model === SEEDANCE25);
  let resolutions;
  if (flux) resolutions = draft ? ['hd'] : ['hd', 'fhd'];
  else if (omni) resolutions = ['360p', '720p', '1080p', '4k'];
  else if (h3) resolutions = h3Max ? ['480p', '768p', '1080p'] : ['768p', '2k'];
  else if (draft) resolutions = ['480p'];
  else if (model === SEEDANCE20) resolutions = ['480p', '720p', '1080p', '4k'];
  else if (flash || model === SEEDANCE20_FAST || !wan && !newer) resolutions = ['480p', '720p'];
  else resolutions = ['480p', '720p', '1080p'];
  controls.push(select('resolution', '清晰度', resolutions));
  if (omni) controls.push(select('task', '创作方式', ['auto','text_to_video','image_to_video','reference_to_video','edit','extend']));
  if (newer) controls.push(select('omni_reference_task_type', '创作方式', ['auto','reference','edit','extend']));
  const textOnly = omni && params.task === 'text_to_video';
  const videoEdit = ['edit','extend'].includes(omni ? params.task : params.omni_reference_task_type);
  if (!flux && !textOnly) controls.push(select('imageMode', '图片用途', videoEdit ? ['auto','reference'] : ['auto','frames','reference']));
  const edit = newer && params.omni_reference_task_type === 'edit';
  if (!omni) {
    const min = flux || h3Max ? 5 : wan ? 2 : 4;
    const max = newer || wan ? 30 : flux ? 20 : 15;
    const seconds = Array.from({ length: max - min + 1 }, (_, i) => min + i);
    controls.push(select('duration', '生成时长', edit ? [-1] : newer || wan ? [-1, ...seconds] : seconds,
      Object.fromEntries([[-1, '自动时长'], ...seconds.map(value => [value, value + ' 秒'])])));
  }
  const ratioKey = flux || omni ? 'aspect_ratio' : 'size';
  const adaptive = newer && ['edit','extend'].includes(params.omni_reference_task_type) || params.imageMode === 'frames' && (newer || wan || h3);
  controls.push(select(ratioKey, '画幅', flux ? FLUX_RATIOS : omni ? ['16:9','9:16'] : adaptive ? ['adaptive']
    : VIDEO_SIZES.filter(ratio => !wan || ratio !== '21:9')));
  for (const [key, label] of [['audio','生成声音'], ['generate_audio','生成声音'], ['watermark','水印'], ['web_search','联网搜索'],
    ['return_last_frame','同时返回尾帧'], ['nsfw_check','内容预检查']]) {
    if (Object.hasOwn(defaults, key) && !(key === 'watermark' && h3Max && params.resolution === '1080p')) controls.push(toggle(key, label));
  }
  if (Object.hasOwn(defaults,'seed')) controls.push({ key:'seed', label:'随机种子', type:'number', min:wan ? 0 : -1, max:2147483647, step:1, optional:true });
  if (newer) controls.push(select('output_format','视频格式',['mp4','mov']));
  if (flux) controls.push(select('safety_tolerance','审核容忍度',[0,1,2,3,4]));
  if (wan) controls.push({key:'link_url',label:'网页参考',type:'text',optional:true});
  if (textOnly) return { controls, defaults, maxImages:0, maxVideos:0, maxAudios:0, maxDocuments:0 };
  if (params.imageMode === 'frames' && !flux && !videoEdit) return { controls, defaults, maxImages:2, maxVideos:0, maxAudios:0, maxDocuments:0 };
  return { controls, defaults, maxImages:flash||wan||omni||flux ? 10 : newer ? 30 : 9,
    maxVideos:flux||omni ? 1 : wan||flash ? 5 : newer ? 10 : 3,
    maxAudios:flux||omni ? 0 : wan||flash ? 5 : newer ? 10 : 3, maxDocuments:wan ? 1 : 0 };
}

// Only retain the selected model's supported fields in a task snapshot.
export function canvasParameters(kind, model, params = {}, service = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('生成参数格式无效。');
  const { controls, defaults } = canvasModelCapabilities(kind, model, params, service);
  const selected = { ...defaults };
  for (const field of controls) {
    let value = params[field.key] ?? selected[field.key];
    if (field.type === 'select') {
      if (field.options.length === 1) value = field.options[0].value;
      else {
        const chosen = field.options.find(option => String(option.value) === String(value));
        if (chosen) value = chosen.value;
        else if (field.key === 'imageMode' && value === 'frames') value = 'auto';
        else throw new Error('当前模型不支持所选' + field.label + '。');
      }
    } else if (field.type === 'checkbox' && typeof value !== 'boolean') throw new Error('请重新选择' + field.label + '。');
    else if (field.type === 'number' && value !== '' && (!Number.isSafeInteger(Number(value)) || Number(value) < field.min || Number(value) > field.max)) {
      throw new Error(field.label + '超出有效范围。');
    } else if (field.type === 'text' && typeof value !== 'string') throw new Error(field.label + '格式无效。');
    selected[field.key] = value;
  }
  return selected;
}
