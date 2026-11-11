import React, { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { TavernDialog } from './TavernDialogs';
import { DEFAULT_TAVERN_APPEARANCE, normalizeTavernAppearance, prepareTavernBackground, tavernBackgroundStyle } from '../../lib/tavernAppearance';
import './tavern-appearance.css';

export default function TavernAppearanceDialog({ value, onSave, onClose }) {
  const [draft, setDraft] = useState(value || { ...DEFAULT_TAVERN_APPEARANCE });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0);
  const close = () => { sequence.current++; onClose(); };
  async function upload(file) {
    const turn = ++sequence.current; setBusy(true); setError('');
    try { const image = await prepareTavernBackground(file); if (turn === sequence.current) setDraft(previous => ({ ...previous, preset: 'image', image })); }
    catch (reason) { if (turn === sequence.current) setError(reason.message); }
    finally { if (turn === sequence.current) setBusy(false); }
  }
  return <TavernDialog title="聊天外观" eyebrow="YOUR STORY SPACE" icon={ImagePlus} onClose={close} className="tv-appearance-dialog">
    <div className="tv-dialog-body">
      <div className={`tv-appearance-preview tv-surface-${draft.surface}`} style={tavernBackgroundStyle(draft)}><span>背景与文字预览</span><p className="tv-appearance-sample">海风从窗边吹来。今天的故事，想从哪里开始？</p></div>
      <fieldset className="tv-appearance-options"><legend>聊天背景</legend>{[['none','默认深色'],['ocean','夜海'],['stars','星夜'],['warm','暖灯']].map(([preset,label]) => <label key={preset}><input type="radio" name="tavern-background" checked={draft.preset === preset} disabled={busy} onChange={() => setDraft(previous => ({ ...previous, preset, image: '' }))} />{label}</label>)}</fieldset>
      <label className="tv-background-upload">上传背景图片<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { if (event.target.files?.[0]) void upload(event.target.files[0]); }} /></label>
      <p className="tv-field-hint">PNG、JPG、WebP，最多12MB。图片缩小后仅存本机浏览器，计入酒馆20MB容量，不上传服务商。</p>
      <fieldset className="tv-appearance-options"><legend>文字托底</legend>{[['glass','半透明液态玻璃'],['solid','完全不透明'],['none','无底色']].map(([surface,label]) => <label key={surface}><input type="radio" name="tavern-surface" checked={draft.surface === surface} onChange={() => setDraft(previous => ({ ...previous, surface }))} />{label}</label>)}</fieldset>
      <label className="tv-dim-control">背景压暗 {draft.dim}%<input type="range" min="0" max="80" step="1" value={draft.dim} aria-label="背景压暗程度" onChange={event => setDraft(previous => ({ ...previous, dim: Number(event.target.value) }))} /></label>
      <p className="tv-field-hint">无底色时可提高压暗程度，让文字更清楚。外观应用于当前账号在本机的酒馆对话，不修改聊天内容。</p>
      {error && <p className="tv-form-error" role="alert">{error}</p>}
    </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" onClick={close}>取消</button><button type="button" className="tv-button tv-button-primary" disabled={busy} onClick={() => { try { onSave(normalizeTavernAppearance(draft)); } catch (reason) { setError(reason.message); } }}>{busy ? '正在处理图片…' : '保存外观'}</button></footer>
  </TavernDialog>;
}
