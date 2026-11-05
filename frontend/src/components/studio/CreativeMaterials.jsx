import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,ImagePlus,Layers3,Plus,Sparkles,Trash2,Upload} from 'lucide-react';
import {AI_COMPANIONS,AI_COMPANION_IMAGE_COUNT} from '../../lib/aiCompanions';
import {addPersonalImages,createMaterialGroup,deletePersonalImage,personalMaterialFile,personalMaterials} from '../../lib/personalMaterials';
import StylePromptZone from './StylePromptZone';
import './materials.css';

export default function CreativeMaterials({identity,presetLibrary,onImportCompanion,onUseStylePrompt}){
  const [groupId,setGroupId]=useState(AI_COMPANIONS[0].id),[choices,setChoices]=useState({}),[busy,setBusy]=useState(''),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);
  const [personal,setPersonal]=useState({images:[],groups:[]}),[loading,setLoading]=useState(true),[newGroup,setNewGroup]=useState(false),[groupName,setGroupName]=useState(''),[preview,setPreview]=useState(null);
  const upload=useRef(null);
  const groups=[...AI_COMPANIONS,...personal.groups.map(g=>({...g,images:[]}))].map(g=>({...g,images:[...g.images,...personal.images.filter(i=>i.groupId===g.id)]}));
  const group=groups.find(g=>g.id===groupId) || groups[0],index=Math.min(choices[group.id] || 0,Math.max(0,group.images.length-1)),image=group.images[index];
  const previewUrl=image?.blob?(preview?.id===image.id?preview.url:''):image?.url;
  useEffect(()=>{let active=true;personalMaterials(identity).then(d=>{if(active)setPersonal(d);}).catch(e=>{if(active)setMessage(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[identity]);
  useEffect(()=>{if(!image?.blob)return;const url=URL.createObjectURL(image.blob);setPreview({id:image.id,url});return()=>URL.revokeObjectURL(url);},[image]);
  const select=index=>{setChoices(p=>({...p,[group.id]:index}));setMessage('');setFailed(false);};
  async function handleImport(target){
    if(busy || !image)return;setBusy(target);setMessage('');
    try{await onImportCompanion(image.blob?personalMaterialFile(image):image.id,target);setMessage(target==='reference'?'已加入图像创作参考图。':'已送入无限画布。');}catch(e){setMessage(e.message || '导入失败，请重试。');}finally{setBusy('');}
  }
  async function handleUpload(files){
    if(busy || !files.length)return;setBusy('upload');setMessage('');
    try{const result=await addPersonalImages(identity,group.id,files,AI_COMPANIONS.map(g=>g.id));setPersonal(await personalMaterials(identity));setChoices(p=>({...p,[group.id]:result.added.length?group.images.length:index}));setFailed(false);setMessage(`已保存 ${result.added.length} 张个人图片${result.duplicates?`，跳过 ${result.duplicates} 张重复图片`:''}。`);}catch(e){setMessage(e.message);}finally{setBusy('');}
  }
  async function handleCreate(e){
    e.preventDefault();if(busy)return;setBusy('group');setMessage('');
    try{const created=await createMaterialGroup(identity,groupName,AI_COMPANIONS.map(g=>g.name));setPersonal(await personalMaterials(identity));setGroupId(created.id);setNewGroup(false);setGroupName('');setFailed(false);setMessage('分类已创建，可以上传自己的图片。');}catch(e){setMessage(e.message);}finally{setBusy('');}
  }
  async function handleDelete(){
    if(!image?.blob || busy || !window.confirm('从个人素材中删除这张图片？已加入参考图或画布的图片会保留。'))return;
    setBusy('delete');try{await deletePersonalImage(identity,image.id);setPersonal(await personalMaterials(identity));setFailed(false);setMessage('个人图片已删除。');}catch(e){setMessage(e.message);}finally{setBusy('');}
  }
  return <div className="studio-page creative-materials">
    <div className="studio-page-title"><div><p className="studio-eyebrow">YOUR CREATIVE MATERIALS</p><h1>创作素材</h1><p>角色素材、风格提示词与常用预设，随时加入下一次创作。</p></div><span className="studio-outline-badge">角色素材 · 风格提示词 · 预设</span></div>
    <section className="companion-zone" aria-labelledby="companion-zone-title">
      <header className="studio-section-heading"><div><Sparkles size={20} /><h2 id="companion-zone-title">AI娘专区</h2></div><span>{groups.length} 类 · {AI_COMPANION_IMAGE_COUNT+personal.images.length} 张</span></header>
      <div className="companion-layout"><div className="companion-preview">{failed?<p role="alert">图片未能加载，请重新选择或刷新页面。</p>:previewUrl?<img key={image.id} src={previewUrl} alt={`${group.name} AI娘 · ${image.label}`} width={image.width} height={image.height} decoding="async" onError={()=>setFailed(true)} />:<div className="companion-empty"><ImagePlus size={36} /><p>{image?'正在读取图片…':'这个分类还没有图片'}</p><button type="button" className="studio-secondary" disabled={Boolean(busy) || loading} onClick={()=>upload.current?.click()}>上传自己的图片</button></div>}<span className="companion-caption">{group.name} <small>{image?index+1:0} / {group.images.length}</small></span></div>
        <div className="companion-details"><p className="studio-eyebrow">CHARACTER COLLECTION</p><h3>{group.name}</h3><p>选择角色和图片版本，一键加入参考图，或带到无限画布继续创作。</p>
          <div className="companion-manage"><button type="button" className="studio-secondary" disabled={Boolean(busy) || loading} onClick={()=>upload.current?.click()}><Upload size={16} />上传图片</button><button type="button" className="studio-secondary" disabled={Boolean(busy) || loading} onClick={()=>{setNewGroup(p=>!p);setMessage('');}}><Plus size={16} />新建分类</button></div>
          <input ref={upload} type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" aria-label="上传个人AI娘图片" hidden onChange={e=>{const files=Array.from(e.target.files || []);e.target.value='';handleUpload(files);}} />
          {newGroup && <form className="companion-new-group" onSubmit={handleCreate}><label className="studio-field"><span>新分类名称</span><input aria-label="新分类名称" value={groupName} maxLength={40} onChange={e=>setGroupName(e.target.value)} placeholder="例如：我的原创角色" autoFocus /></label><div><button type="submit" className="studio-primary" disabled={Boolean(busy)}>创建分类</button><button type="button" className="studio-secondary" onClick={()=>setNewGroup(false)}>取消</button></div></form>}
          <label className="studio-field"><span>选择AI娘</span><select aria-label="选择AI娘" value={group.id} disabled={Boolean(busy)} onChange={e=>{setGroupId(e.target.value);setMessage('');setFailed(false);}}>{groups.map(g=><option key={g.id} value={g.id}>{g.name}{g.owner?' · 我的分类':''} · {g.images.length} 张</option>)}</select></label>
          <label className="studio-field"><span>选择图片</span><select aria-label="选择AI娘图片" value={index} disabled={Boolean(busy) || !image} onChange={e=>select(Number(e.target.value))}>{group.images.length?group.images.map((i,n)=><option key={i.id} value={n}>{i.blob?'我的上传 · ':''}{i.label} · {i.width} × {i.height}</option>):<option value={0}>尚未上传图片</option>}</select></label>
          <div className="companion-paging"><button type="button" aria-label="上一张AI娘图片" disabled={index===0 || Boolean(busy)} onClick={()=>select(index-1)}><ArrowLeft size={16} />上一张</button><span>{image?index+1:0} / {group.images.length}</span><button type="button" aria-label="下一张AI娘图片" disabled={index>=group.images.length-1 || Boolean(busy)} onClick={()=>select(index+1)}>下一张<ArrowRight size={16} /></button></div>
          <div className="companion-imports"><button type="button" className="studio-primary" disabled={Boolean(busy) || failed || !image} onClick={()=>handleImport('reference')}><ImagePlus size={17} />{busy==='reference'?'正在加入…':'加入参考图'}</button><button type="button" className="studio-secondary" disabled={Boolean(busy) || failed || !image} onClick={()=>handleImport('canvas')}><Layers3 size={17} />{busy==='canvas'?'正在加入…':'加入无限画布'}</button></div>
          {image?.blob && <button type="button" className="companion-delete" disabled={Boolean(busy)} onClick={handleDelete}><Trash2 size={14} />删除我的图片</button>}
          <small className="companion-note">JPG / PNG / WebP / GIF，每张最多 16 MB。个人图片与分类只保存在当前浏览器，按当前账户分别显示，不会公开到其他用户的专区。</small>
          <small className="companion-note">浏览和导入素材不扣积分；开始生成后按所选模型计费。</small>{message && <p role="status" className="companion-message">{message}</p>}
        </div>
      </div>
    </section>
    <StylePromptZone key={identity} identity={identity} onUsePrompt={onUseStylePrompt} />
    <section className="creative-presets" aria-label="提示词预设库">{presetLibrary}<p className="companion-note">自定义预设继续保存在此浏览器中，可使用“导出”备份。</p></section>
  </div>;
}
