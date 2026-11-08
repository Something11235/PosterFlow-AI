import {FLUX3,defaultFlux3,moveFluxFrame} from '../../lib/flux3';
import Flux3Controls,{Flux3Workflow} from './Flux3Controls';
import {WAN30,defaultWan30} from '../../lib/wan30';
import { MINIMAX_H3, MINIMAX_H3_MAX, isMinimaxH3, defaultMinimaxH3 } from '../../lib/minimaxH3';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Film, LoaderCircle, Paperclip, Plus, RefreshCw, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import { setVideoFrameRole, buildVideoParameters, uploadVideoReference, videoApi, videoFile, videoQuote, videoReferenceInput, videoShouldPoll, videoStatus } from '../../lib/video';
import { VIDEO_MODELS } from '../../lib/studioCatalog';
import ModelPicker from '../ModelPicker';
import { mergeVideoJobs as merge, videoJobTitle, videoSubmissionFailure } from '../../lib/videoJobs';
import { defaultVideo } from '../../lib/video';
import { SEEDANCE25, defaultSeedance25, seedance25DraftAvailable, seedance25AutoVideo, seedance25EffectiveValues } from '../../lib/seedance25';
import { SEEDANCE20, SEEDANCE20_FAST, isSeedance20, defaultSeedance20 } from '../../lib/seedance20';
import { creditText } from '../../lib/credits';
import { remapVideoMentions,videoMentionError,videoMentions } from '../../lib/videoMentions';
import VideoPromptEditor from './VideoPromptEditor';
import VideoGenerationControls from './VideoGenerationControls';
import { OMNI_FLASH, defaultOmniFlash } from '../../lib/omniFlash';
import OmniFlashControls, { OmniTaskControls } from './OmniFlashControls';
import './video.css';

function Field({label,children,hint}) { return <label className="studio-field"><span>{label}</span>{React.cloneElement(children,{'aria-label':label})}{hint && <small>{hint}</small>}</label>; }
function Check({label,value,onChange}) { return <label className="music-check"><input type="checkbox" checked={value} onChange={e=>onChange(e.target.checked)} />{label}</label>; }

