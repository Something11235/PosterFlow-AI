import React, { useRef, useState } from 'react';
import { Check, ImagePlus, Sparkles, Trash2, Upload } from 'lucide-react';
import { TavernDialog } from './TavernDialogs';
import { DEFAULT_TAVERN_APPEARANCE, TAVERN_BACKGROUND_LIMIT, normalizeTavernAppearance, prepareTavernBackground, tavernBackgroundStyle } from '../../lib/tavernAppearance';
import './tavern-appearance.css';

export default function TavernAppearanceDialog({ value, backgrounds = [], onAdd, onDelete, onGenerate, onSave, onClose }) {
  const [draft, setDraft] = useState(value || { ...DEFAULT_TAVERN_APPEARANCE });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [deleting, setDeleting] = useState(null);
  const sequence = useRef(0);
  const close = () => { sequence.current++; onClose(); };
  async function upload(file) {
    const turn = ++sequence.current; setBusy(true); setError('');
    try {
      const image = await prepareTavernBackground(file);
      if (turn !== sequence.current) return;
      const background = await onAdd({ id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || '本地背景', image, source: 'local', createdAt: Date.now() });
      if (turn === sequence.current) setDraft(previous => ({ ...previous, preset: 'library', image: '', backgroundId: background.id }));
    }
    catch (reason) { if (turn === sequence.current) setError(reason.message); }
    finally { if (turn === sequence.current) setBusy(false); }
  }
  async function remove() {
    const turn = ++sequence.current; setBusy(true); setError('');
    try {
      await onDelete(deleting.id);
      if (turn !== sequence.current) return;
      setDraft(previous => previous.backgroundId === deleting.id ? { ...DEFAULT_TAVERN_APPEARANCE, surface: previous.surface, dim: previous.dim } : previous);
      setDeleting(null);
    } catch (reason) { if (turn === sequence.current) setError(reason.message); }
    finally { if (turn === sequence.current) setBusy(false); }
  }
  return <TavernDialog title="聊天外观" eyebrow="YOUR STORY SPACE" icon={ImagePlus} onClose={close} className="tv-appearance-dialog">
    <div className="tv-dialog-body">
      <div className={`tv-appearance-preview tv-surface-${draft.surface}`} style={tavernBackgroundStyle(draft, backgrounds)}><span>背景与文字预览</span><p className="tv-appearance-sample">海风从窗边吹来。今天的故事，想从哪里开始？</p></div>
      <section className="tv-background-library" aria-label="我的背景库">
        <div className="tv-background-library-heading"><div><span className="tv-dialog-eyebrow">MY SCENES</span><h3>我的背景库 <small>{backgrounds.length} / {TAVERN_BACKGROUND_LIMIT}</small></h3></div><span>仅自己可见</span></div>
        <div className="tv-background-library-tools">
          {onGenerate && <button type="button" className="tv-button tv-button-primary" disabled={busy || backgrounds.length >= TAVERN_BACKGROUND_LIMIT} onClick={onGenerate}><Sparkles size={15} />按剧情生成背景</button>}
          <label className={`tv-background-import${busy || backgrounds.length >= TAVERN_BACKGROUND_LIMIT ? ' is-disabled' : ''}`}><Upload size={15} />导入本地图片<input aria-label="导入背景图片" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || backgrounds.length >= TAVERN_BACKGROUND_LIMIT} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label>
        </div>
        <p className="tv-field-hint">生成前可修改提示词与参数，点击生成后按生图价格计费；成功后自动存入本库。导入和删除立即保存，选择背景后点击「保存外观」应用。</p>
        {!!backgrounds.length && <div className="tv-background-grid" role="radiogroup" aria-label="选择个人背景">{backgrounds.map(item => <div key={item.id} className={`tv-background-card${draft.preset === 'library' && draft.backgroundId === item.id ? ' is-selected' : ''}`}>
          <label><input type="radio" name="tavern-library-background" checked={draft.preset === 'library' && draft.backgroundId === item.id} disabled={busy} onChange={() => setDraft(previous => ({ ...previous, preset: 'library', image: '', backgroundId: item.id }))} /><img src={item.image} alt="" loading="lazy" width="240" height="135" /><span>{item.name}</span>{draft.preset === 'library' && draft.backgroundId === item.id && <Check size={17} className="tv-background-selected" aria-hidden="true" />}</label>
          <div><small>{item.source === 'generated' ? 'AI 生成' : '本地导入'}</small><button type="button" disabled={busy} aria-label={`删除背景「${item.name}」`} onClick={() => setDeleting(item)}><Trash2 size={15} /></button></div>
        </div>)}</div>}
        {!backgrounds.length && <div className="tv-background-empty"><ImagePlus size={23} /><p>为这个故事留一处风景</p><span>根据剧情生成，或导入你喜欢的图片。</span></div>}
        {deleting && <div className="tv-background-delete" role="group" aria-label="确认删除背景"><p>删除「{deleting.name}」？仅删除本机背景副本，当前使用这张图时会恢复默认深色。</p><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={() => setDeleting(null)}>保留背景</button><button type="button" className="tv-button tv-button-danger" disabled={busy} onClick={() => void remove()}>确认删除背景</button></div>}
      </section>
      <fieldset className="tv-appearance-options"><legend>聊天背景</legend>{[['none','默认深色'],['ocean','夜海'],['stars','星夜'],['warm','暖灯']].map(([preset,label]) => <label key={preset}><input type="radio" name="tavern-background" checked={draft.preset === preset} disabled={busy} onChange={() => setDraft(previous => ({ ...previous, preset, image: '' }))} />{label}</label>)}</fieldset>
      <p className="tv-field-hint">PNG、JPG、WebP，最多12MB。图片缩小后仅存本机浏览器，计入酒馆20MB容量，不上传服务商。</p>
      <fieldset className="tv-appearance-options"><legend>文字托底</legend>{[['glass','半透明液态玻璃'],['solid','完全不透明'],['none','无底色']].map(([surface,label]) => <label key={surface}><input type="radio" name="tavern-surface" checked={draft.surface === surface} onChange={() => setDraft(previous => ({ ...previous, surface }))} />{label}</label>)}</fieldset>
      <label className="tv-dim-control">背景压暗 {draft.dim}%<input type="range" min="0" max="80" step="1" value={draft.dim} aria-label="背景压暗程度" onChange={event => setDraft(previous => ({ ...previous, dim: Number(event.target.value) }))} /></label>
      <p className="tv-field-hint">无底色时可提高压暗程度，让文字更清楚。外观应用于当前账号在本机的酒馆对话，不修改聊天内容。</p>
      {error && <p className="tv-form-error" role="alert">{error}</p>}
    </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" onClick={close}>取消</button><button type="button" className="tv-button tv-button-primary" disabled={busy} onClick={() => { try { onSave(normalizeTavernAppearance(draft)); } catch (reason) { setError(reason.message); } }}>{busy ? '正在处理图片…' : '保存外观'}</button></footer>
  </TavernDialog>;
}
