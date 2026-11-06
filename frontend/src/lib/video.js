import {FLUX3,defaultFlux3,buildFlux3,flux3Quote,validateFluxReferences} from './flux3.js';
import {WAN30,WAN_DOCUMENTS,defaultWan30,buildWan30,wan30Quote,validateWanReferences,validateWanDimensions} from './wan30.js';
import { isMinimaxH3, buildMinimaxH3, defaultMinimaxH3, minimaxH3Quote, validateH3References, validateH3Dimensions } from './minimaxH3.js';
import { creditText } from './credits.js';
import { SEEDANCE25, buildSeedance25, defaultSeedance25, seedance25Quote } from './seedance25.js';
import { isSeedance20, buildSeedance20, defaultSeedance20, seedance20Quote } from './seedance20.js';
import { OMNI_FLASH, buildOmniFlash, defaultOmniFlash, omniFlashQuote, validateOmniReferences } from './omniFlash.js';

export const VIDEO_MODEL = 'seedance-2.0-mini';
export const VIDEO_SIZES = ['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'];
export const defaultVideo = () => ({ model: VIDEO_MODEL, prompt: '', resolution: '480p', duration: 5, size: '16:9', seed: '', generate_audio: true, return_last_frame: false, web_search: false, nsfw_check: false });
export const videoStatus = { submitting:'正在提交', submitted:'已受理', pending:'等待生成', processing:'生成中', completed:'已完成', failed:'未完成', unknown:'状态待确认', submission_unknown:'提交结果待确认' };

export function buildVideoParameters(values) {
  if(values.model===FLUX3)return buildFlux3(values);
  if(values.model===WAN30)return buildWan30(values);
  if(isMinimaxH3(values.model))return buildMinimaxH3(values);
  if(values.model===OMNI_FLASH)return buildOmniFlash(values);
  if(isSeedance20(values.model))return buildSeedance20(values);
  if(values.model===SEEDANCE25)return buildSeedance25(values);
  if (values.model && values.model!==VIDEO_MODEL) throw new Error('该视频模型暂未开放生成。');
  const duration=Number(values.duration), seed=String(values.seed ?? '').trim();
  if (!Number.isInteger(duration) || duration<4 || duration>15 || !['480p','720p'].includes(values.resolution) || !VIDEO_SIZES.includes(values.size)) throw new Error('请选择 480P / 720P、4–15 秒和有效画幅。');
  const prompt=String(values.prompt || '').trim();
  if (Array.from(prompt).length>32000) throw new Error('提示词最多 32000 个字符（本站限制）。');
  const body={model:VIDEO_MODEL,prompt,duration,resolution:values.resolution,size:values.size,generate_audio:Boolean(values.generate_audio),return_last_frame:Boolean(values.return_last_frame),nsfw_check:Boolean(values.nsfw_check)};
  if (seed) {
    const n=Number(seed);
    if (!/^-?\d+$/.test(seed) || !Number.isInteger(n) || n < -1 || n > 2147483647) throw new Error('随机种子须为 -1 至 2147483647 的整数（本站限制）。');
    body.seed=n;
  }
  if (values.web_search) body.tools=[{type:'web_search'}];
  return body;
}

export function cleanVideoHistory(parameters) {
  try { return buildVideoParameters({...parameters?.model===FLUX3?defaultFlux3():parameters?.model===WAN30?defaultWan30():isMinimaxH3(parameters?.model)?defaultMinimaxH3(parameters.model):parameters?.model===OMNI_FLASH?defaultOmniFlash():parameters?.model===SEEDANCE25?defaultSeedance25():isSeedance20(parameters?.model)?defaultSeedance20(parameters.model):defaultVideo(),...parameters,workflow:parameters?.draft_request_id?'final':parameters?.draft?'draft':'generate',web_search:parameters?.tools?.some(t=>t?.type==='web_search')}); }
  catch { return {model:VIDEO_MODEL,prompt:String(parameters?.prompt || '').slice(0,32000)}; }
}
export function restoreVideoHistory(entry) {
  const body=cleanVideoHistory(entry?.parameters);
  return {...body.model===FLUX3?defaultFlux3():body.model===WAN30?defaultWan30():isMinimaxH3(body.model)?defaultMinimaxH3(body.model):body.model===OMNI_FLASH?defaultOmniFlash():body.model===SEEDANCE25?defaultSeedance25():isSeedance20(body.model)?defaultSeedance20(body.model):defaultVideo(),...body,workflow:body.draft_request_id?'final':body.draft?'draft':'generate',prompt:body.prompt || entry?.prompt || '',seed:body.seed ?? '',web_search:Boolean(body.tools?.length)};
}

