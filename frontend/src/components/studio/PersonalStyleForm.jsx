import React, { useState } from 'react';
import { Upload } from 'lucide-react';

export default function PersonalStyleForm({ initial, busy, onSave, onCancel }) {
  const editing = Boolean(initial?.id);
  const [name, setName] = useState(initial?.name || '');
  const [prompt, setPrompt] = useState(initial?.prompt || '');
  const [requiresReference, setRequiresReference] = useState(Boolean(initial?.requiresReference));
  const [file, setFile] = useState(null);
  return <form className="personal-style-form" aria-label={editing ? '编辑我的风格' : '新建我的风格'} onSubmit={event => { event.preventDefault(); onSave({ id: initial?.id, name, prompt, requiresReference }, file); }}>
    <h3>{editing ? '编辑我的风格' : '新建我的风格'}</h3>
    <label className="studio-field"><span>风格名称</span><input autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="例如：复古水彩插画" disabled={busy} /></label>
    <label className="studio-field"><span>我的风格提示词</span><textarea aria-label="我的风格提示词" required maxLength={6000} rows={5} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="填写画风、构图、色彩和材质，也可保留供创作时替换的占位符。" disabled={busy} /></label>
    <label className="personal-style-upload"><Upload size={16} /><span>{file ? file.name : initial?.image ? '更换示例图（可选）' : '上传示例图（可选）'}</span><input type="file" aria-label="上传风格示例图" accept="image/jpeg,image/png,image/webp,image/gif" disabled={busy} onChange={event => setFile(event.target.files?.[0] || null)} /></label>
    <p className="companion-note">JPG / PNG / WebP / GIF，每张最多 16 MB。不上传图片也可以保存风格。</p>
    <label className="personal-style-checkbox"><input type="checkbox" checked={requiresReference} disabled={busy} onChange={event => setRequiresReference(event.target.checked)} />使用此提示词时需要参考图</label>
    <div className="style-prompt-actions"><button type="submit" className="studio-primary" disabled={busy}>{busy ? '正在保存…' : '保存我的风格'}</button><button type="button" className="studio-secondary" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}
