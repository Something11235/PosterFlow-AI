export const FLUX3='flux-3-video';
export const FLUX_RATIOS=['auto','21:9','2:1','16:9','4:3','1:1','3:4','9:16'];
export const defaultFlux3=()=>({model:FLUX3,prompt:'',resolution:'hd',duration:5,aspect_ratio:'auto',audio:true,safety_tolerance:2,nsfw_check:false,workflow:'generate',draft_request_id:''});
export function buildFlux3(v){
  if(!['hd','fhd'].includes(v.resolution))throw new Error('FLUX 支持 HD / FHD。');
  if(v.workflow==='final'){
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v.draft_request_id || ''))throw new Error('请选择本人已完成并结算的 FLUX 草稿。');
    return {model:FLUX3,resolution:v.resolution,draft_request_id:v.draft_request_id};
  }
  const duration=Number(v.duration),safety=Number(v.safety_tolerance),prompt=String(v.prompt || '').trim();
  if(!Number.isInteger(duration)||duration<5||duration>20||!FLUX_RATIOS.includes(v.aspect_ratio)||!Number.isInteger(safety)||safety<0||safety>4||Array.from(prompt).length>32000)throw new Error('FLUX 支持 5–20 秒整数、列表中的画幅及 0–4 的审核容忍度；提示词本站限 32000 字符。');
  const draft=v.workflow==='draft'||Boolean(v.draft);
  if(draft&&v.resolution!=='hd')throw new Error('FLUX 草稿仅支持 HD。');
  return {model:FLUX3,prompt,resolution:v.resolution,duration,aspect_ratio:v.aspect_ratio,audio:Boolean(v.audio),draft,safety_tolerance:safety,nsfw_check:Boolean(v.nsfw_check)};
}
export function validateFluxReferences(refs,values={},requireContent=true){
  const images=refs.filter(r=>r.kind==='image'),videos=refs.filter(r=>r.kind==='video');
  if(refs.length>10||videos.length>1||images.length&&videos.length||images.length+videos.length!==refs.length)throw new Error('FLUX 支持最多 10 张有序关键帧，或 1 段 MP4；不支持参考音频及图视频混用。');
  if(values.draft_request_id&&refs.length)throw new Error('正式片继承草稿素材，不能重新上传素材。');
  for(const r of refs){if(r.asset_url||r.role)throw new Error('FLUX 按图片列表顺序确定关键帧，请清除其他模型的图片角色。');if(!Number.isInteger(r.size)||r.size<1||r.size>(r.kind==='image'?16:50)*1024*1024)throw new Error('本站限制图片 16 MB、视频 50 MB。');if(!Number.isInteger(r.width)||!Number.isInteger(r.height)||Math.min(r.width,r.height)<1||r.width*r.height>32000000)throw new Error('素材无法识别或超过本站 3200 万像素限制。');if(r.kind==='video'&&(!r.id?.toLowerCase().endsWith('.mp4')||!Number.isInteger(r.duration_ms)||r.duration_ms<1||r.duration_ms>30000))throw new Error('续写素材须为 MP4；本站暂限 30 秒、50 MB。');}
  if(requireContent&&!values.draft_request_id&&!values.prompt?.trim())throw new Error('FLUX 文生、图生及视频续写均需要提示词。');
}
export function flux3Quote(values,refs=[],source,verified=true){
  const body=buildFlux3(values);if(verified)validateFluxReferences(refs,body,false);
  if(body.draft_request_id&&(!source||source.model!==FLUX3||!source.is_draft||source.status!=='completed'||!['settled','not_applicable'].includes(source.billing_status)))throw new Error('请选择本人已完成并结算的 FLUX 草稿。');
  const seconds=body.draft_request_id?source.requested_duration:body.duration;
  const continuation=body.draft_request_id?source.pricing_profile?.continuation===true:refs.some(r=>r.kind==='video');
  const variant=(continuation?'v2v-':'')+(body.draft?'draft':body.resolution);
  const nano=BigInt(seconds)*BigInt({draft:48000000,'v2v-draft':96000000,hd:136000000,fhd:232000000,'v2v-hd':328000000,'v2v-fhd':424000000}[variant]);
  const ceil=(a,b)=>(a+b-1n)/b,half=Number(ceil(nano*840n,19000000000n)),reserve=Number(ceil(nano*840n*8n,95000000000n));
  return {units:half*5000,text:String(half/2),reservedUnits:reserve*5000,reservedText:String(reserve/2),generatedSeconds:seconds,referenceSeconds:0};
}
export function moveFluxFrame(items,id,delta){const index=items.findIndex(i=>i.id===id),next=index+delta;if(index<0||next<0||next>=items.length)return items;const result=[...items];[result[index],result[next]]=[result[next],result[index]];return result;}