export function appendVideoReference(items,item) {
  if(item.kind!=='image')return [...items,item];
  const occupied=new Set(items.filter(i=>i.kind==='image').map(i=>i.role));
  const role=item.role || ['first_frame','last_frame'].find(r=>!occupied.has(r));
  return [...items,{...item,role}];
}

export function setVideoFrameRole(items,id,role) {
  if(!['','first_frame','last_frame','reference_image'].includes(role))throw new Error('请选择首帧、尾帧或参考图。');
  const target=items.find(i=>i.id===id && i.kind==='image');
  if(!target)return items;
  const previousRole=target.role || '';
  return items.map(i=>i.id===id?{...i,role}:['first_frame','last_frame'].includes(role) && i.kind==='image' && i.role===role?{...i,role:previousRole===role?(role==='first_frame'?'last_frame':'first_frame'):previousRole}:i);
}

export function videoReferenceInput(items,imageMode,model=VIDEO_MODEL,parameters={}) {
  const newer=model===SEEDANCE25;
  const refs=items.map(item=>{
    if (!item.reference || item.state!=='ready') throw new Error('请等待全部素材校验完成，或移除失败素材。');
    const r=item.reference;
    return { ...r, ...(r.kind==='image' && imageMode==='unified' ? {role:item.role || undefined} : r.kind==='image' && imageMode==='frames' ? {role:item.role || (newer?'reference_image':'first_frame')} : r.kind==='image' && imageMode==='portrait' ? {role:'reference_image'} : {}) };
  });
  const images=refs.filter(r=>r.kind==='image'),videos=refs.filter(r=>r.kind==='video'),audios=refs.filter(r=>r.kind==='audio');
  if(model===FLUX3){validateFluxReferences(refs,parameters);return refs.map(r=>({receipt:r.receipt}));}
  if(model===WAN30){validateWanReferences(refs,parameters);return refs.map(r=>({receipt:r.receipt,...r.role?{role:r.role}:{}}));}
  if(isMinimaxH3(model)){validateH3References(refs,model);return refs.map(r=>({receipt:r.receipt,...r.role?{role:r.role}:{}}));}
  if(model===OMNI_FLASH){validateOmniReferences(refs,parameters);return refs.map(r=>({receipt:r.receipt,...r.role?{role:r.role}:{}}));}
  if(newer && videos.length){
    const kind=parameters.omni_reference_task_type || 'auto';
    if(kind==='auto')throw new Error('已添加视频，请明确选择参考素材创作、视频编辑或视频延长；自动判断可能将固定时长任务识别为编辑而失败。');
    if(kind==='edit' && (Number(parameters.duration)!==-1 || parameters.size!=='adaptive'))throw new Error('视频编辑须使用自动时长和自适应画幅，输出时长跟随源视频。');
    if(kind==='edit' && videos.some(r=>r.duration_ms<4000 || r.duration_ms>30000))throw new Error('待编辑视频须为 4–30 秒。');
    if(kind==='extend' && parameters.size!=='adaptive')throw new Error('视频延长须使用自适应画幅。');
  }
  if(newer && ['edit','extend'].includes(parameters.omni_reference_task_type) && !videos.length)throw new Error('视频编辑或延长至少需要一段视频。');
  for (const image of images) if (!image.asset_url) validateVideoImageDimensions(image.width,image.height);
  if (images.length>(newer?30:9) || videos.length>(newer?10:3) || audios.length>(newer?10:3)) throw new Error(newer?'2.5 最多 30 张图片、10 段视频、10 段音频。':'最多 9 张图片、3 段视频、3 段音频。');
  if (new Set(refs.map(r=>r.asset_url || r.id)).size!==refs.length) throw new Error('同一素材不能重复添加。');
  const frameRoles=images.map(r=>r.role).filter(r=>r==='first_frame' || r==='last_frame');
  if (imageMode==='unified' && frameRoles.length && (new Set(frameRoles).size!==frameRoles.length || !newer && (videos.length || audios.length || images.length!==frameRoles.length))) throw new Error('2.0 系列的首尾帧不能混用普通参考图、视频或音频；请调整图片角色或更换模型，素材会保留。');
  if (!newer && imageMode==='unified' && images.some(r=>r.role==='reference_image' && !r.asset_url)) throw new Error('2.0 系列的人像参考需使用已审核素材；普通图片可直接选“普通参考”。');
  if (!newer && imageMode==='unified' && images.some(r=>r.role) && images.some(r=>!r.role)) throw new Error('2.0 系列的人像角色不能与普通参考图片混用，请统一图片角色或更换模型，素材会保留。');
  if (imageMode==='frames' && (newer?new Set(frameRoles).size!==frameRoles.length:videos.length || audios.length || images.length>2 || new Set(images.map(r=>r.role)).size!==images.length)) throw new Error('首尾帧模式仅支持首帧、尾帧各一张图片，请调整现有素材。');
  if (!newer && imageMode==='portrait' && images.some(r=>!r.asset_url)) throw new Error('人像参考图需先完成素材审核，再从已审核素材中选择。');
  const videoMs=videos.reduce((n,r)=>n+r.duration_ms,0),audioMs=audios.reduce((n,r)=>n+r.duration_ms,0);
  for(const ref of [...videos,...audios]) validateVideoReferenceDuration(ref.duration_ms/1000,model);
  if (videos.length && (!Number.isInteger(videoMs) || (newer?videoMs>30000:videoMs<=1800 || videoMs>=15200))) throw new Error(newer?'2.5 参考视频总时长最多 30 秒。':'参考视频总时长须大于 1.8 秒、小于 15.2 秒。');
  if (audios.length && (!Number.isInteger(audioMs) || audioMs>(newer?30000:15000))) throw new Error(newer?'2.5 参考音频总时长最多 30 秒。':'参考音频总时长最多 15 秒。');
  if (!newer && audios.length && !images.length && !videos.length) throw new Error('参考音频须搭配图片或视频。');
  return refs.map(r=>({...r.asset_url?{asset_url:r.asset_url}:{receipt:r.receipt},...(r.role?{role:r.role}:{})}));
}