export default function VideoWorkspace({active,identity,authHeaders,session,account,onLogin,onAccountRefresh,values,onChange,onTaskActivity}) {
  const [mode,setMode]=useState('platform'),[key,setKey]=useState(''),[config,setConfig]=useState(null);
  const [keyInput,setKeyInput]=useState(''),[endpoint,setEndpoint]=useState(''),[queryTemplate,setQueryTemplate]=useState('');
  const [endpointInput,setEndpointInput]=useState(endpoint),[queryInput,setQueryInput]=useState(''),[configNotice,setConfigNotice]=useState('');
  const [items,setItems]=useState([]),[assets,setAssets]=useState([]);
  const previousItems=useRef({scope:'',items:[]});
  const [jobs,setJobs]=useState([]),[selected,setSelected]=useState(''),[results,setResults]=useState({});
  const [message,setMessage]=useState(''),[busy,setBusy]=useState(false),[querying,setQuerying]=useState(false);
  const [url,setUrl]=useState(''),[filename,setFilename]=useState(''),[revision,setRevision]=useState(0);
  const filesRef=useRef(null),pending=useRef(new Map()),uploads=useRef(new Map()),queryRef=useRef(null),lastQueried=useRef(new Map());
  const scope=`${identity}:${mode}:${key}:${endpoint}:${queryTemplate}`,scopeRef=useRef(scope),jobsRef=useRef(jobs);jobsRef.current=jobs;
  const options=useMemo(()=>({mode,key,model:values.model,endpoint,queryTemplate,authHeaders}),[mode,key,values.model,endpoint,queryTemplate,authHeaders]);
  const newer=values.model===SEEDANCE25,flux=values.model===FLUX3,final=(newer||flux) && values.workflow==='final';
  const omni=values.model===OMNI_FLASH,h3=isMinimaxH3(values.model),h3Max=values.model===MINIMAX_H3_MAX,wan=values.model===WAN30;
  const standard=isSeedance20(values.model),costBased=newer || standard || omni || h3 || wan || flux;
  const customService=mode==='own_key' && (endpoint!=='https://api.apimart.ai/v1/videos/generations' || Boolean(queryTemplate));
  const forms=useRef({'seedance-2.0-mini':defaultVideo(),[SEEDANCE25]:defaultSeedance25(),[SEEDANCE20]:defaultSeedance20(),[SEEDANCE20_FAST]:defaultSeedance20(SEEDANCE20_FAST),[OMNI_FLASH]:defaultOmniFlash(),[MINIMAX_H3]:defaultMinimaxH3(),[MINIMAX_H3_MAX]:defaultMinimaxH3(MINIMAX_H3_MAX),[WAN30]:defaultWan30(),[FLUX3]:defaultFlux3()});
  const omniSources=jobs.filter(j=>j.model===OMNI_FLASH && j.status==='completed' && ['settled','not_applicable'].includes(j.billing_status));
  const source=jobs.find(j=>j.request_id===values.draft_request_id);
  const fluxDrafts=jobs.filter(j=>j.model===FLUX3&&j.is_draft&&j.status==='completed'&&['settled','not_applicable'].includes(j.billing_status));
  const drafts=jobs.filter(j=>seedance25DraftAvailable(j));
  const current=jobs.find(j=>j.request_id===selected),result=results[selected];
  const hasJobs=jobs.length>0;
  const activeCount=jobs.filter(j=>j.operation==='generate' && !['completed','failed','not_submitted'].includes(j.status)).length;
  const uploading=items.some(i=>i.state==='uploading');
  const canUse=Boolean(session && account?.email_verified && account.profile?.status==='active');
  const update=patch=>onChange(previous=>({...previous,...patch}));
  const mixedMedia=items.some(i=>['video','audio'].includes(i.kind));
  const hasVideo=items.some(i=>i.kind==='video');
  const autoVideo=seedance25AutoVideo(values,hasVideo),effectiveValues=seedance25EffectiveValues(values,hasVideo);
  const mentionLabels=new Map(videoMentions(items).map(i=>[i.id,newer||wan?i.token:i.token.slice(1)]));
  const hasFrames=items.some(i=>i.kind==='image' && ['first_frame','last_frame'].includes(i.role));
  const ratioReason=final?'正式片画幅继承样片。':autoVideo?'带视频的自动判断使用自适应画幅，兼容参考创作、编辑与延长。':newer && ['edit','extend'].includes(values.omni_reference_task_type)?'视频编辑与延长需要自适应画幅。':wan && hasFrames?'Wan 首尾帧画幅跟随上传图片，使用自适应。':h3 && hasFrames?'H3 首尾帧画幅跟随上传图片，使用自适应。':newer && hasFrames && !mixedMedia?'首尾帧画幅跟随上传图片，使用自适应。':'';
  useEffect(()=>{if(ratioReason && !final && !autoVideo && values.size!=='adaptive')onChange(v=>({...v,size:'adaptive'}));},[ratioReason,final,autoVideo,values.size,onChange]);
  useEffect(()=>{
    const before=previousItems.current;previousItems.current={scope,items};
    if((newer||wan) && before.scope===scope && before.items!==items){const prompt=remapVideoMentions(values.prompt,before.items,items);if(prompt!==values.prompt)onChange(v=>({...v,prompt:remapVideoMentions(v.prompt,before.items,items)}));}
  },[items,scope,newer,wan,values.prompt,onChange]);
  let quote,validation='';
  try {quote=videoQuote(effectiveValues,final?[]:items.map(i=>i.reference).filter(Boolean),source);if(h3)buildVideoParameters(effectiveValues);if(!final){videoReferenceInput(items,'unified',values.model,effectiveValues);if(newer||wan)validation=videoMentionError(values.prompt,items);}} catch(error) {validation=error.message;}
  useEffect(()=>{onTaskActivity?.(activeCount);},[activeCount,onTaskActivity]);
  useEffect(()=>()=>onTaskActivity?.(0),[onTaskActivity]);

  useEffect(()=>{
    scopeRef.current=scope;setItems([]);setAssets([]);setJobs([]);setSelected('');setResults({});setMessage('');setBusy(false);setQuerying(false);setUrl('');setFilename('');
    lastQueried.current.clear();
    const pendingJobs=pending.current,pendingUploads=uploads.current;
    return ()=>{
      for (const c of pendingJobs.values()) c.abort();pendingJobs.clear();queryRef.current?.abort();queryRef.current=null;
      for (const r of pendingUploads.values()) {r.controller.abort();clearTimeout(r.timer);if(r.url)URL.revokeObjectURL(r.url);}pendingUploads.clear();
    };
  },[scope]);
  useEffect(()=>{
    if(!active)return;
    const c=new AbortController();videoApi('/config',{signal:c.signal}).then(d=>{if(!c.signal.aborted)setConfig(d);}).catch(e=>{if(!c.signal.aborted)setMessage(e.message);});return()=>c.abort();
  },[active]);
  useEffect(()=>{
    if(!active || !canUse || !config?.database_configured || (mode==='platform'?!config.platform_configured:!key))return;
    const c=new AbortController();
    Promise.allSettled([videoApi('/tasks',{...options,signal:c.signal}),videoApi('/assets',{...options,signal:c.signal})]).then(([j,a])=>{
      if(c.signal.aborted)return;
      if(j.status==='fulfilled'){setJobs(p=>merge(p,j.value.jobs));setSelected(p=>p || j.value.jobs[0]?.request_id || '');}else setMessage(j.reason.message);
      if(a.status==='fulfilled')setAssets(a.value.assets);else setMessage(a.reason.message);
    });return()=>c.abort();
  },[active,canUse,config,mode,key,options,revision]);

  const refresh=useCallback(async rid=>{
    if(!rid || queryRef.current)return;
    const c=new AbortController();queryRef.current=c;setQuerying(true);lastQueried.current.set(rid,Date.now());
    try {
      const d=await videoApi('/tasks/'+encodeURIComponent(rid),{...options,signal:c.signal});
      if(c.signal.aborted)return;
      setJobs(p=>merge(p,[d.job]));setResults(p=>({...p,[rid]:d}));
      if(d.warning)setMessage(d.warning);
      if(d.job.operation==='asset_review' && d.job.status==='completed')setAssets(p=>[...new Map([...p,...(d.job.asset_results || [])].map(a=>[a.asset_url,a])).values()]);
      if(d.credit_balance!=null)onAccountRefresh();
    }catch(e){if(!c.signal.aborted)setResults(p=>({...p,[rid]:{...p[rid],queryError:e.message}}));}
    finally{if(queryRef.current===c){queryRef.current=null;setQuerying(false);}}
  },[options,onAccountRefresh]);
  useEffect(()=>{
    if(!hasJobs)return;
    let stopped=false,timer;
    const tick=async()=>{
      if(stopped)return;
      if(document.visibilityState==='visible'){
        const target=jobsRef.current.filter(videoShouldPoll).sort((a,b)=>(lastQueried.current.get(a.request_id)||0)-(lastQueried.current.get(b.request_id)||0))[0];
        if(target)await refresh(target.request_id);
      }
      if(!stopped)timer=setTimeout(tick,5000);
    };timer=setTimeout(tick,1500);
    return()=>{stopped=true;clearTimeout(timer);queryRef.current?.abort();};
  },[hasJobs,refresh]);
  useEffect(()=>{if(active && current?.provider_task_id && !results[selected])refresh(selected);},[active,current?.provider_task_id,selected,results,refresh]);

  function readyToAdd(){
    if(!canUse){setMessage('请先登录并完成邮箱验证后添加素材。');if(!session)onLogin();return false;}
    if(!config?.references_configured || (mode==='platform'?!config.platform_configured:!key)){setMessage('请先配置视频服务。');return false;}return true;
  }
  async function add(files) {
    if(!readyToAdd())return;
    const started=scope;
    for(const file of Array.from(files || [])){
      let kind;try{kind=videoFile(file,values.model);}catch(e){setMessage(e.message);continue;}
      if(uploads.current.size>=(flux?10:wan?21:omni?11:newer?50:15)){setMessage(flux?'FLUX 最多 10 张关键帧或 1 段 MP4。':wan?'Wan 最多保留 21 份素材。':omni?'Omni 最多 10 张图片和 1 段视频。':newer?'本次最多保留 50 份素材。':'本次最多保留 15 份素材。');break;}
      const id=crypto.randomUUID(),controller=new AbortController(),localUrl=URL.createObjectURL(file);
      const timer=setTimeout(()=>controller.abort(),180000);uploads.current.set(id,{controller,url:localUrl,timer});
      setItems(p=>[...p,{id,name:file.name,kind,url:localUrl,state:'uploading'}]);
      uploadVideoReference(file,options,controller.signal).then(reference=>{
        if(started===scopeRef.current && !controller.signal.aborted && uploads.current.has(id))setItems(p=>p.map(i=>i.id===id?{...i,state:'ready',reference}:i));
      }).catch(e=>{if(started===scopeRef.current && uploads.current.has(id))setItems(p=>p.map(i=>i.id===id?{...i,state:'failed',error:controller.signal.aborted?'素材上传超时，请移除后重试。':e.message}:i));}).finally(()=>clearTimeout(timer));
    }
  }
  async function importUrl(source=url,name=filename,imageRole='') {
    if(!readyToAdd())return;
    const id=crypto.randomUUID(),controller=new AbortController(),started=scope;
    const timer=setTimeout(()=>controller.abort(),180000);uploads.current.set(id,{controller,timer});
    setItems(p=>[...p,{id,name:name || '链接素材',state:'uploading'}]);
    try {
      const data=await videoApi('/references/import-url',{...options,signal:controller.signal,body:{url:source,filename:name}});
      if(started===scopeRef.current && !controller.signal.aborted && uploads.current.has(id)){
        setItems(p=>{const next=p.map(i=>i.id===id?{...i,kind:data.reference.kind,state:'ready',reference:data.reference}:i);return imageRole&&data.reference.kind==='image'?setVideoFrameRole(next,id,imageRole):next;});setUrl('');setFilename('');
      }
    }catch(e){if(started===scopeRef.current && uploads.current.has(id))setItems(p=>p.map(i=>i.id===id?{...i,state:'failed',error:e.message}:i));}
    finally{clearTimeout(timer);}
  }
  function remove(id){const r=uploads.current.get(id);if(r){r.controller.abort();clearTimeout(r.timer);if(r.url)URL.revokeObjectURL(r.url);uploads.current.delete(id);}setItems(p=>p.filter(i=>i.id!==id));}
  function addApprovedAsset(a){setItems(p=>p.some(i=>i.reference?.asset_url===a.asset_url)?p:[...p,{id:crypto.randomUUID(),name:`已审核${{image:'图片',video:'视频',audio:'音频'}[a.kind]}`,kind:a.kind,state:'ready',reference:a}]);}

  async function submit(reference) {
    if(!canUse){setMessage('请先登录并完成邮箱验证。');if(!session)onLogin();return;}
    if(busy)return;
    let parameters,refs;
    try {
      parameters=reference?{}:buildVideoParameters(effectiveValues);refs=reference?[{receipt:reference.receipt}]:final?[]:videoReferenceInput(items,'unified',values.model,effectiveValues);
      if(!reference && !final && (newer||wan)){const issue=videoMentionError(parameters.prompt,items);if(issue)throw new Error(issue);}
      if(!reference && !final && !parameters.prompt && !refs.length && !parameters.continue_request_id && !parameters.link_url)throw new Error('文生视频需要提示词，也可以先添加参考素材。');
      if(!reference && activeCount>=3)throw new Error('最多同时处理 3 个视频生成任务。');
    }catch(e){setMessage(e.message);return;}
    const rid=crypto.randomUUID(),controller=new AbortController(),started=scope;
    const placeholder={request_id:rid,billing_mode:mode,operation:reference?'asset_review':'generate',status:'submitting',local_attempt:true,
      model:values.model,resolution:parameters.resolution,is_draft:parameters.draft===true,requested_duration:parameters.duration,
      created_at:new Date().toISOString(),estimated_credits:quote?.text || '0'};
    pending.current.set(rid,controller);setJobs(p=>merge(p,[placeholder]));setSelected(rid);setBusy(true);setMessage('');
    try {
      const data=await videoApi(reference?'/assets/reviews':'/generations',{...options,signal:controller.signal,body:{request_id:rid,parameters,references:refs}});
      if(controller.signal.aborted || started!==scopeRef.current)return;
      setJobs(p=>merge(p,[data.job]));onAccountRefresh();
    }catch(e){
      if(controller.signal.aborted || started!==scopeRef.current)return;
      const failed=videoSubmissionFailure(placeholder,e),unknown=failed.status==='submission_unknown';
      setJobs(p=>merge(p,[failed]));
      setMessage(`${e.message} 请求编号：${rid}${unknown?'。请保留编号，勿重复提交。':''}`);onAccountRefresh();setRevision(p=>p+1);
    }finally{pending.current.delete(rid);if(started===scopeRef.current)setBusy(false);}
  }

  return <div className="studio-page music-workspace video-workspace" hidden={!active}>
    <div className="studio-page-title"><div><p className="studio-eyebrow">{flux?'VIDEO / FLUX 3':wan?'VIDEO / WAN 3.0':h3Max?'VIDEO / MINIMAX H3 MAX':h3?'VIDEO / MINIMAX H3':omni?'VIDEO / GEMINI OMNI':'VIDEO / SEEDANCE'}</p><h1>用分镜，讲属于自己的故事。</h1><p>{flux?'文字、有序关键帧或视频续写，创作 5–20 秒 HD / FHD 短片，也可先做草稿再转正式片。':wan?'从文字、首尾帧、音视频、文档或网页开始，创作 2–30 秒有声或静音视频。':h3Max?'文字、首尾帧或多模态参考，快速创作 5–15 秒、最高 1080P 的有声短片。':h3?'文字、首尾帧或多模态参考，创作 4–15 秒、最高 2K 的有声短片。':omni?'从文字、图片或视频开始，创作约 3–10 秒有声短片，也可编辑或续写已有视频。':newer?'文字、多模态参考、视频编辑与延长，最长 30 秒。':'从文字、首尾帧或多种参考素材开始，创作 4–15 秒短片。'}</p></div><span className="studio-outline-badge">{VIDEO_MODELS.find(m=>m.id===values.model)?.name || values.model}</span></div>
    <div className="music-layout">
      <section className="music-editor" aria-label="视频创作设置"><header className="studio-panel-heading"><span><Film size={18} />创作设置</span><small>01 / CREATE</small></header><div className="studio-form-body">
        <div className="studio-segments">{[['platform','平台积分'],['own_key','自带 API Key']].map(([id,label])=><button key={id} type="button" aria-pressed={mode===id} onClick={()=>setMode(id)}>{label}</button>)}</div>
        {mode==='own_key'?<div className="music-key-box"><Field label="视频 API Key" hint="配置仅在当前页面内存中使用，刷新或切换账户后清空。"><input type="password" value={keyInput} autoComplete="off" onChange={e=>{setKeyInput(e.target.value);setConfigNotice('');}} /></Field><Field label="视频生成接口地址" hint="填写完整 HTTPS 地址，需兼容当前模型的异步视频生成协议。"><input type="url" value={endpointInput} onChange={e=>{setEndpointInput(e.target.value);setConfigNotice('');}} spellCheck={false} /></Field><Field label="任务查询地址（可选）" hint="用 {task_id} 表示任务编号，留空按生成接口推导；生成与查询须使用同一域名。"><input value={queryInput} onChange={e=>{setQueryInput(e.target.value);setConfigNotice('');}} spellCheck={false} placeholder="填写任务查询地址模板，使用 {task_id} 表示任务编号" /></Field><button type="button" className="studio-secondary" onClick={()=>{try{const url=new URL(endpointInput.trim());if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !keyInput.trim())throw new Error('请填写 API Key 和有效的完整 HTTPS 接口地址。');setKey(keyInput.trim());setEndpoint(endpointInput.trim());setQueryTemplate(queryInput.trim());setConfigNotice('视频服务配置已应用，仅当前页面有效。');}catch{setConfigNotice("请填写 API Key 和有效的完整 HTTPS 接口地址。");}}}>应用视频服务配置</button>{configNotice && <p className="music-reference-note" role="status">{configNotice}</p>}</div>:<div className="music-service-note"><span>网站积分<strong>{account?.credits?.balance!=null?creditText(account.credits.balance):'—'}</strong></span><p>{costBased?<>先预留积分，成功后按实际用量结算，最终扣分以 0.5 积分为档，多退少补。{flux?'普通生成与视频续写使用不同秒价，只按请求生成秒数预估；草稿转正式片再次按正式价格收费，草稿费用不抵扣。':wan?'只按参考视频时长加生成时长计费；图片、参考音频、文档和网页不增加计费时长，关闭声音也不改变单价。':h3Max?'参考视频按独立秒价计费；前 2 张参考图免费，超过部分按张计费；参考音频免费。':h3?'参考视频时长计费；前 5 张参考图免费，超过部分按张计费；参考音频不另计时长。':omni?'图片、视频和提示词的输入用量均可能影响最终费用。':'参考音频与图片不额外计算时长。'}</>:'480P 每秒 0.5 积分，720P 每秒 1 积分。只计算参考视频总时长与生成时长，图片和音频不增加时长。'}</p>{config && !config.platform_configured && <p>平台视频服务尚未配置。</p>}</div>}
        <section className="video-composer" aria-label="视频创作编辑器">
        <section className="video-model-settings video-composer-card" aria-label="模型与创作方式"><h2 className="video-section-title"><Settings2 size={18} aria-hidden="true" />模型与创作方式</h2><div className="video-model-fields"><Field label="视频模型"><ModelPicker value={values.model} onChange={model=>{forms.current[values.model]={...values};onChange({...forms.current[model]});}} options={VIDEO_MODELS.filter(m=>m.available).map(m=>({value:m.id,label:m.name}))}/></Field>
        {newer && <><Field label="制作流程"><select value={values.workflow || 'generate'} onChange={e=>update({workflow:e.target.value,resolution:e.target.value==='final'?'1080p':e.target.value==='draft'?'480p':values.resolution,draft_request_id:''})}><option value="generate">直接生成</option><option value="draft">先生成 480P 样片</option><option value="final">用样片生成 1080P 正式片</option></select></Field>{final?<Field label="选择已完成样片" hint="样片自创建起 3 天内有效；正式片单独计费，并沿用原参考视频输入时长，样片成片本身不计入输入。"><select value={values.draft_request_id || ''} onChange={e=>update({draft_request_id:e.target.value})}><option value="">请选择本人已完成并结算的样片</option>{drafts.map(d=><option key={d.request_id} value={d.request_id}>{new Date(d.created_at).toLocaleString('zh-CN',{hour12:false})} · {d.requested_duration===-1?'自动时长':d.requested_duration+' 秒'}</option>)}</select></Field>:<Field label="视频创作方式" hint="自动判断由模型根据素材与描述决定。参考创作借用动作、运镜或风格生成新片；视频编辑修改原片的人物、字幕或物体，时长跟随原片。"><select value={values.omni_reference_task_type || 'auto'} onChange={e=>update({omni_reference_task_type:e.target.value,...['edit','extend'].includes(e.target.value)?{size:'adaptive'}:{},...e.target.value==='edit'?{duration:-1}:{}})}><option value="auto">自动判断 · 根据素材与描述</option><option value="reference">参考素材创作 · 借用动作、运镜或风格生成新片</option><option value="edit">视频编辑 · 修改原片的人物、字幕或物体</option><option value="extend">视频延长 · 向前或向后续写</option></select></Field>}</>}
        {flux && <Flux3Workflow values={values} onChange={update} drafts={fluxDrafts} />}
        {omni && <OmniTaskControls values={values} onChange={update} jobs={omniSources} />}
        </div></section>
        {!final && <>
          <VideoPromptEditor value={values.prompt} onChange={prompt=>update({prompt})} items={items} mentionsEnabled={newer||wan} maximum={wan?20000:h3?7000:standard?4000:32000} />
          <section className="video-references video-composer-card" aria-label="视频参考素材">
            <div className="music-reference-heading"><h2 className="video-section-title"><Paperclip size={18} aria-hidden="true" />参考素材 <small>{items.length} / {flux?10:wan?21:omni?11:newer?50:15}</small></h2><button type="button" className="studio-secondary" onClick={()=>readyToAdd() && filesRef.current?.click()}><Plus size={15} />添加素材</button><input ref={filesRef} hidden type="file" multiple accept={flux?'.png,.jpg,.jpeg,.webp,.mp4':wan?".png,.jpg,.jpeg,.bmp,.webp,.mp4,.mov,.mp3,.wav,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.key,.pages,.numbers":h3?".png,.jpg,.jpeg,.webp,.heic,.heif,.mp4,.mov,.mp3,.wav":omni?".png,.jpg,.jpeg,.webp,.mp4,.mov":".png,.jpg,.jpeg,.webp,.mp4,.mov,.mp3,.wav"} onChange={e=>{add(e.target.files);e.target.value='';}} /></div>
            {!items.length && <button type="button" className="music-reference-empty" onClick={()=>readyToAdd() && filesRef.current?.click()}><Plus size={24} /><span>{flux?'添加关键帧图片，或一段 MP4 视频用于续写。':omni?'添加图片或视频；图片可指定首帧、尾帧或普通参考。':'添加图片、视频或音频；图片上传后可直接指定首帧、尾帧。'}</span></button>}
            <p className="music-reference-note">{flux?'图片按列表顺序播放：1 张为首帧，2 张为首尾帧，3–10 张的中间帧均匀分布。使用前移、后移调整顺序；续写视频不能混用关键帧。':wan?'Wan 图片宽高 240–8000 像素；视频 240–4096 像素；长短边比例最多 8:1。首帧必选、尾帧可选，首尾帧不能与其他参考素材混用。':h3?'H3 图片与视频宽高 256–5760 像素、比例 0.4–2.5；首尾帧各最多一张，不能混用普通参考图、视频或音频。':omni?'最多 10 张图片和 1 段不超过 10 秒的视频，不支持参考音频。尾帧须搭配首帧；首尾帧建议使用相同比例并与所选画幅一致。':<>参考图片宽高均须为 300–6000 像素，宽高比 0.4–2.5。{newer?'每段视频或音频须为 2–30 秒。':'2.0 系列每段视频或音频须为 2–15 秒。'}不符合要求的素材会在提交生成前拦截。</>}</p>
            {!omni && !h3 && !wan && !flux && <p className="music-reference-note">含真人脸的素材请先点击“审核为可复用素材”，通过后从已审核素材中添加使用；直接上传生成可能被审核拒绝。</p>}
            <div className="music-reference-list">{items.map(i=><article key={i.id} className="music-reference-card"><div><strong>{mentionLabels.get(i.id) || (i.kind==='document'?'参考文档':'读取中')} · {i.name}</strong><button type="button" aria-label={`移除素材 ${i.name}`} onClick={()=>remove(i.id)}><Trash2 size={16} /></button></div>
              {i.url && (i.kind==='document'?<p className="music-reference-note">参考文档{i.reference?.pages?` · ${i.reference.pages} 页`:''}</p>:i.kind==='image'?/\.hei[cf]$/i.test(i.name)?<p className="music-reference-note">HEIC / HEIF 已上传；当前浏览器可能无法显示预览。</p>:<img alt={i.name} src={i.url} className="video-reference-image" />:i.kind==='video'?<video src={i.url} controls preload="metadata" />:<audio src={i.url} controls preload="metadata" />)}
              {i.state==='ready'?<><p>{i.reference.asset_url?'审核通过 · 可复用':'已校验 · 临时保留 12 小时'}{i.reference.duration_ms?` · ${i.reference.duration_ms/1000} 秒`:''}</p>
                {flux&&i.kind==='image'&&<div className="music-inline-actions"><strong>{items.indexOf(i)===0?'首帧':items.indexOf(i)===items.length-1?'尾帧':`中间帧 ${items.indexOf(i)}`}</strong><button type="button" className="studio-secondary" aria-label={`前移 ${i.name}`} disabled={items.indexOf(i)===0} onClick={()=>setItems(p=>moveFluxFrame(p,i.id,-1))}>前移</button><button type="button" className="studio-secondary" aria-label={`后移 ${i.name}`} disabled={items.indexOf(i)===items.length-1} onClick={()=>setItems(p=>moveFluxFrame(p,i.id,1))}>后移</button>{i.role&&<button type="button" className="studio-secondary" onClick={()=>setItems(p=>p.map(r=>r.id===i.id?{...r,role:''}:r))}>清除旧模型角色</button>}</div>}
                {!flux && i.kind==='image' && <Field label={`素材 ${i.name} 的图片角色`}><select value={i.role || ''} onChange={e=>setItems(p=>setVideoFrameRole(p,i.id,e.target.value))}><option value="">普通参考 · 主体、风格或场景</option><option value="first_frame">首帧 · 视频开始画面</option><option value="last_frame">尾帧 · 视频结束画面</option>{!omni && !h3 && !wan && !flux && !newer && i.reference.asset_url && <option value="reference_image">人像参考 · 已审核素材</option>}</select></Field>}
                {!omni && !h3 && !wan && !flux && !i.reference.asset_url && !customService && <button type="button" className="studio-text-button video-review-button" disabled={busy} onClick={()=>submit(i.reference)}><ShieldCheck size={14} />审核为可复用素材 · 不扣网站积分</button>}
              </>:<p className={i.state==='failed'?'music-reference-error':''}>{i.state==='uploading'?'正在上传并校验素材…':i.error}</p>}
            </article>)}</div>
            {newer && hasFrames && mixedMedia && <p className="music-config-note">同时参考视频或音频时，首尾帧图片会作为普通参考，不固定开头或结尾。</p>}
            <details className="music-advanced"><summary>{omni||h3||wan||flux?'链接导入':<>链接导入与已审核素材（{assets.length}）</>}</summary><div className="music-advanced-body"><Field label="素材链接"><input type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="填写 HTTPS 素材链接" /></Field><Field label="素材文件名" hint="请带扩展名，例如 scene.mp4。"><input value={filename} onChange={e=>setFilename(e.target.value)} /></Field><button type="button" className="studio-secondary" disabled={!url || !filename || uploading} onClick={()=>importUrl()}>读取并校验素材</button>{!omni && !h3 && !wan && !flux && (assets.length?assets.map(a=><button key={a.asset_url} type="button" className="studio-secondary" onClick={()=>addApprovedAsset(a)}>添加已审核{({image:'图片',video:'视频',audio:'音频'})[a.kind]}<Plus size={14} /></button>):<p className="music-reference-note">素材审核通过后，可在这里添加复用。</p>)}</div></details>
            <p className="music-reference-note">{flux?'最多 10 张 JPG/PNG/WebP 有序关键帧，或 1 段 MP4；本站暂限图片 16 MB、视频 50 MB / 30 秒和 3200 万像素。不支持独立音频或手动指定关键帧时间。':wan?'最多 10 图 / 5 视频 / 5 音频 / 1 文档。图片 JPG/PNG（无透明通道）/BMP/WebP，20 MB；视频 MP4/MOV，100 MB；音频 MP3/WAV，15 MB。音视频每段 1–15 秒，两类各自合计最多 15 秒；参考视频加生成时长不超过 30 秒。文档最多 100 MB、50 页；复杂格式的最终页数以服务解析为准。':h3?'最多 9 图 / 3 视频 / 3 音频。JPG/PNG/WebP/HEIC/HEIF 图片 30 MB、MP4/MOV 视频 50 MB、MP3/WAV 音频 15 MB。视频为 H.264/H.265、23.976–60 FPS；视频、音频每段 2–15 秒，两类各自合计最多 15 秒。音频须搭配普通参考图片或视频。':omni?'图片 16 MB、视频 50 MB 以内（本站限制），图片最多 3200 万像素；只发送本型号支持的素材参数，不使用 Seedance 审核素材。':newer?'最多 30 图 / 10 视频 / 10 音频，总计 50 份；支持纯音频参考。视频和音频每段 2–30 秒，各自合计最多 30 秒。视频 480P–1080P、24–60 FPS；图片 16 MB、视频 50 MB、音频 15 MB。':'最多 9 图 / 3 视频 / 3 音频；音频须搭配图片或视频。视频合计大于 1.8 秒、小于 15.2 秒，480P–720P；音频合计最多 15 秒。图片 16 MB、视频 50 MB、音频 20 MB。'}</p>
            {validation && <p role="status" className="music-reference-error">{validation}</p>}
          </section>
        </>}
        {wan && <section className="video-composer-card"><Field label="参考网页（可选）" hint="填写无需登录的公开 HTTPS 网页；不能与文档或首尾帧混用。网页地址不保存到提示词历史。"><input type="url" value={values.link_url || ''} onChange={e=>update({link_url:e.target.value})} /></Field></section>}
        {flux?<Flux3Controls values={values} onChange={update} final={final} source={source}/>:omni?<OmniFlashControls values={values} onChange={update} />:<VideoGenerationControls values={effectiveValues} onChange={update} newer={newer} final={final} source={source} ratioReason={ratioReason} autoVideo={autoVideo} />}
        </section>
        {wan && <details className="music-advanced"><summary>更多创作选项</summary><div className="music-advanced-body"><Field label="随机种子" hint="留空随机；同种子不保证结果完全一致。"><input type="number" min={0} max={2147483647} step="1" value={values.seed} onChange={e=>update({seed:e.target.value})} /></Field><Check label="生成声音" value={values.audio} onChange={v=>update({audio:v})} /><Check label="添加 AI 生成水印" value={values.watermark} onChange={v=>update({watermark:v})} /><Check label="内容预检查" value={values.nsfw_check} onChange={v=>update({nsfw_check:v})} /><p className="music-reference-note">关闭声音不改变价格；开启内容预检查可能增加费用，计入最终用量。</p></div></details>}
        {h3 && <details className="music-advanced"><summary>更多创作选项</summary><div className="music-advanced-body">{h3Max && values.resolution==='1080p'?<p className="music-reference-note">1080P 不提供水印选项。</p>:<Check label="添加 AI 生成水印" value={Boolean(values.watermark)} onChange={v=>update({watermark:v})} />}{!h3Max && <Check label="内容预检查" value={Boolean(values.nsfw_check)} onChange={v=>update({nsfw_check:v})} />}<p className="music-reference-note">H3 原生生成声音，可在提示词中描述对白、音效与配乐。{!h3Max && '开启内容预检查可能增加费用，计入最终实际用量。'}</p></div></details>}
        {!omni && !h3 && !wan && !flux && <details className="music-advanced"><summary>更多创作选项</summary><div className="music-advanced-body">
          {!final && <Field label="随机种子" hint="留空随机；相同种子可生成相似结果，不保证完全一致。"><input type="number" min={-1} max={2147483647} step="1" value={values.seed} onChange={e=>update({seed:e.target.value})} /></Field>}
          {!final && <Check label="生成声音" value={values.generate_audio} onChange={v=>update({generate_audio:v})} />}
          <Check label="返回尾帧 · 用于衔接下一段视频" value={values.return_last_frame} onChange={v=>update({return_last_frame:v})} />
          {!final && <Check label="联网搜索 · 辅助理解时效信息" value={values.web_search} onChange={v=>update({web_search:v})} />}
          {!final && <Check label="内容预检查 · 提示词与图片" value={values.nsfw_check} onChange={v=>update({nsfw_check:v})} />}
          {newer && <><Field label="视频输出格式"><select value={values.output_format || 'mp4'} onChange={e=>update({output_format:e.target.value})}><option value="mp4">MP4</option><option value="mov">MOV · 适合编辑与延长</option></select></Field><Check label="添加 AI 生成水印" value={Boolean(values.watermark)} onChange={v=>update({watermark:v})} /></>}
          <p className="music-reference-note">预检查不覆盖视频与音频，预检查服务不可用时仍可能继续提交；最终以生成服务审核为准。</p>
        </div></details>}
        <div className="music-service-note"><span>本次预估<strong>{mode==='own_key'?'0':quote?.text || '—'} 积分</strong></span><p>{costBased?`预计约 ${quote?.text || '—'} 积分，提交先预留 ${quote?.reservedText || '—'} 积分，完成按实际用量核算，多退少补。${flux?'续写按独立秒价预估；正式片费用不抵扣草稿费用。':wan?(Number(values.duration)===-1?'自动时长按最多 30 秒总计费时长预估，完成按实际费用结算。':'预估按参考视频时长与生成时长之和计算。'):h3Max?'预估分别计算生成时长、参考视频时长及超过 2 张的参考图费用；最终按实际费用结算。':h3?'预估包含参考视频时长及超过 5 张的参考图费用；最终按实际费用结算。':omni?'预估基于最多 10 秒输出，参考素材和提示词的输入用量也会计入实际费用。':newer?(final?`正式片预估包含原参考视频 ${quote?.referenceSeconds ?? 0} 秒与${source?.requested_duration===-1?'最多 30 秒':`${source?.requested_duration || 0} 秒`}输出，不计入样片成片时长。`:Number(effectiveValues.duration)===-1?'自动时长按最多 30 秒输出加参考视频输入预留。':'预估包含参考视频输入与生成时长。'):''}`:`参考视频 ${quote?.referenceSeconds || 0} 秒 ＋ 生成 ${values.duration} 秒。`}平台先预留，成功扣除，明确失败退回；提交结果未知时保留原任务核对。{omni||h3||wan||flux?'自带 Key 由对应服务计费。':'素材审核不扣网站积分，自带 Key 由对应服务计费。'}</p></div>
        {autoVideo && <p role="status" className="music-reference-note">自动模式：由模型判断参考创作、视频编辑或延长。当前使用自动时长和自适应画幅，按最多 30 秒输出加参考视频输入预留积分；若判为编辑，成片时长跟随原视频。需要固定时长时，可切换参考素材创作或视频延长。</p>}
        {message && <p role="status" className="music-query-error">{message}</p>}
      </div><footer className="music-submit studio-form-footer"><button type="button" className="studio-primary" disabled={busy || uploading || Boolean(validation) || (mode==='platform'?!config?.platform_configured:!key)} onClick={()=>submit()}>{busy?<LoaderCircle size={17} className="music-spin" />:<Film size={17} />}生成视频 · {mode==='own_key'?'0':quote?.text || '—'} 积分</button></footer></section>
      <section className="music-output" aria-label="我的视频任务"><header className="studio-panel-heading"><span><Film size={18} />我的视频任务</span><button type="button" onClick={()=>setRevision(p=>p+1)}><RefreshCw size={15} />刷新列表</button></header><p className="music-retention-note">{newer||h3||wan||flux?'视频链接有效期以返回结果为准，请及时下载备份。':'生成视频临时保留约 72 小时，请及时下载。'}提示词保留 7 天；上传参考素材临时保留 12 小时。可同时提交最多 3 个视频任务。</p>
        {jobs.length?<><div className="music-task-tabs">{jobs.map(j=><button key={j.request_id} type="button" aria-pressed={selected===j.request_id} onClick={()=>setSelected(j.request_id)}><strong>{videoJobTitle(j,VIDEO_MODELS)}</strong><span>{videoStatus[j.status] || '状态待确认'}</span><small>{new Date(j.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</small></button>)}</div>{current && <div className="music-task-detail"><div className="music-task-status"><strong>{videoStatus[current.status] || '状态待确认'}</strong><button type="button" disabled={querying || current.status==='submitting'} className="studio-secondary" onClick={()=>refresh(selected)}><RefreshCw size={15} />刷新状态</button></div><p className="music-task-id">请求编号：{selected}</p>{current.provider_task_id && <p className="music-task-id">服务任务：{current.provider_task_id}</p>}
          {videoShouldPoll(current) && <><progress max="100" value={result?.progress || 0} aria-label="视频任务进度" /><p className="music-waiting">处理中 {result?.progress || 0}% · 可以继续提交其他任务或切换到音乐、图像创作。</p></>}
          {result?.queryError && <p role="alert" className="music-query-error">{result.queryError}</p>}
          {current.status==='submission_unknown' && <p className="music-query-error">{current.failure_reason && <>{current.failure_reason} </>}提交结果待确认，请刷新原请求核对；没有查到记录也不要重复生成，请保留原请求编号联系站主。</p>}
          {current.status==='not_submitted' && <p className="music-query-error">{current.failure_reason} {current.submission_phase==='validation'?'本次在提交校验时被拦截，尚未创建生成任务，也未预留网站积分。':'本次未进入上游生成，请按提示处理。'}</p>}
          {current.local_attempt && current.error_code && <p className="music-task-id">错误代码：{current.error_code}</p>}
          {current.status==='failed' && <p className="music-query-error">{result?.failure_reason || current.failure_reason || '任务未完成，请保留任务编号核对。'}{current.billing_status==='refunded'?' 预留的网站积分已退回。':''}</p>}
          {current.status==='completed' && current.billing_status!=='awaiting_balance' && <p className="music-settled">{current.operation==='asset_review'?'素材审核通过，可在已审核素材中选用。':`已完成 · 本次使用 ${creditText(current.charged_credits || 0)} 积分`}</p>}
          {result?.warning && <p className="music-query-error">{result.warning}</p>}
          {current.model===OMNI_FLASH && current.status==='completed' && ['settled','not_applicable'].includes(current.billing_status) && <button type="button" className="studio-primary" onClick={()=>{forms.current[values.model]={...values};onChange({...defaultOmniFlash(),task:'extend',continue_request_id:current.request_id});}}>继续编辑或续写此视频 · 单独计费</button>}
          {current.is_draft && current.status==='completed' && ['settled','not_applicable'].includes(current.billing_status) && <button type="button" className="studio-primary" onClick={()=>onChange({...current.model===FLUX3?defaultFlux3():defaultSeedance25(),workflow:'final',resolution:current.model===FLUX3?'fhd':'1080p',draft_request_id:current.request_id})}>用此样片生成正式片 · 单独计费</button>}
          {(result?.videos || []).map((v,i)=><article key={v.url} className="video-result"><video src={v.url} controls playsInline preload="none" aria-label={`生成视频 ${i+1}`} /><div className="music-inline-actions"><a href={v.url} download target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">下载视频<ArrowUpRight size={14} /></a><a href={v.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">备用下载</a></div><p className="music-reference-note">若网络不佳或下载失败，请点击“备用下载”后保存视频。</p>{v.last_frame_url && <div className="video-tail"><img src={v.last_frame_url} alt="生成视频尾帧" loading="lazy" /><div className="music-inline-actions"><a href={v.last_frame_url} download target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">下载尾帧</a><button type="button" className="studio-secondary" onClick={()=>importUrl(v.last_frame_url,'last-frame.png','first_frame')}>用作下一段首帧</button></div></div>}</article>)}
        </div>}</>:<div className="music-empty"><span className="music-empty-icon"><Film size={42} /></span><p className="studio-eyebrow">YOUR NEXT SCENE</p><h2>一段故事，从这里开始。</h2><p>设置镜头与素材，生成后在这里预览与下载。</p></div>}
      </section>
    </div>
  </div>;
}
