export const MINIMAX_H3 = 'MiniMax-H3';
export const MINIMAX_H3_MAX = 'MiniMax-H3-Max';
export const isMinimaxH3 = model => [MINIMAX_H3,MINIMAX_H3_MAX].includes(model);
export const defaultMinimaxH3 = (model=MINIMAX_H3) => ({model,prompt:'',resolution:model===MINIMAX_H3_MAX?'768p':'2k',duration:5,size:'16:9',watermark:false,...model===MINIMAX_H3?{nsfw_check:false}:{}});
const ratios=['21:9','16:9','4:3','1:1','3:4','9:16','adaptive'];
export function buildMinimaxH3(values) {
  const maximum=values.model===MINIMAX_H3_MAX;
  const prompt=String(values.prompt || '').trim(),duration=Number(values.duration);
  if(!prompt || Array.from(prompt).length>7000)throw new Error('H3 的所有创作方式都需要填写提示词，最多 7000 个字符。');
  if(!Number.isInteger(duration)||duration<(maximum?5:4)||duration>15||!(maximum?['480p','768p','1080p']:['768p','2k']).includes(values.resolution)||!ratios.includes(values.size))throw new Error(maximum?'H3 Max 支持 480P / 768P / 1080P、5–15 秒及列表中的画幅。':'H3 支持 768P / 2K、4–15 秒及列表中的画幅。');
  return {model:maximum?MINIMAX_H3_MAX:MINIMAX_H3,prompt,duration,resolution:values.resolution,size:values.size,...!maximum||values.resolution!=='1080p'?{watermark:Boolean(values.watermark)}:{},...maximum?{}:{nsfw_check:Boolean(values.nsfw_check)}};
}
export function validateH3Dimensions(width,height) {
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<256||height<256||width>5760||height>5760||width/height<0.4||width/height>2.5)throw new Error('H3 图片和视频宽高须为 256–5760 像素，宽高比须为 0.4–2.5。');
}
export function validateH3References(refs,model=MINIMAX_H3) {
  const limits={image:30,video:50,audio:15},images=refs.filter(r=>r.kind==='image'),videos=refs.filter(r=>r.kind==='video'),audios=refs.filter(r=>r.kind==='audio');
  if(images.length+videos.length+audios.length!==refs.length||images.length>9||videos.length>3||audios.length>3)throw new Error('H3 最多 9 张参考图、3 段视频和 3 段音频。');
  if(new Set(refs.map(r=>r.id)).size!==refs.length)throw new Error('同一素材不能重复添加。');
  for(const r of refs){
    if(r.asset_url)throw new Error('H3 不支持 Seedance 审核素材，请直接上传或链接导入。');
    if(!Number.isInteger(r.size)||r.size<=0||r.size>limits[r.kind]*1024*1024)throw new Error('H3 图片最多 30 MB、视频 50 MB、音频 15 MB，请重新上传不符合要求的素材。');
    if(r.role && (r.kind!=='image'||!['first_frame','last_frame','reference_image'].includes(r.role)))throw new Error('H3 图片角色无效。');
    if(r.kind!=='audio')validateH3Dimensions(r.width,r.height);
  }
  const frames=images.filter(r=>['first_frame','last_frame'].includes(r.role));
  if(frames.length && (frames.length!==refs.length||new Set(frames.map(r=>r.role)).size!==frames.length))throw new Error('H3 首尾帧各最多一张，不能与普通参考图、视频或音频混用。');
  if(audios.length&&!images.length&&!videos.length)throw new Error('H3 参考音频须搭配普通参考图片或视频。');
  for(const group of [videos,audios])if(group.some(r=>!Number.isInteger(r.duration_ms)||r.duration_ms<2000||r.duration_ms>15000)||group.reduce((s,r)=>s+r.duration_ms,0)>15000)throw new Error('H3 视频和音频每段须为 2–15 秒，两类素材各自合计最多 15 秒。');
  if(videos.some(r=>!Number.isFinite(r.fps)||r.fps<23.976||r.fps>60||!['avc1','avc3','hvc1','hev1'].includes(r.codec)||model!==MINIMAX_H3_MAX&&(!Array.isArray(r.audio_codecs)||(r.audio_codecs || []).some(c=>!['mp4a','.mp3','mp3 ','mp3'].includes(c)))))throw new Error(model===MINIMAX_H3_MAX?'H3 Max 参考视频须为 H.264 / H.265、23.976–60 FPS。':'H3 参考视频须为 H.264 / H.265、23.976–60 FPS，音轨仅支持 AAC / MP3。');
}
export function minimaxH3Quote(values,refs=[],verified=true) {
  // Integer nanodollars keep half-credit rounding exact, even with millisecond inputs.
  const body=buildMinimaxH3({...values,prompt:values.prompt || '费用预估'});
  if(verified)validateH3References(refs,values.model);
  const referenceMs=refs.filter(r=>r.kind==='video').reduce((s,r)=>s+r.duration_ms,0);
  const maximum=body.model===MINIMAX_H3_MAX;
  const extraImages=Math.max(0,refs.filter(r=>r.kind==='image').length-(maximum?2:5));
  const generationRate=(maximum?{'480p':37680,'768p':57120,'1080p':128000}:{'768p':57120,'2k':91440})[body.resolution];
  const referenceRate=maximum?{'480p':42320,'768p':110880,'1080p':119360}[body.resolution]:generationRate;
  const nanoUsd=BigInt(body.duration*1000)*BigInt(generationRate)+BigInt(referenceMs)*BigInt(referenceRate)+BigInt(extraImages)*BigInt(maximum?57120000:22880000);
  const ceil=(a,b)=>(a+b-1n)/b;
  const halves=Number(ceil(nanoUsd*840n,19000000000n)),reserved=Number(ceil(nanoUsd*840n*8n,19000000000n*5n));
  return {units:halves*5000,text:String(halves/2),reservedUnits:reserved*5000,reservedText:String(reserved/2),referenceSeconds:referenceMs/1000,generatedSeconds:body.duration,extraImages};
}