export function videoQuote(values,references=[],source) {
  if(values.model===FLUX3)return flux3Quote(values,references,source);
  if(values.model===WAN30)return wan30Quote(values,references);
  if(isMinimaxH3(values.model))return minimaxH3Quote(values,references);
  if(values.model===OMNI_FLASH)return omniFlashQuote(values);
  if(isSeedance20(values.model))return seedance20Quote(values,references);
  if(values.model===SEEDANCE25)return seedance25Quote(values,references,source);
  const body=buildVideoParameters(values);
  const referenceMs=references.filter(r=>r.kind==='video').reduce((n,r)=>n+(r.duration_ms || 0),0);
  if (!Number.isInteger(referenceMs)) throw new Error('素材时长尚未校验。');
  const units=(body.duration*1000+referenceMs)*(body.resolution==='480p'?5:10);
  return {units,text:creditText(units/10000),referenceSeconds:referenceMs/1000,generatedSeconds:body.duration};
}

export function videoFile(file,model=VIDEO_MODEL) {
  const ext=String(file?.name || '').split('.').at(-1).toLowerCase();
  const kind=['png','jpg','jpeg','webp',...isMinimaxH3(model)?['heic','heif']:model===WAN30?['bmp']:[]].includes(ext)?'image':['mp4','mov'].includes(ext)?'video':['mp3','wav'].includes(ext)?'audio':model===WAN30&&WAN_DOCUMENTS.includes(ext)?'document':'';
  const limit=(model===WAN30?{image:20,audio:15,video:100,document:100}:isMinimaxH3(model)?{image:30,audio:15,video:50}:{image:16,audio:20,video:50})[kind];
  if(model===FLUX3&&(kind==='audio'||kind==='video'&&ext!=='mp4'))throw new Error('FLUX 仅支持图片或 MP4，不支持独立音频。');
  if(model===OMNI_FLASH && kind==='audio')throw new Error('Omni 不支持参考音频，请添加图片或视频。');
  if (!kind || !file.size || file.size>limit*1024*1024) throw new Error(model===WAN30?'Wan 支持 JPG/PNG/BMP/WebP 图片 20 MB、MP3/WAV 15 MB、MP4/MOV 和参考文档 100 MB 以内的素材。':isMinimaxH3(model)?'H3 支持 JPG/PNG/WebP/HEIC/HEIF 图片 30 MB、MP3/WAV 15 MB、MP4/MOV 50 MB 以内的素材。':'支持图片 16 MB、MP3/WAV 20 MB、MP4/MOV 50 MB 以内的素材（本站限制）。');
  return kind;
}

export async function videoApi(path,{body,mode='platform',key='',model=VIDEO_MODEL,endpoint='',queryTemplate='',authHeaders={},signal}={}) {
  const controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) controller.abort();
  const timer=setTimeout(abort,90000);
  try {
    const response=await fetch('/api/video'+path,{method:body?'POST':'GET',credentials:'include',signal:controller.signal,
      headers:{...authHeaders,'X-Billing-Mode':mode,'X-Video-Model':model,...mode==='own_key'?{'X-Video-Api-Key':key,'X-Video-Endpoint':endpoint,'X-Video-Query-Template':queryTemplate}:{},...body?{'Content-Type':'application/json'}:{}},...body?{body:JSON.stringify(body)}:{}});
    let data;
    try { data=await response.json(); } catch { throw new Error('视频响应暂未确认，请查询原任务，勿重复提交。'); }
    if (!response.ok || data.error) {
      const error=new Error(data.error || '视频请求暂未完成。');
      Object.assign(error,{code:data.code,status:response.status,...typeof data.submission_unknown==='boolean'?{submission_unknown:data.submission_unknown}:{}});throw error;
    }
    return data;
  } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort); }
}

