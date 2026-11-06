export const OMNI_FLASH='gemini-omni-1.1-flash';
export const defaultOmniFlash=()=>({model:OMNI_FLASH,prompt:'',resolution:'720p',aspect_ratio:'16:9',task:'auto',continue_request_id:''});
export function buildOmniFlash(values){
  const prompt=String(values.prompt || '').trim(),resolution=values.resolution,aspect_ratio=values.aspect_ratio,task=values.task || 'auto';
  if(Array.from(prompt).length>32000)throw new Error('提示词最多 32000 个字符（本站限制）。');
  if(!['360p','720p','1080p','4k'].includes(resolution)||!['16:9','9:16'].includes(aspect_ratio)||!['auto','text_to_video','image_to_video','reference_to_video','edit','extend'].includes(task))throw new Error('请选择 Omni 支持的清晰度、横屏或竖屏和创作方式。');
  const body={model:OMNI_FLASH,prompt,resolution,aspect_ratio,task};
  if(values.continue_request_id){if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(values.continue_request_id))throw new Error('请选择本人已完成的 Omni 任务。');body.continue_request_id=values.continue_request_id;}
  return body;
}
export function omniFlashQuote(values){
  const body=buildOmniFlash(values),microUsd={'360p':296000,'720p':880000,'1080p':1320000,'4k':2640000}[body.resolution];
  const halves=Math.ceil(microUsd*1680/(38*1e6)),reserve=Math.ceil(microUsd*1680*16/(38*1e6*10));
  return {units:halves*5000,text:String(halves/2),reservedUnits:reserve*5000,reservedText:String(reserve/2),generatedSeconds:10};
}
export function validateOmniReferences(refs,values={}){
  const images=refs.filter(r=>r.kind==='image'),videos=refs.filter(r=>r.kind==='video');
  if(images.length+videos.length!==refs.length||images.length>10||videos.length>1)throw new Error('Omni 最多 10 张图片和 1 段视频，不支持参考音频。');
  if(refs.some(r=>r.asset_url))throw new Error('Omni 不支持 Seedance 审核素材，请重新上传图片或视频。');
  if(new Set(refs.map(r=>r.id)).size!==refs.length)throw new Error('同一素材不能重复添加。');
  const roles=images.map(r=>r.role).filter(Boolean);
  if(roles.some(r=>!['first_frame','last_frame'].includes(r))||new Set(roles).size!==roles.length||roles.includes('last_frame')&&!roles.includes('first_frame'))throw new Error('尾帧必须同时配有首帧，首帧和尾帧各一张。');
  if(videos.some(r=>!Number.isInteger(r.duration_ms)||r.duration_ms<=0||r.duration_ms>10000))throw new Error('Omni 参考视频最多 10 秒，请截短后重新添加。');
  for(const r of images)if(!Number.isInteger(r.width)||!Number.isInteger(r.height)||Math.min(r.width,r.height)<1||r.width*r.height>32000000)throw new Error('图片无法识别或超出本站 3200 万像素限制。');
  if(videos.some(r=>r.role))throw new Error('首尾帧角色仅用于图片。');
  const continued=Boolean(values.continue_request_id),task=values.task || 'auto';
  if(continued&&videos.length)throw new Error('继续已有任务和上传参考视频只能选择一种。');
  if(task==='text_to_video'&&(refs.length||continued))throw new Error('文生视频方式只使用提示词，请选择自动判断或其他创作方式。');
  if(['image_to_video','reference_to_video'].includes(task)&&!images.length)throw new Error('图像或参考创作需要添加图片。');
  if(['edit','extend'].includes(task)&&!videos.length&&!continued)throw new Error('编辑或续写需要上传一段视频，或选择本人已完成的 Omni 任务。');
  if('prompt' in values&&!String(values.prompt || '').trim()&&!refs.length&&!continued)throw new Error('请填写提示词或添加图片、视频素材。');
}
