export const SEEDANCE25='seedance-2.5';
export const SEEDANCE25_DRAFT_TTL_MS=3*86400000;
export function seedance25DraftAvailable(source,now=Date.now()){
  const created=Date.parse(source?.created_at);
  return Boolean(source?.model===SEEDANCE25 && source.is_draft===true && source.status==='completed' && ['settled','not_applicable'].includes(source.billing_status) && /^[A-Za-z0-9_-]{8,160}$/.test(source.provider_task_id || '') && Number.isFinite(created) && created>now-SEEDANCE25_DRAFT_TTL_MS && Number.isInteger(source.requested_duration) && (source.requested_duration===-1 || source.requested_duration>=4 && source.requested_duration<=30) && Number.isInteger(source.reference_duration_ms) && source.reference_duration_ms>=0 && source.reference_duration_ms<=30000);
}
export const defaultSeedance25=()=>({model:SEEDANCE25,workflow:'generate',prompt:'',resolution:'480p',duration:5,size:'adaptive',seed:'',generate_audio:true,return_last_frame:false,web_search:false,nsfw_check:false,watermark:false,output_format:'mp4',omni_reference_task_type:'auto',draft_request_id:''});

export function buildSeedance25(values){
  const final=values.workflow ? values.workflow==='final' : Boolean(values.draft_request_id);
  const output=values.output_format || 'mp4';
  if(!['mp4','mov'].includes(output))throw new Error('请选择 MP4 或 MOV 输出。');
  const body={model:SEEDANCE25,output_format:output,watermark:Boolean(values.watermark),return_last_frame:Boolean(values.return_last_frame)};
  if(final){
    if(!/^[a-f0-9-]{36}$/.test(values.draft_request_id || ''))throw new Error('请选择本人的已完成样片。');
    return {...body,resolution:'1080p',draft_request_id:values.draft_request_id};
  }
  const prompt=String(values.prompt || '').trim(),duration=Number(values.duration),kind=values.omni_reference_task_type || 'auto';
  const size=values.size || 'adaptive',res=values.resolution || '480p',draft=values.workflow ? values.workflow==='draft' : values.draft===true;
  if(!prompt || Array.from(prompt).length>32000)throw new Error('请填写创作描述，最多 32000 个字符（本站限制）。');
  if(!['480p','720p','1080p'].includes(res) || (draft && res!=='480p'))throw new Error('2.5 支持 480P / 720P / 1080P；样片固定 480P。');
  if(!Number.isInteger(duration) || !(duration===-1 || duration>=4 && duration<=30))throw new Error('请选择 4–30 秒或自动时长。');
  if(!['auto','reference','edit','extend'].includes(kind))throw new Error('请选择有效的创作方式。');
  if(['edit','extend'].includes(kind) && size!=='adaptive')throw new Error('视频编辑、延长须使用自适应画幅。');
  if(kind==='edit' && duration!==-1)throw new Error('视频编辑须选择自动时长，成片时长跟随源视频。');
  Object.assign(body,{prompt,duration,resolution:res,size,draft,omni_reference_task_type:kind,generate_audio:Boolean(values.generate_audio),nsfw_check:Boolean(values.nsfw_check)});
  if(values.seed!=='' && values.seed!=null){const seed=Number(values.seed);if(!Number.isInteger(seed) || seed< -1 || seed>2147483647)throw new Error('请输入有效随机种子。');body.seed=seed;}
  if(values.web_search)body.tools=[{type:'web_search'}];
  return body;
}

export function seedance25Quote(values,references=[],source){
  const final=values.workflow?values.workflow==='final':Boolean(values.draft_request_id);
  if(final&&!seedance25DraftAvailable(source))throw new Error('请选择创建未满 3 天、本人已完成并结算的 Seedance 2.5 样片。');
  const requested=final?source?.requested_duration:Number(values.duration);
  if(!Number.isInteger(requested))throw new Error('请选择已完成的样片。');
  const seconds=requested===-1?30:requested;
  const refMs=final?source.reference_duration_ms:references.filter(r=>r.kind==='video').reduce((n,r)=>n+(r.duration_ms || 0),0);
  const rates={"480p":[96080,57600],"720p":[216000,129600],"1080p":[534600,319200]};
  const rate=rates[final?'1080p':values.resolution]?.[refMs?1:0];
  if(!rate)throw new Error('请选择有效的清晰度。');
  const nanoUsd=(seconds*1000+refMs)*rate;
  const halves=Math.ceil(nanoUsd*1680/(38*1e9)),reserveHalves=Math.ceil(nanoUsd*1680*16/(38*1e9*10));
  return {units:halves*5000,text:String(halves/2),reservedUnits:reserveHalves*5000,reservedText:String(reserveHalves/2),referenceSeconds:refMs/1000,generatedSeconds:seconds};
}