export async function uploadVideoReference(file,options,signal) {
  const kind=videoFile(file,options?.model);
  if (kind==='image' && !(isMinimaxH3(options?.model) && /\.hei[cf]$/i.test(file.name))) {
    let bitmap;
    try { bitmap=await createImageBitmap(file); }
    catch { throw new Error('图片无法解码，请使用有效的 PNG、JPG 或 WebP 图片。'); }
    try { if(options?.model===WAN30)validateWanDimensions(bitmap.width,bitmap.height);else if(isMinimaxH3(options?.model))validateH3Dimensions(bitmap.width,bitmap.height);else if([OMNI_FLASH,FLUX3].includes(options?.model)){if(bitmap.width*bitmap.height>32000000)throw new Error('图片超出本站 3200 万像素限制。');}else validateVideoImageDimensions(bitmap.width,bitmap.height); }
    finally { bitmap?.close(); }
  } else if(['video','audio'].includes(kind)) {
    const duration=await videoMediaDuration(file,kind,signal);
    validateVideoReferenceDuration(duration,options?.model || VIDEO_MODEL);
  }
  if(signal?.aborted) throw new DOMException('素材上传已取消','AbortError');
  const issued=await videoApi('/references/uploads',{...options,signal,body:{filename:file.name,size:file.size,content_type:file.type || ''}});
  const url=new URL(issued.signed_url);
  if (url.protocol!=='https:' || url.username || url.password || !url.pathname.startsWith('/storage/v1/object/upload/sign/')) throw new Error('素材上传地址无效。');
  const response=await fetch(url,{method:'PUT',body:file,headers:{'Content-Type':issued.content_type},credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal});
  if (!response.ok) throw new Error('素材上传失败，请移除后重新添加。');
  const data=await videoApi('/references/complete',{...options,signal,body:{upload_ticket:issued.upload_ticket}});
  return data.reference;
}

export function validateVideoImageDimensions(width,height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<300 || width>6000 || height<300 || height>6000) throw new Error(`参考图片的宽和高均须为 300–6000 像素；当前为 ${width} × ${height}，请调整尺寸后重新上传。`);
  if (width/height<0.4 || width/height>2.5) throw new Error(`参考图片宽高比须为 0.4–2.5；当前为 ${width} × ${height}，请调整比例后重新上传。`);
}

export function validateVideoReferenceDuration(seconds,model=VIDEO_MODEL) {
  if(model===FLUX3){if(!Number.isFinite(seconds)||seconds<=0||seconds>30)throw new Error('FLUX 续写素材本站暂限 30 秒。');return;}
  if(model===WAN30){if(!Number.isFinite(seconds)||seconds<1||seconds>15)throw new Error('Wan 视频或音频每段须为 1–15 秒。');return;}
  if(model===OMNI_FLASH){if(!Number.isFinite(seconds)||seconds<=0||seconds>10)throw new Error('Omni 参考视频最多 10 秒，请截短后重新添加。');return;}
  const maximum=model===SEEDANCE25?30:15;
  if (!Number.isFinite(seconds) || seconds<2 || seconds>maximum) throw new Error(`${isMinimaxH3(model)?'H3':model===SEEDANCE25?'2.5':isSeedance20(model)?'2.0 / Fast':'Mini'} 参考视频或音频每段须为 2–${maximum} 秒；当前 ${Number.isFinite(seconds)?Number(seconds.toFixed(3)):'未知'} 秒，请调整后重新添加。`);
}

function videoMediaDuration(file,kind,signal) {
  return new Promise((resolve,reject)=>{
    const media=document.createElement(kind==='video'?'video':'audio'),url=URL.createObjectURL(file);
    let timer,settled=false;
    const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);media.onloadedmetadata=null;media.onerror=null;const seconds=media.duration;media.removeAttribute('src');media.load();URL.revokeObjectURL(url);if(error)reject(error);else resolve(seconds);};
    const abort=()=>done(new DOMException('素材读取已取消','AbortError'));
    media.preload='metadata';media.onloadedmetadata=()=>done();media.onerror=()=>done(new Error('无法读取音频或视频时长，请使用有效素材。'));
    signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>done(new Error('读取素材时长超时，请重新添加。')),15000);
    if(signal?.aborted){abort();return;}media.src=url;
  });
}

export const videoShouldPoll=job=>Boolean(job?.provider_task_id) && (['submitted','pending','processing','unknown'].includes(job.status) || job.billing_status==='awaiting_balance');
