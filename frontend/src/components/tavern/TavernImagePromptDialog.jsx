import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ImagePlus, RotateCcw, Save } from 'lucide-react';
import { TavernDialog } from './TavernDialogs';
import { TAVERN_IMAGE_TEMPLATES, TAVERN_IMAGE_VARIABLES, buildTavernImagePrompt, normalizeTavernImageTemplates } from '../../lib/tavernImageTemplates';
import './tavern-image-prompts.css';

export default function TavernImagePromptDialog({ character, session, templates={}, initialType='scene', message, onSave, onUse, onClose }) {
  const [type,setType]=useState(initialType), [drafts,setDrafts]=useState({...templates}), [subject,setSubject]=useState('');
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [notice,setNotice]=useState('');
  const closed=useRef(false);
  useEffect(()=>{closed.current=false;return()=>{closed.current=true;};},[]);
  const preset=TAVERN_IMAGE_TEMPLATES.find(item=>item.id===type) || TAVERN_IMAGE_TEMPLATES[0];
  const template=drafts[preset.id] ?? preset.text;
  const preview=useMemo(() => { try { return {text:buildTavernImagePrompt(type,character,session,{templates:drafts,message,subject})}; } catch(reason) { return {error:reason.message}; } },[type,character,session,drafts,message,subject]);
  const close=()=>{closed.current=true;onClose();};
  async function save(go=false) {
    if(busy) return; setBusy(true);setError('');setNotice('');
    try {
      const normalized=normalizeTavernImageTemplates(drafts);
      if(go && preview.error) throw new Error(preview.error);
      await onSave(normalized); if(closed.current) return;
      if(go) await onUse(preview.text,preset);
      else setNotice('我的中文模板已保存到当前账号的本机酒馆。');
    } catch(reason) { if(!closed.current) setError(reason.message); }
    finally { if(!closed.current) setBusy(false); }
  }
  return <TavernDialog title="图像提示词模板" eyebrow="STORY TO IMAGE" icon={ImagePlus} onClose={close} className="tv-image-prompt-dialog"><div className="tv-dialog-body">
    <p className="tv-field-hint">选择想画的内容，自动带入当前故事资料。预览在本机完成，不额外调用文字模型；前往生图后确认模型与价格，再点击生成。</p>
    <fieldset className="tv-image-template-options"><legend>画面类型</legend>{TAVERN_IMAGE_TEMPLATES.map(item=><label key={item.id} className={type===item.id?'is-selected':''}><input type="radio" name="tavern-image-template" value={item.id} checked={type===item.id} disabled={busy} onChange={()=>{setType(item.id);setError('');setNotice('');}}/><strong>{item.name}</strong><span>{item.note}</span></label>)}</fieldset>
    {type==='custom' && <label className="tv-image-template-field">我想画的主题<textarea aria-label="我想画的主题" value={subject} maxLength={1000} rows={3} disabled={busy} onChange={event=>setSubject(event.target.value)} placeholder="例如：清晨薄雾中的海边灯塔，温柔的水彩插画" /></label>}
    <details className="tv-image-template-editor"><summary>编辑当前中文模板{drafts[preset.id]!==undefined?' · 已自定义':''}</summary><label className="tv-image-template-field">{preset.name}模板<textarea aria-label={`${preset.name}模板`} value={template} maxLength={4000} rows={7} disabled={busy} onChange={event=>{setDrafts(previous=>({...previous,[preset.id]:event.target.value}));setError('');setNotice('');}} /></label><p className="tv-field-hint">变量只替换为故事文字，不执行脚本或嵌套变量。资料为节选，原始角色卡不会被翻译或改写。</p><div className="tv-image-template-variables">{Object.entries(TAVERN_IMAGE_VARIABLES).map(([key,label])=><span key={key}><code>{`{{${key}}}`}</code> {label}</span>)}</div><div className="tv-image-template-actions"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={()=>{setDrafts(previous=>{const next={...previous};delete next[preset.id];return next;});setError('');setNotice('已恢复默认内容，保存后生效。');}}><RotateCcw size={14}/>恢复此模板</button><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={()=>void save()}><Save size={14}/>保存我的模板</button></div></details>
    <section className="tv-image-prompt-preview" aria-label="生图提示词预览"><div><strong>将带入生图的提示词</strong><span>{preview.text?.length || 0} / 6000</span></div>{preview.error?<p className="tv-form-error" role="alert">{preview.error}</p>:<p>{preview.text}</p>}</section>
    <p className="tv-field-hint">{type==='background'?'纯环境背景生成成功后会自动存入你的酒馆背景库。':'角色与场景图片生成后可在画廊下载，或手动存入背景库。'}点击「前往 AI 生图」会保存当前模板。英文原始设定仍作为参考，绘画要求默认使用中文。</p>
    {error&&<p className="tv-form-error" role="alert">{error}</p>}{notice&&<p className="tv-save-status" role="status">{notice}</p>}
  </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={close}>取消</button><button type="button" className="tv-button tv-button-primary" disabled={busy||Boolean(preview.error)} onClick={()=>void save(true)}><ArrowUpRight size={15}/>{busy?'正在保存…':'前往 AI 生图'}</button></footer></TavernDialog>;
}
