export const WAN30='wan3.0-video';
export const WAN_DOCUMENTS=['docx','doc','xlsx','xls','pptx','ppt','pdf','txt','key','pages','numbers','md'];
export const defaultWan30=()=>({model:WAN30,prompt:'',resolution:'1080p',size:'adaptive',duration:5,audio:true,watermark:false,nsfw_check:false,seed:'',link_url:''});
export function buildWan30(values){
  const prompt=String(values.prompt || '').trim(),duration=Number(values.duration);
  if(Array.from(prompt).length>20000)throw new Error('Wan 提示词最多 20000 个字符。');
  if(!['480p','720p','1080p'].includes(values.resolution)||!['adaptive','16:9','4:3','1:1','3:4','9:16'].includes(values.size)||!Number.isInteger(duration)||duration!==-1&&(duration<2||duration>30))throw new Error('Wan 支持 480P / 720P / 1080P、2–30 秒或自动时长和列表中的画幅。');
  const body={model:WAN30,prompt,resolution:values.resolution,size:values.size,duration,audio:Boolean(values.audio),watermark:Boolean(values.watermark),nsfw_check:Boolean(values.nsfw_check)};
  const seed=String(values.seed ?? '').trim();
  if(seed){if(!/^\d+$/.test(seed)||!Number.isInteger(Number(seed))||Number(seed)>2147483647)throw new Error('Wan 随机种子须为 0–2147483647 的整数。');body.seed=Number(seed);}
  if(values.link_url){let url;try{url=new URL(String(values.link_url).trim());}catch{throw new Error('请填写可公开访问的 HTTPS 网页链接。');}if(url.protocol!=='https:'||url.username||url.password||!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal'))throw new Error('请填写可公开访问的 HTTPS 网页链接。');body.link_url=url.href;}
  return body;
}
export function validateWanDimensions(width,height,kind='image'){
  const maximum=kind==='image'?8000:4096;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<240||height<240||width>maximum||height>maximum||width/height<.125||width/height>8)throw new Error(`Wan ${kind==='image'?'图片':'视频'}宽高须为 240–${maximum} 像素，长边与短边之比不能超过 8:1。`);
}
export function validateWanReferences(refs,values={},requireContent=true){
  const limits={image:20,video:100,audio:15,document:100},counts={image:0,video:0,audio:0,document:0};
  for(const r of refs){if(!(r.kind in counts))throw new Error('Wan 素材类型无效。');counts[r.kind]++;if(r.asset_url)throw new Error('Wan 不支持 Seedance 审核素材，请重新上传。');if(!Number.isInteger(r.size)||r.size<1||r.size>limits[r.kind]*1024*1024)throw new Error('Wan 图片最多 20 MB、视频/文档 100 MB、音频 15 MB。');if(['image','video'].includes(r.kind))validateWanDimensions(r.width,r.height,r.kind);if(r.has_alpha)throw new Error('Wan 不支持带透明通道的 PNG。');if(r.pages!=null&&(!Number.isInteger(r.pages)||r.pages<1||r.pages>50))throw new Error('参考文档最多 50 页。');}
  if(counts.image>10||counts.video>5||counts.audio>5||counts.document>1||new Set(refs.map(r=>r.id)).size!==refs.length)throw new Error('Wan 最多 10 图 / 5 视频 / 5 音频 / 1 文档，同一素材不能重复添加。');
  const frames=refs.filter(r=>r.kind==='image'&&['first_frame','last_frame'].includes(r.role));
  if(frames.length&&(frames.length!==refs.length||values.link_url||!frames.some(r=>r.role==='first_frame')||new Set(frames.map(r=>r.role)).size!==frames.length))throw new Error('Wan 首帧必选、尾帧可选，各最多一张；不能与普通参考图、视频、音频、文档或网页混用。');
  if(counts.document&&values.link_url)throw new Error('文档与网页只能选择一种。');
  for(const kind of ['video','audio']){const group=refs.filter(r=>r.kind===kind);if(group.some(r=>!Number.isInteger(r.duration_ms)||r.duration_ms<1000||r.duration_ms>15000)||group.reduce((s,r)=>s+r.duration_ms,0)>15000)throw new Error('Wan 视频和音频每段 1–15 秒，两类各自合计最多 15 秒。');}
  const ms=refs.filter(r=>r.kind==='video').reduce((s,r)=>s+r.duration_ms,0);
  if(Number(values.duration)!==-1&&ms+Number(values.duration || 5)*1000>30000)throw new Error('参考视频总时长加生成时长不能超过 30 秒，请缩短时长。');
  if(requireContent&&!values.prompt?.trim()&&!refs.length&&!values.link_url)throw new Error('请填写提示词，或添加参考素材、文档或网页。');
  return ms;
}
export function wan30Quote(values,refs=[],verified=true){
  const body=buildWan30(values),ms=verified?validateWanReferences(refs,body,false):refs.filter(r=>r.kind==='video').reduce((s,r)=>s+r.duration_ms,0);
  const totalMs=body.duration===-1?30000:body.duration*1000+ms;
  const nanoUsd=BigInt(totalMs)*BigInt({'480p':32880,'720p':65750,'1080p':131500}[body.resolution]);
  const ceil=(a,b)=>(a+b-1n)/b;
  const halves=Number(ceil(nanoUsd*840n,19000000000n)),reserved=Number(ceil(nanoUsd*840n*8n,95000000000n));
  return {units:halves*5000,text:String(halves/2),reservedUnits:reserved*5000,reservedText:String(reserved/2),referenceSeconds:ms/1000,generatedSeconds:(totalMs-ms)/1000,automatic:body.duration===-1};
}
