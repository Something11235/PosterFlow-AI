import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, ImagePlus, Palette, Pencil, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import styles from '../../lib/stylePromptsCatalog.json';
import { deletePersonalStylePrompt, personalStylePrompts, savePersonalStylePrompt } from '../../lib/personalStylePrompts';
import PersonalStyleForm from './PersonalStyleForm';

function StylePromptEditor({ style, onUsePrompt, onSavePrompt, onCopyStyle, busy }) {
  const [prompt, setPrompt] = useState(style.prompt);
  const [message, setMessage] = useState('');
  const [copying, setCopying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [localUrl, setLocalUrl] = useState('');
  const input = useRef(null);
  useEffect(() => {
    if (!style.image?.blob) return;
    const url = URL.createObjectURL(style.image.blob);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [style.image]);
  const imageUrl = style.image?.blob ? localUrl : style.image?.url;

  async function copyPrompt() {
    if (copying || !prompt.trim()) return;
    setCopying(true);
    setMessage('');
    try {
      await navigator.clipboard.writeText(prompt);
      setMessage('提示词已复制。');
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage('未能访问剪贴板，已选中提示词，请手动复制。');
    } finally {
      setCopying(false);
    }
  }

  return <div className="style-prompt-layout">
    <figure className="style-prompt-example">
      <div className="style-prompt-image">{failed ? <p role="alert">示例图暂时无法加载，仍可使用下方提示词。</p> : imageUrl ? <img src={imageUrl} alt={`${style.name}风格示例`} width={style.image.width} height={style.image.height} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <div className="style-prompt-no-image"><ImagePlus size={32} /><p>{style.image ? '正在读取示例图…' : '此风格暂未添加示例图'}</p></div>}</div>
      <figcaption>风格示例 · {style.name}</figcaption>
    </figure>
    <div className="style-prompt-editor">
      <div className="style-prompt-title"><h3>{style.name}</h3>{style.requiresReference && <span>需上传参考图</span>}</div>
      <p className="style-prompt-hint">替换原文中的角色、主题或方括号内容，调整成你的创作。</p>
      {style.requiresReference && <p className="style-prompt-reference">此提示词需要你上传参考图，请在图像创作中选择支持参考图的模型并添加图片。</p>}
      <label className="studio-field style-prompt-field"><span>风格提示词 · 可直接编辑</span><textarea ref={input} aria-label="风格提示词" value={prompt} onChange={event => { setPrompt(event.target.value); setMessage(''); }} spellCheck={false} rows={10} /></label>
      <div className="style-prompt-actions">
        <button type="button" className="studio-primary" disabled={!prompt.trim()} onClick={() => onUsePrompt(prompt)}><ArrowRight size={16} />填入图像创作</button>
        <button type="button" className="studio-secondary" disabled={copying || !prompt.trim()} onClick={copyPrompt}>{message === '提示词已复制。' ? <Check size={16} /> : <Copy size={16} />}{copying ? '正在复制…' : '复制提示词'}</button>
        <button type="button" className="style-prompt-reset" disabled={prompt === style.prompt} onClick={() => { setPrompt(style.prompt); setMessage('已恢复原文。'); }}><RotateCcw size={14} />恢复原文</button>
        {style.owner ? <button type="button" className="studio-secondary" disabled={busy || !prompt.trim() || prompt === style.prompt} onClick={() => onSavePrompt({ ...style, prompt })}><Save size={15} />保存我的修改</button> : <button type="button" className="style-prompt-reset" disabled={busy || !prompt.trim()} onClick={() => onCopyStyle({ ...style, name: `${style.name} · 我的版本`.slice(0, 80), prompt })}><Plus size={14} />另存为我的风格</button>}
      </div>
      <p className="companion-note">填入会替换当前图像提示词，不会自动生成。{style.owner ? '编辑后请保存我的修改，切换前未保存的内容不会保留。' : '切换风格后，本区编辑内容恢复为原文。'}</p>
      <p className="style-prompt-status" role="status">{message}</p>
    </div>
  </div>;
}

export default function StylePromptZone({ identity, onUsePrompt }) {
  const [personal, setPersonal] = useState([]);
  const [selectedId, setSelectedId] = useState(styles[0].id);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState(null);
  const choices = [...styles, ...personal];
  const index = Math.max(0, choices.findIndex(style => style.id === selectedId));
  const selected = choices[index];
  const own = selected.owner === identity;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    personalStylePrompts(identity).then(items => { if (active) setPersonal(items); }).catch(error => { if (active) setLoadError(error.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [identity, revision]);

  function select(id) { setSelectedId(id); setForm(null); setNotice(''); }
  async function save(draft, file) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const saved = await savePersonalStylePrompt(identity, draft, file);
      setPersonal(items => [...items.filter(item => item.id !== saved.id), saved].sort((a, b) => a.createdAt - b.createdAt));
      setSelectedId(saved.id); setForm(null); setNotice('我的风格已保存。');
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!own || busy || !window.confirm(`删除我的风格“${selected.name}”？内置风格不会受影响。`)) return;
    setBusy(true); setNotice('');
    try {
      await deletePersonalStylePrompt(identity, selected.id);
      setPersonal(items => items.filter(item => item.id !== selected.id));
      setSelectedId(styles[0].id); setForm(null); setNotice('我的风格已删除。');
    } catch (error) { setNotice(error.message); }
    finally { setBusy(false); }
  }
  return <section className="style-prompt-zone" aria-labelledby="style-prompt-zone-title">
    <header className="studio-section-heading"><div><Palette size={20} /><h2 id="style-prompt-zone-title">风格化提示词专区</h2></div><span>{styles.length} 内置 · {personal.length} 我的</span></header>
    <div className="style-prompt-manage"><button type="button" className="studio-secondary" disabled={loading || busy || Boolean(loadError)} onClick={() => { setForm({ initial: null }); setNotice(''); }}><Plus size={16} />新建我的风格</button>{own && <><button type="button" className="studio-secondary" disabled={busy} onClick={() => { setForm({ initial: selected }); setNotice(''); }}><Pencil size={15} />编辑我的风格</button><button type="button" className="companion-delete" disabled={busy} onClick={remove}><Trash2 size={15} />删除我的风格</button></>}</div>
    <p className="companion-note style-prompt-storage-note">个人风格及示例图仅保存在当前浏览器，按账户分别显示；游客使用本浏览器的游客空间。仅自己的风格可修改或删除，内置风格可另存为个人版本。</p>
    {loadError && <p className="style-prompt-load-error" role="alert">{loadError}<button type="button" className="studio-secondary" onClick={() => setRevision(value => value + 1)}>重新读取个人风格</button></p>}
    {form && <PersonalStyleForm key={form.initial?.id || (form.initial ? `copy-${form.initial.name}` : 'new')} initial={form.initial} busy={busy} onSave={(draft, file) => save({ ...draft, id: form.initial?.owner === identity ? draft.id : undefined }, file)} onCancel={() => { setForm(null); setNotice(''); }} />}
    <p className="style-prompt-status" role="status">{notice}</p>
    <div className="style-prompt-toolbar">
      <label className="studio-field"><span>选择风格</span><select aria-label="选择提示词风格" value={selected.id} disabled={busy} onChange={event => select(event.target.value)}>{choices.map(style => <option key={style.id} value={style.id}>{style.name}{style.owner ? ' · 我的' : ''}</option>)}</select></label>
      <div className="style-prompt-paging"><button type="button" aria-label="上一个提示词风格" disabled={index === 0 || busy} onClick={() => select(choices[index - 1].id)}><ArrowLeft size={16} /></button><span>{index + 1} / {choices.length}</span><button type="button" aria-label="下一个提示词风格" disabled={index === choices.length - 1 || busy} onClick={() => select(choices[index + 1].id)}><ArrowRight size={16} /></button></div>
    </div>
    <StylePromptEditor key={`${selected.id}-${selected.updatedAt || ''}`} style={selected} onUsePrompt={onUsePrompt} busy={busy || loading || Boolean(loadError)} onSavePrompt={save} onCopyStyle={style => { setForm({ initial: { ...style, id: undefined, image: null } }); setNotice(''); }} />
  </section>;
}
