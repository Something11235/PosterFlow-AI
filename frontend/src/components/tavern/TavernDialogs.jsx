import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Check, ChevronDown, Cpu, Download, Eye, EyeOff, Feather, FileUp, KeyRound, Link2, Loader2, Pencil, Plus, Save, Settings2, Sparkles, Trash2, Upload, UserRound, X } from 'lucide-react';
import { exportLorebook, isValidTavernContextChars, normalizeCharacter, parseCharacterFile, parseLorebookFile, TAVERN_CHARACTER_LIMITS, TAVERN_MAX_IMAGE_BYTES, TAVERN_MAX_REPLY_CHARS } from '../../lib/tavern.js';
import { requestTavernImport } from '../../lib/tavernClient.js';
import { TavernContextMeter } from './TavernConversationTools.jsx';
import './tavern-dialogs.css';

export function TavernDialog({ title, eyebrow, icon: Icon, onClose, children, className = '' }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    const focus = dialog.querySelector('[data-initial-focus]');
    focus?.focus();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={ref} className={`tv-dialog ${className}`} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <header className="tv-dialog-head"><span className="tv-dialog-emblem"><Icon size={22} strokeWidth={1.6} /></span><div><span className="tv-dialog-eyebrow">{eyebrow}</span><h2 id={titleId}>{title}</h2></div><button type="button" className="tv-icon-button" onClick={onClose} aria-label="关闭弹窗"><X size={19} /></button></header>
    {children}
  </dialog>, document.body);
}

function Field({ label, hint, children, className = '' }) {
  const fieldId = useId();
  const associate = nodes => React.Children.map(nodes, child => {
    if (!React.isValidElement(child)) return child;
    if (['input', 'textarea', 'select'].includes(child.type)) return React.cloneElement(child, { 'aria-labelledby': `${fieldId}-label`, 'aria-describedby': hint ? `${fieldId}-hint` : undefined });
    return child.props.children ? React.cloneElement(child, {}, associate(child.props.children)) : child;
  });
  return <label className={`tv-field ${className}`}><span id={`${fieldId}-label`} className="tv-field-label">{label}</span>{associate(children)}{hint && <span id={`${fieldId}-hint`} className="tv-field-hint">{hint}</span>}</label>;
}

async function avatarData(file) {
  if (!file || !file.size || file.size > 2 * 1024 * 1024) throw new Error('头像请使用 2 MB 以内的 PNG、JPG 或 WebP 图片。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10';
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new Error('头像格式无法识别，请选择 PNG、JPG 或 WebP 图片。');
  const blob = new Blob([bytes], { type: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp' });
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20000000) throw new Error();
  } catch { throw new Error('图片无法读取或尺寸过大，请更换头像。'); }
  finally { bitmap?.close(); }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('头像读取失败，请重新选择。'));
    reader.readAsDataURL(blob);
  });
}

export function CharacterEditor({ character, onSave, onClose }) {
  const [draft, setDraft] = useState(() => ({ name: '', subtitle: '', avatar: '', description: '', personality: '', scenario: '', firstMessage: '', exampleMessages: '', creatorNotes: '', creator: '', characterVersion: '', systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], tags: [], ...character }));
  const [tags, setTags] = useState(() => (character?.tags || []).join('，'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = useRef(false);
  const tagsEdited = useRef(false);
  const fileInput = useRef(null);
  const form = useRef(null);
  const update = patch => { dirty.current = true; setDraft(value => ({ ...value, ...patch })); setError(''); setDiscard(false); };
  const dismiss = () => { if (!busy && !uploading) { if (dirty.current) setDiscard(true); else onClose(); } };
  const submit = async event => {
    event.preventDefault();
    if (busy || uploading) return;
    if (!draft.name.trim()) { setError('给角色取一个名字后再保存。'); form.current?.elements.namedItem('character-name')?.focus(); return; }
    try {
      const parsed = normalizeCharacter({ ...draft, tags: tagsEdited.current ? tags.split(/[,，]/).map(value => value.trim()).filter(Boolean) : draft.tags });
      setBusy(true); setError('');
      await onSave(parsed);
    } catch (reason) { setError(reason.message || '角色未能保存，请稍后重试。'); }
    finally { setBusy(false); }
  };
  return <TavernDialog title={character ? '编辑角色' : '让一个角色，从这里开始'} eyebrow="CHARACTER STUDIO" icon={Feather} onClose={dismiss}>
    <form ref={form} className="tv-dialog-form" onSubmit={submit}>
      <div className="tv-dialog-body">
        <div className="tv-character-identity">
          <button type="button" className="tv-avatar-upload" onClick={() => fileInput.current?.click()} disabled={busy || uploading} aria-label="上传角色头像">
            {draft.avatar ? <img src={draft.avatar} alt="角色头像预览" /> : <UserRound size={34} strokeWidth={1.2} />}
            <span>{uploading ? <Loader2 size={15} className="tv-spin" /> : <Upload size={15} />}{uploading ? '读取中' : '更换头像'}</span>
          </button>
          <input ref={fileInput} type="file" className="tv-file-input" accept="image/png,image/jpeg,image/webp" aria-label="角色头像文件" onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
            setUploading(true); setError('');
            try { update({ avatar: await avatarData(file) }); } catch (reason) { setError(reason.message); } finally { setUploading(false); }
          }} />
          <div className="tv-identity-fields">
            <Field label="角色名字 *"><input name="character-name" data-initial-focus required maxLength={80} value={draft.name} onChange={event => update({ name: event.target.value })} placeholder="例如：澜" disabled={busy} /></Field>
            <Field label="一句话介绍"><input maxLength={120} value={draft.subtitle} onChange={event => update({ subtitle: event.target.value })} placeholder="星图记录员，收集宇宙里尚未讲完的故事" disabled={busy} /></Field>
          </div>
        </div>
        <p className="tv-field-hint tv-avatar-hint">头像支持 PNG、JPG、WebP，最多 2 MB。</p>
        <Field label="角色设定" hint="描述身份、经历和重要细节，让角色拥有自己的故事。"><textarea rows={4} maxLength={TAVERN_CHARACTER_LIMITS.description} value={draft.description} onChange={event => update({ description: event.target.value })} placeholder="她是谁？来自哪里？又为什么在这里遇见你？" disabled={busy} /></Field>
        <Field label="开场白" hint="开始一段新对话时，角色说出的第一句话。"><textarea rows={3} maxLength={TAVERN_CHARACTER_LIMITS.firstMessage} value={draft.firstMessage} onChange={event => update({ firstMessage: event.target.value })} placeholder="“晚上好，旅人。你也是循着那颗蓝色的星来到这里的吗？”" disabled={busy} /></Field>
        <details className="tv-disclosure"><summary><Settings2 size={16} /><span>细化角色与故事</span><ChevronDown size={16} /></summary><div className="tv-disclosure-body">
          <Field label="性格与说话方式"><textarea rows={3} maxLength={TAVERN_CHARACTER_LIMITS.personality} value={draft.personality} onChange={event => update({ personality: event.target.value })} placeholder="温和而好奇，偶尔用星星打比方，回答简短自然。" disabled={busy} /></Field>
          <Field label="初始场景"><textarea rows={3} maxLength={TAVERN_CHARACTER_LIMITS.scenario} value={draft.scenario} onChange={event => update({ scenario: event.target.value })} placeholder="午夜的观星台。你带着一张没有标记的星图来访。" disabled={busy} /></Field>
          <Field label="示例对话" hint="填写你与角色的示例对话，帮助角色把握语气与表达。"><textarea rows={4} maxLength={TAVERN_CHARACTER_LIMITS.exampleMessages} value={draft.exampleMessages} onChange={event => update({ exampleMessages: event.target.value })} placeholder={'你：你每天都会来这里吗？\n角色：只要天还没有完全亮。'} disabled={busy} /></Field>
          <Field label="标签" hint={`用逗号分隔，最多 ${TAVERN_CHARACTER_LIMITS.tags} 个标签，每个最多 ${TAVERN_CHARACTER_LIMITS.tagLength} 个字符。`}><input maxLength={TAVERN_CHARACTER_LIMITS.tags * (TAVERN_CHARACTER_LIMITS.tagLength + 1)} value={tags} onChange={event => { setTags(event.target.value); tagsEdited.current = true; dirty.current = true; setError(''); setDiscard(false); }} placeholder="幻想，日常，冒险" disabled={busy} /></Field>
        </div></details>
        <details className="tv-disclosure tv-character-author"><summary><BookOpen size={16} /><span>作者与使用备注</span><ChevronDown size={16} /></summary><div className="tv-disclosure-body">
          <div className="tv-two-fields"><Field label="作者"><input name="character-creator" maxLength={300} value={draft.creator} onChange={event => update({ creator: event.target.value })} placeholder="角色卡作者或来源署名" disabled={busy} /></Field><Field label="角色版本"><input name="character-version" maxLength={100} value={draft.characterVersion} onChange={event => update({ characterVersion: event.target.value })} placeholder="例如 1.0" disabled={busy} /></Field></div>
          <Field label="作者备注" hint="保留作者的原始说明，仅以纯文本查看和保存，不加载其中的图片；不会作为对话提示发送。"><textarea name="character-creator-notes" rows={7} maxLength={TAVERN_CHARACTER_LIMITS.creatorNotes} value={draft.creatorNotes} onChange={event => update({ creatorNotes: event.target.value })} placeholder="作者提供的背景说明、使用建议或其他备注。" disabled={busy} /></Field>
        </div></details>
        <details className="tv-disclosure tv-character-prompts"><summary><Settings2 size={16} /><span>角色高级提示</span><ChevronDown size={16} /></summary><div className="tv-disclosure-body">
          <Field label="系统角色提示" hint="用于补充角色扮演与表达要求。"><textarea name="character-system-prompt" rows={5} maxLength={TAVERN_CHARACTER_LIMITS.systemPrompt} value={draft.systemPrompt} onChange={event => update({ systemPrompt: event.target.value })} placeholder="例如：用细腻的环境描写推进场景，给用户保留行动选择。" disabled={busy} /></Field>
          <Field label="后置角色提示" hint="补充后续回复需要遵循的角色要求。"><textarea name="character-post-history" rows={5} maxLength={TAVERN_CHARACTER_LIMITS.postHistoryInstructions} value={draft.postHistoryInstructions} onChange={event => update({ postHistoryInstructions: event.target.value })} placeholder="例如：回应当前场景，每次推进少量情节。" disabled={busy} /></Field>
        </div></details>
        <details className="tv-disclosure tv-character-greetings"><summary><Feather size={16} /><span>备用开场</span><ChevronDown size={16} /></summary><div className="tv-disclosure-body">
          <p className="tv-field-hint tv-alternate-intro">按原顺序保存，空项也会保留。备用开场不会替换上方的默认开场白。</p>
          <div className="tv-alternate-greetings">{draft.alternateGreetings.map((greeting, index) => <div key={index} className="tv-alternate-entry"><Field label={`备用开场 ${index + 1}`}><textarea name={`character-alternate-${index + 1}`} rows={4} maxLength={TAVERN_CHARACTER_LIMITS.firstMessage} value={greeting} onChange={event => update({ alternateGreetings: draft.alternateGreetings.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} placeholder="可保留为空，或填写另一段故事开场。" disabled={busy} /></Field><div className="tv-alternate-entry-tools"><span>{greeting.length} / {TAVERN_CHARACTER_LIMITS.firstMessage}</span><button type="button" className="tv-icon-button" aria-label={`删除备用开场 ${index + 1}`} onClick={() => update({ alternateGreetings: draft.alternateGreetings.filter((_, itemIndex) => itemIndex !== index) })} disabled={busy}><Trash2 size={16} /></button></div></div>)}</div>
          <div className="tv-alternate-actions"><span>{draft.alternateGreetings.length} / {TAVERN_CHARACTER_LIMITS.alternateGreetings} 条</span><button type="button" className="tv-button tv-button-secondary" disabled={busy || draft.alternateGreetings.length >= TAVERN_CHARACTER_LIMITS.alternateGreetings} onClick={() => update({ alternateGreetings: [...draft.alternateGreetings, ''] })}><Plus size={16} />添加备用开场</button></div>
        </div></details>
        {error && <p className="tv-form-error" role="alert">{error}</p>}
        {discard && <div className="tv-discard" role="alert"><p>角色还有尚未保存的修改。</p><div><button type="button" className="tv-button tv-button-secondary" onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className="tv-button tv-button-danger" onClick={onClose}>放弃修改</button></div></div>}
      </div>
      <footer className="tv-dialog-footer"><span>保存在当前浏览器</span><button type="button" className="tv-button tv-button-secondary" onClick={dismiss} disabled={busy || uploading}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy || uploading}>{busy ? <Loader2 size={16} className="tv-spin" /> : <Check size={16} />}{busy ? '保存中…' : '保存角色'}</button></footer>
    </form>
  </TavernDialog>;
}

export function TavernGreetingPicker({ character, onSelect, onClose }) {
  const options = [{ index: -1, label: '默认开场', content: character.firstMessage || '' },
    ...(character.alternateGreetings || []).map((content, index) => ({ index, label: `备用开场 ${index + 1}`, content })).filter(item => item.content.trim())];
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const groupName = useId();
  const selected = options.find(item => item.index === selectedIndex) || options[0];
  const dismiss = () => { if (!saving.current) onClose(); };
  const submit = async event => {
    event.preventDefault();
    if (saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try { await onSelect(selected.index); }
    catch (reason) { setError(reason?.message || '未能开始新对话，请重试。'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <TavernDialog title="选择故事的开场" eyebrow="A NEW BEGINNING" icon={Feather} onClose={dismiss} className="tv-greeting-dialog"><form className="tv-dialog-form" onSubmit={submit}><div className="tv-dialog-body">
    <p className="tv-context-intro">为与{character.name}的新对话选择一个开场。内容保留角色卡原文，不会自动翻译。</p>
    <fieldset className="tv-greeting-options" disabled={busy}><legend className="tv-field-label">选择开场</legend>{options.map(item => <label key={item.index} className={selected.index === item.index ? 'is-selected' : ''}><input type="radio" name={groupName} value={item.index} checked={selected.index === item.index} onChange={() => { setSelectedIndex(item.index); setError(''); }} data-initial-focus={item.index === -1 ? true : undefined} /><span><strong>{item.label}</strong><small>{item.content ? `${item.content.slice(0, 75)}${item.content.length > 75 ? '…' : ''}` : '空白开场'}</small></span></label>)}</fieldset>
    <section className="tv-greeting-preview" aria-label="所选开场预览"><h3>{selected.label}</h3><div tabIndex={0}>{selected.content || '这个开场没有预置消息。'}</div></section>
    {error && <p className="tv-form-error" role="alert">{error}</p>}
  </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={dismiss}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy}>{busy ? <Loader2 size={16} className="tv-spin" /> : <Check size={16} />}{busy ? '正在创建…' : '以此开场开始'}</button></footer></form></TavernDialog>;
}

export function TavernBranchDialog({ message, onConfirm, onClose }) {
  const [content, setContent] = useState(message.content || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const limit = message.role === 'assistant' ? TAVERN_MAX_REPLY_CHARS : 6000;
  const dismiss = () => { if (!saving.current) onClose(); };
  const submit = async event => {
    event.preventDefault();
    if (saving.current) return;
    if (!content.trim()) { setError('请填写分支消息内容。'); return; }
    if (content.length > limit) { setError(`这条消息最多 ${limit} 个字符，请精简后保存。`); return; }
    saving.current = true; setBusy(true); setError('');
    try { await onConfirm(content); }
    catch (reason) { setError(reason?.message || '分支未能保存，请重试。'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <TavernDialog title="编辑消息，创建分支" eyebrow="STORY BRANCH" icon={Pencil} onClose={dismiss}><form className="tv-dialog-form" onSubmit={submit}><div className="tv-dialog-body">
    <p className="tv-context-intro">将从这条消息创建一段新对话。源对话的历史保持不变，新分支从修改后的消息继续。</p>
    <Field label="分支消息" hint={`最多 ${limit.toLocaleString('zh-CN')} 个字符。`}><textarea name="tavern-branch-content" data-initial-focus rows={12} maxLength={limit} value={content} onChange={event => { setContent(event.target.value); setError(''); }} disabled={busy} /></Field>
    {error && <p className="tv-form-error" role="alert">{error}</p>}
  </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={dismiss}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy}>{busy ? <Loader2 size={16} className="tv-spin" /> : <Check size={16} />}{busy ? '正在保存…' : '保存为新分支'}</button></footer></form></TavernDialog>;
}

export function TavernStorySettings({ session, onSave, onClose }) {
  const [scenario, setScenario] = useState(() => session.scenario ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const dismiss = () => { if (!saving.current) onClose(); };
  const submit = async event => {
    event.preventDefault();
    if (saving.current) return;
    if (scenario.length > 3000) { setError('初始场景最多 3000 个字符，请精简后保存。'); return; }
    saving.current = true; setBusy(true); setError('');
    try { await onSave(scenario); }
    catch (reason) { setError(reason?.message || '故事起点未能保存，请重试。'); }
    finally { saving.current = false; setBusy(false); }
  };
  return <TavernDialog title="故事起点" eyebrow="STORY SETTING" icon={Feather} onClose={dismiss}>
    <form className="tv-dialog-form" onSubmit={submit}>
      <div className="tv-dialog-body"><p className="tv-context-intro">记录故事开始时的地点、氛围和正在发生的事。保存仅影响当前对话的后续回复，不改已发送消息。</p>
        <Field label="初始场景" hint="最多 3000 个字符，可清空保存。"><textarea data-initial-focus maxLength={3000} rows={9} value={scenario} onChange={event => { setScenario(event.target.value); setError(''); }} placeholder="例如：午夜的观星台。你和角色正坐在窗边，桌上铺着一张尚未完成的星图。" disabled={busy} /></Field>
        {error && <p className="tv-form-error" role="alert">{error}</p>}
      </div>
      <footer className="tv-dialog-footer"><span>{scenario.length} / 3000</span><button type="button" className="tv-button tv-button-secondary" onClick={dismiss} disabled={busy}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy}>{busy ? <Loader2 size={16} className="tv-spin" /> : <Check size={16} />}{busy ? '保存中…' : '保存起点'}</button></footer>
    </form>
  </TavernDialog>;
}

const decimalPrice = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value);
const displayPrice = value => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
const displayTokens = value => value.toLocaleString('zh-CN');

function TavernPlatformPricing({ pricing }) {
  const valid = pricing?.version === 1 && pricing.rounding === 'ceil_after_sum'
    && decimalPrice(pricing.precision) && Number(pricing.precision) > 0
    && Number.isSafeInteger(pricing.token_unit) && pricing.token_unit > 0
    && ['input_uncached', 'cache_read', 'output'].every(key => decimalPrice(pricing.rates?.[key]));
  if (!valid) return <p className="tv-pricing-unavailable" role="status">尚未取得平台计费规则，暂时无法展示价目与示例。请稍后重新查看。</p>;
  const examples = Array.isArray(pricing.examples) ? pricing.examples.filter(example => example
    && ['input_tokens', 'output_tokens', 'cache_read_tokens'].every(key => Number.isSafeInteger(example[key]) && example[key] >= 0)
    && example.cache_read_tokens <= example.input_tokens && decimalPrice(example.credits)) : [];
  const unit = pricing.token_unit === 1000000 ? '百万 Token' : `${displayTokens(pricing.token_unit)} Token`;
  return <section className="tv-pricing-panel" aria-label="平台积分计费规则">
    <table className="tv-pricing-table"><caption>平台文字对话价目</caption><thead><tr><th scope="col">用量类型</th><th scope="col">积分 / {unit}</th></tr></thead><tbody>
      {[['input_uncached', '未缓存输入'], ['cache_read', '缓存读取'], ['output', '输出']].map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{displayPrice(pricing.rates[key])}</td></tr>)}
    </tbody></table>
    <div className="tv-pricing-notes"><p>每轮合计后向上取至 <strong>{displayPrice(pricing.precision)} 积分</strong>。</p><p>按实际输入和输出 Token 自动结算；服务商未提供缓存明细时按普通输入价收费，已确认的缓存部分按缓存优惠价，不重复计费。</p><p>提交时先预留积分，完成后自动扣费并退回差额。剧情摘要另计用量；只有输入输出缺失或请求结果不明时保留预留，不自动重发，也不阻断其他对话。</p></div>
    {examples.length > 0 ? <div className="tv-pricing-examples"><h4>单轮示例</h4><dl>{examples.map((example, index) => <div key={index}><dt>{displayTokens(example.input_tokens)} 输入 + {displayTokens(example.output_tokens)} 输出<span>{example.cache_read_tokens ? `其中 ${displayTokens(example.cache_read_tokens)} 输入命中缓存` : '输入无缓存命中'}</span></dt><dd>{displayPrice(example.credits)}<span>积分</span></dd></div>)}</dl><p>示例用于说明计费规则，非实际扣费记录。</p></div> : <p className="tv-pricing-example-unavailable">暂未取得计费示例。</p>}
  </section>;
}

export function TavernSettings({ value, service, onSave, onClose }) {
  const platformReady = service?.platform_configured === true && service?.pricing?.billing_enabled === true;
  const [draft, setDraft] = useState(() => ({ billingMode: 'platform', apiKey: '', temperature: 0.8, maxTokens: 1024, ...value, endpoint: value?.ownEndpoint ?? (value?.billingMode === 'own_key' ? value.endpoint : ''), model: value?.ownModel ?? (value?.billingMode === 'own_key' ? value.model : '') }));
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef(null);
  const update = patch => { setDraft(current => ({ ...current, ...patch })); setError(''); };
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    const fail = (message, field) => { setError(message); form.current?.elements.namedItem(field)?.focus(); };
    if (draft.billingMode === 'own_key') {
      try {
        const endpoint = new URL(draft.endpoint.trim());
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.replace(/\/$/, '').endsWith('/chat/completions')) throw new Error();
      } catch { fail('请填写完整的 HTTPS 对话接口地址，以 /chat/completions 结尾，且不含查询参数。', 'tavern-endpoint'); return; }
      if (!draft.apiKey.trim()) { fail('请输入你自己的 API Key。', 'tavern-key'); return; }
      if (!draft.model.trim()) { fail('请填写服务商提供的文字模型名称。', 'tavern-model'); return; }
    }
    if (!Number.isFinite(Number(draft.temperature)) || Number(draft.temperature) < 0 || Number(draft.temperature) > 2) { fail('创作温度需在 0 到 2 之间。', 'tavern-temperature'); return; }
    if (!Number.isInteger(Number(draft.maxTokens)) || Number(draft.maxTokens) < 128 || Number(draft.maxTokens) > 4096) { fail('回复长度上限需填写 128 到 4096 之间的整数。', 'tavern-tokens'); return; }
    try {
      setBusy(true); setError('');
      await onSave({ billingMode: draft.billingMode, endpoint: draft.endpoint.trim(), apiKey: draft.apiKey.trim(), model: draft.billingMode === 'platform' ? 'deepseek-v4.1-flash' : draft.model.trim(), ownEndpoint: draft.endpoint.trim(), ownModel: draft.model.trim(), temperature: Number(draft.temperature), maxTokens: Number(draft.maxTokens) });
    } catch (reason) { setError(reason.message || '设置未能保存，请重试。'); }
    finally { setBusy(false); }
  };
  return <TavernDialog title="对话服务" eyebrow="CONNECTION" icon={Settings2} onClose={() => !busy && onClose()} className="tv-settings-dialog">
    <form ref={form} className="tv-dialog-form" onSubmit={submit}><div className="tv-dialog-body">
      <fieldset className="tv-mode-options"><legend className="tv-field-label">选择使用方式</legend>
        {[{ id: 'platform', title: '平台积分', note: '使用平台提供的文字模型', Icon: Sparkles }, { id: 'own_key', title: '自带 API Key', note: '使用自己的模型服务', Icon: KeyRound }].map(({ id, title, note, Icon }) => <label key={id} className={`tv-mode-option${draft.billingMode === id ? ' is-selected' : ''}`}><input type="radio" name="tavern-billing-mode" value={id} checked={draft.billingMode === id} onChange={() => update({ billingMode: id })} disabled={busy} /><Icon size={20} strokeWidth={1.6} /><span><strong>{title}</strong><small>{note}</small></span><span className="tv-radio-mark">{draft.billingMode === id && <Check size={12} />}</span></label>)}
      </fieldset>
      {draft.billingMode === 'platform' ? <><div className="tv-platform-info tv-platform-pricing-intro"><span className="tv-provider-monogram"><Cpu size={24} /></span><div><small>PLATFORM SERVICE</small><h3>平台积分服务</h3><p>{platformReady ? '平台服务已接入。登录后使用账户积分，按实际 Token 用量结算。' : service ? '平台对话服务待开放，接入后可使用账户积分。' : '正在读取平台服务状态。'}</p></div><span className="tv-status-label">{platformReady ? '可用' : service ? '待开放' : '读取中'}</span></div><TavernPlatformPricing pricing={service?.pricing} /></> : <div className="tv-connection-fields">
        <Field label="对话接口地址" hint="填写支持 OpenAI 兼容对话格式的完整地址。"><input name="tavern-endpoint" type="url" required maxLength={1000} value={draft.endpoint} onChange={event => update({ endpoint: event.target.value })} placeholder="例如：https://api.example.com/v1/chat/completions" autoComplete="off" spellCheck={false} disabled={busy} /></Field>
        <Field label="API Key" hint="仅用于当前浏览器会话，不写入角色或聊天记录。"><span className="tv-secret-input"><input name="tavern-key" type={showKey ? 'text' : 'password'} required maxLength={2048} value={draft.apiKey} onChange={event => update({ apiKey: event.target.value })} placeholder="粘贴你的 API Key" autoComplete="off" spellCheck={false} disabled={busy} /><button type="button" className="tv-icon-button" onClick={() => setShowKey(current => !current)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey}>{showKey ? <EyeOff size={18} /> : <Eye size={18} />}</button></span></Field>
        <Field label="文字模型"><input name="tavern-model" required maxLength={120} value={draft.model} onChange={event => update({ model: event.target.value })} placeholder="例如：your-model-name" autoComplete="off" spellCheck={false} disabled={busy} /></Field>
        <p className="tv-service-note"><KeyRound size={15} />自带 Key 不扣网站积分，服务商按实际调用收费。</p>
      </div>}
      <section className="tv-language-note" aria-label="默认回复语言"><div><span>默认回复语言</span><strong>简体中文</strong></div><p>后续 AI 回复默认使用简体中文。导入的设定与开场白保留原文，可在编辑角色中修改。</p></section>
      <details className="tv-disclosure"><summary><Settings2 size={16} /><span>回复偏好</span><ChevronDown size={16} /></summary><div className="tv-disclosure-body tv-two-fields"><Field label="创作温度" hint="较低更稳定，较高更有变化。"><input name="tavern-temperature" type="number" min="0" max="2" step="0.1" value={draft.temperature} onChange={event => update({ temperature: event.target.value })} disabled={busy} /></Field><Field label="回复长度上限" hint="128–4096 Token，受模型能力限制。"><input name="tavern-tokens" type="number" min="128" max="4096" step="1" value={draft.maxTokens} onChange={event => update({ maxTokens: event.target.value })} disabled={busy} /></Field></div></details>
      {error && <p className="tv-form-error" role="alert">{error}</p>}
    </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy}>{busy ? <Loader2 size={16} className="tv-spin" /> : <Check size={16} />}{busy ? '保存中…' : '保存设置'}</button></footer></form>
  </TavernDialog>;
}

export function TavernImportDialog({ kind = 'character', onImport, onClose }) {
  const isLore = kind === 'lorebook';
  const noun = isLore ? '世界书' : '角色卡';
  const [source, setSource] = useState('file');
  const [file, setFile] = useState(null);
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const job = useRef(null);
  const alive = useRef(true);
  const previewRef = useRef(null);
  const urlRef = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; job.current?.abort(); }; }, []);
  useEffect(() => { if (preview) previewRef.current?.focus(); }, [preview]);
  const resetPreview = () => { setPreview(null); setError(''); setStatus(''); };
  const cancelRead = () => {
    job.current?.abort(); job.current = null;
    setBusy(''); setStatus('已取消读取，可以重新选择文件或链接。');
  };
  const dismiss = () => { if (busy === 'saving') return; job.current?.abort(); onClose(); };
  const readSource = async () => {
    if (job.current || busy) return;
    resetPreview();
    if (source === 'file' && !file) { setError('请先选择要导入的 JSON 或 PNG 文件。'); return; }
    if (source === 'url') {
      try {
        const target = new URL(url.trim());
        if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error();
      } catch { setError('请填写有效的公开 HTTPS 下载链接，不要包含账号、密码或片段标记。'); urlRef.current?.focus(); return; }
    }
    const request = new AbortController(); job.current = request;
    setBusy('reading');
    try {
      const selected = source === 'file' ? file : await requestTavernImport({ url: url.trim(), kind, signal: request.signal });
      if (!selected?.size || selected.size > TAVERN_MAX_IMAGE_BYTES) throw new Error('请选择非空文件：JSON 最大 1 MB，PNG 最大 8 MB。');
      const parsed = isLore ? await parseLorebookFile(selected) : await parseCharacterFile(selected);
      if (request.signal.aborted || !alive.current || job.current !== request) return;
      setPreview(parsed); setStatus('已读取，请核对内容后确认导入。');
    } catch (reason) {
      if (alive.current && job.current === request && !request.signal.aborted) setError(reason.message || '读取失败，请检查文件或下载链接。');
    } finally {
      if (job.current === request) { job.current = null; if (alive.current) setBusy(''); }
    }
  };
  const confirm = async event => {
    event.preventDefault();
    if (busy || job.current) return;
    if (!preview) { await readSource(); return; }
    const request = new AbortController(); job.current = request;
    setBusy('saving'); setError('');
    try { await onImport(preview); }
    catch (reason) { if (alive.current) setError(reason.message || '导入失败，请重试。'); }
    finally { if (job.current === request) { job.current = null; if (alive.current) setBusy(''); } }
  };
  const importedEntries = preview ? (isLore ? preview.entries : preview.loreEntries) || [] : [];
  const warnings = Array.isArray(preview?.warnings) ? preview.warnings : [];
  return <TavernDialog title={`导入${noun}`} eyebrow="BRING YOUR OWN STORY" icon={isLore ? BookOpen : FileUp} onClose={dismiss} className="tv-import-dialog">
    <form className="tv-dialog-form" onSubmit={confirm} noValidate>
      <div className="tv-dialog-body">
        <div className="tv-import-switch" role="group" aria-label="导入方式">
          {[['file', '本地文件', FileUp], ['url', '公开链接', Link2]].map(([value, label, Icon]) => <button key={value} type="button" aria-pressed={source === value} disabled={Boolean(busy)} onClick={() => { if (source !== value) { setSource(value); setFile(null); resetPreview(); } }}><Icon size={16} />{label}</button>)}
        </div>
        {source === 'file' ? <Field label={`${noun}文件`} hint={isLore ? '支持独立世界书 JSON，或内嵌世界书的角色 PNG。JSON 最大 1 MB，PNG 最大 8 MB。' : '支持角色 JSON，或包含角色资料的 PNG 卡片。JSON 最大 1 MB，PNG 最大 8 MB；普通图片无法作为角色卡导入。'}><input data-initial-focus type="file" accept=".json,.png,application/json,image/png" disabled={Boolean(busy)} onChange={event => { setFile(event.target.files?.[0] || null); resetPreview(); }} /></Field> : <Field label="公开下载链接" hint="支持公开 JSON / PNG 下载直链，或 Chub 角色 / 世界书详情页。不支持主页、搜索列表及需要登录的资源；无需填写 API Key。"><input ref={urlRef} type="url" maxLength={4096} value={url} disabled={Boolean(busy)} onChange={event => { setUrl(event.target.value); resetPreview(); }} placeholder={isLore ? 'https://chub.ai/lorebooks/作者/名称' : 'https://chub.ai/characters/作者/名称'} autoComplete="off" spellCheck={false} /></Field>}
        <div className="tv-import-compatibility"><BookOpen size={16} /><p>{isLore ? '导入名称、关键词、设定内容及启用状态。支持常驻条目；高级触发规则、脚本与插件行为不在本次兼容范围。' : '导入角色设定、开场白、示例对话及内嵌世界书。支持 Character Card V2 / V3 的基础字段；脚本与插件不会执行。'}</p></div>
        {!isLore && <p className="tv-import-language">后续 AI 回复默认使用简体中文；导入的设定与开场白保留原文，可在编辑角色中修改。</p>}
        {preview && <section className="tv-import-preview" ref={previewRef} tabIndex={-1} aria-label="待导入内容预览"><div className="tv-import-preview-heading">{!isLore && preview.avatar ? <img src={preview.avatar} alt="待导入角色头像" /> : <span className="tv-import-preview-icon">{isLore ? <BookOpen size={23} /> : <UserRound size={23} />}</span>}<div><span>待导入{noun}</span><h3>{preview.name}</h3><p>{isLore ? `${importedEntries.length} 条世界书设定` : `1 位角色 · ${importedEntries.length} 条内嵌世界书设定`}</p></div></div>
          {!isLore && <dl className="tv-import-character-stats" aria-label="已识别角色资料"><div><dt>人物设定</dt><dd>{(preview.description?.length || 0).toLocaleString('zh-CN')} 字符</dd></div><div><dt>标签</dt><dd>{preview.tags?.length || 0} 个</dd></div><div><dt>备用开场</dt><dd>{(preview.alternateGreetings || []).filter(item => item.trim()).length} 条非空</dd></div><div><dt>世界书</dt><dd>{importedEntries.length} 条</dd></div><div><dt>作者备注</dt><dd>{preview.creatorNotes?.trim() ? '有' : '无'}</dd></div></dl>}
          {!isLore && preview.description && <p className="tv-import-description">{preview.description}</p>}
          {importedEntries.length > 0 && <div className="tv-import-entry-list"><span>包含的设定</span><ul>{importedEntries.slice(0, 5).map(item => <li key={item.id}>{item.name || '未命名设定'}{!item.enabled && <small>未启用</small>}</li>)}</ul>{importedEntries.length > 5 && <p>另有 {importedEntries.length - 5} 条，将完整导入。</p>}</div>}
          {warnings.length > 0 && <div className="tv-import-warnings"><strong>兼容提醒</strong><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        </section>}
        {error && <p className="tv-form-error" role="alert">{error}</p>}
        <p className="tv-import-status" role="status">{busy === 'reading' ? (source === 'url' ? '正在下载并检查内容…' : '正在检查文件内容…') : status}</p>
      </div>
      <footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" onClick={busy === 'reading' ? cancelRead : dismiss} disabled={busy === 'saving'}>{busy === 'reading' ? '取消读取' : '取消'}</button><button type="submit" className="tv-button tv-button-primary" disabled={Boolean(busy)}>{busy ? <Loader2 size={16} className="tv-spin" /> : preview ? <Check size={16} /> : <FileUp size={16} />}{busy === 'saving' ? '正在导入…' : busy === 'reading' ? '正在读取…' : preview ? '确认导入' : '读取并预览'}</button></footer>
    </form>
  </TavernDialog>;
}

const EMPTY_LORE = { id: '', name: '', keys: [], content: '', enabled: true, constant: false };

export function TavernContextPanel({ session, onChange, onClose, busy: externalBusy = false, onSummarize, onRestoreSummary, onEditSummary, onSettingsChange, contextStatus }) {
  const [contextDraft, setContextDraft] = useState(String(session.contextChars ?? 48000));
  useEffect(() => setContextDraft(String(session.contextChars ?? 48000)), [session.id, session.contextChars]);
  const [tab, setTab] = useState('persona');
  const [persona, setPersona] = useState(session.persona || '');
  const [memory, setMemory] = useState(session.memory || '');
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState(session.summary?.text || '');
  const [entry, setEntry] = useState(null);
  const [keys, setKeys] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [saving, setBusy] = useState(false);
  const [action, setAction] = useState('');
  const busy = externalBusy || saving;
  const [deleting, setDeleting] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [pendingLore, setPendingLore] = useState(null);
  const [importMode, setImportMode] = useState('append');
  const [importError, setImportError] = useState('');
  const timer = useRef(null);
  const panelId = useId();
  const tabsRef = useRef(null);
  const summaryInput = useRef(null);
  const summaryEditButton = useRef(null);
  const entries = session.loreEntries || [];
  useEffect(() => { setPersona(session.persona || ''); }, [session.id, session.persona]);
  useEffect(() => { setMemory(session.memory || ''); }, [session.id, session.memory]);
  useEffect(() => { setSummaryDraft(session.summary?.text || ''); setSummaryEditing(false); }, [session.id, session.summary?.text, session.summary?.throughMessageId, session.summary?.createdAt]);
  useEffect(() => { if (summaryEditing) summaryInput.current?.focus(); }, [summaryEditing]);
  useEffect(() => { setEntry(null); setError(''); setSaved(''); setDeleting(''); setImportOpen(false); setPendingLore(null); setImportError(''); }, [session.id]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = async patch => {
    if (busy) return false;
    try {
      setBusy(true); setError(''); setSaved('');
      await onChange({ ...session, ...patch });
      setSaved('已保存'); clearTimeout(timer.current); timer.current = setTimeout(() => setSaved(''), 2500);
      return true;
    } catch (reason) { setError(reason.message || '保存失败，请重试。'); return false; }
    finally { setBusy(false); }
  };
  const runAction = async (callback, name, success) => {
    if (busy || typeof callback !== 'function') return false;
    try { setBusy(true); setAction(name); setError(''); setSaved(''); clearTimeout(timer.current); const result = await callback(); if (result !== false) setSaved(success); return result !== false; }
    catch (reason) { setError(reason?.message || '操作未完成，请重试。'); return false; }
    finally { setBusy(false); setAction(''); }
  };
  const closeSummaryEditor = () => { setSummaryEditing(false); requestAnimationFrame(() => summaryEditButton.current?.focus()); };
  const saveSummaryEdit = async event => {
    event.preventDefault();
    if (busy || typeof onEditSummary !== 'function') return;
    if (!summaryDraft.trim()) { setError('摘要内容不能为空，请补充后保存。'); summaryInput.current?.focus(); return; }
    if (summaryDraft.length > 6000) { setError('摘要最多 6000 个字符，请精简后保存。'); return; }
    if (await runAction(() => onEditSummary(summaryDraft), 'edit-summary', '摘要修改已保存，自动整理已暂停')) closeSummaryEditor();
  };
  const editEntry = item => { setEntry({ ...item }); setKeys((item.keys || []).join('，')); setError(''); setDeleting(''); };
  const saveEntry = async event => {
    event.preventDefault();
    const parsedKeys = keys.split(/[,，]/).map(value => value.trim()).filter(Boolean);
    if (!entry.name.trim() || !entry.content.trim()) { setError('请填写条目名称与设定内容。'); return; }
    if (!entry.constant && !parsedKeys.length) { setError('请添加触发关键词，或选择始终带入对话。'); return; }
    if (parsedKeys.length > 20 || parsedKeys.some(value => value.length > 80)) { setError('每条最多 20 个关键词，每个关键词最多 80 字。'); return; }
    if (!entry.id && entries.length >= 30) { setError('每段对话最多保存 30 条世界书设定。'); return; }
    const next = { ...entry, id: entry.id || crypto.randomUUID(), name: entry.name.trim(), content: entry.content.trim(), keys: [...new Set(parsedKeys)] };
    if (await commit({ loreEntries: entry.id ? entries.map(item => item.id === entry.id ? next : item) : [...entries, next] })) setEntry(null);
  };
  const importLore = async () => {
    if (!pendingLore || busy) return;
    const count = pendingLore.entries.length + (importMode === 'append' ? entries.length : 0);
    if (count > 30) { setImportError(`导入后将有 ${count} 条设定，超过 30 条上限。请选择替换，或先在源文件中精简内容。不会自动截断。`); return; }
    const incoming = pendingLore.entries.map(item => ({ ...item, id: crypto.randomUUID() }));
    if (await commit({ loreEntries: importMode === 'append' ? [...entries, ...incoming] : incoming })) { setPendingLore(null); setImportError(''); }
    else setImportError('世界书未能保存，请关闭导入窗口查看提示后重试。');
  };
  const downloadLore = () => {
    try {
      const name = `${session.title || '我的故事'} · 世界书`;
      const content = exportLorebook(entries, name.slice(0, 120));
      const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${name.replace(/[\\/:*?"<>|]/g, '_')}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(''); setSaved('已导出世界书 JSON'); clearTimeout(timer.current); timer.current = setTimeout(() => setSaved(''), 2500);
    } catch (reason) { setError(reason.message || '世界书导出失败，请重试。'); }
  };
  const tabs = [{ id: 'persona', name: '我的人设', Icon: UserRound }, { id: 'memory', name: '剧情记忆', Icon: Feather }, { id: 'lore', name: '世界书', Icon: BookOpen }];
  return <section className="tv-context" aria-label="故事设定">
    <header className="tv-context-head"><div><span className="tv-dialog-eyebrow">STORY NOTES</span><h2>让故事记得你</h2></div><button type="button" className="tv-icon-button" onClick={onClose} aria-label="关闭故事设定"><X size={18} /></button></header>
    <div className="tv-context-tabs" ref={tabsRef} role="tablist" aria-label="故事设定分类" onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); setTab(tabs[next].id); setError(''); tabsRef.current?.querySelectorAll('[role="tab"]')[next]?.focus();
    }}>{tabs.map(({ id, name, Icon }) => <button key={id} type="button" role="tab" id={`${panelId}-${id}`} aria-controls={`${panelId}-content`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => { setTab(id); setError(''); }}><Icon size={15} />{name}</button>)}</div>
    <div className="tv-context-body" role="tabpanel" id={`${panelId}-content`} aria-labelledby={`${panelId}-${tab}`} tabIndex={0}>
      {tab === 'persona' && <form onSubmit={event => { event.preventDefault(); commit({ persona }); }}><p className="tv-context-intro">先用这版身份开始聊天，也可以改成你自己的设定。</p><Field label="我在故事中的身份"><textarea maxLength={3000} rows={8} value={persona} onChange={event => { setPersona(event.target.value); setSaved(''); }} placeholder="写下你的称呼、性格，以及你和角色的关系。留空也可以开始对话。" disabled={busy} /></Field><p className="tv-field-hint">可以修改或清空，保存后仅应用于当前这段对话。</p><button type="submit" className="tv-button tv-button-secondary tv-context-save" disabled={busy}><Save size={15} />保存人设</button></form>}
      {tab === 'memory' && <><form onSubmit={event => { event.preventDefault(); commit({ memory }); }}><p className="tv-context-intro">记录初始状态，或补充对话中重要的经历与约定。</p><Field label="剧情摘要与重要记忆"><textarea maxLength={6000} rows={8} value={memory} onChange={event => { setMemory(event.target.value); setSaved(''); }} placeholder="例如：我们约定下一次一起去北方寻找消失的星群。她已经知道我害怕高处。" disabled={busy} /></Field><p className="tv-field-hint">保存后会随下一次对话带入模型。这里由你手动整理，不会被 AI 摘要覆盖。</p><button type="submit" className="tv-button tv-button-secondary tv-context-save" disabled={busy}><Save size={15} />保存记忆</button></form>
        <section className="tv-auto-memory" aria-label="自动剧情摘要"><h3><Sparkles size={16} />自动剧情摘要</h3><p className="tv-field-hint">整理剧情需要额外 API 调用，并计入 Token 用量。原聊天记录保留；AI 摘要可能遗漏细节，请核对内容。</p>
          {summaryEditing ? <form className="tv-summary-editor" onSubmit={saveSummaryEdit} noValidate><Field label="修改自动摘要" hint="最多 6000 个字符，不能为空。手工修改不发起 AI 调用；保存后暂停自动整理，并保留上一版供恢复。"><textarea ref={summaryInput} name="tavern-summary-edit" rows={8} maxLength={6000} value={summaryDraft} disabled={busy} onChange={event => { setSummaryDraft(event.target.value); setError(''); }} /></Field>{error && <p className="tv-form-error" role="alert">{error}</p>}<div className="tv-summary-editor-actions"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={() => { setError(''); closeSummaryEditor(); }}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy}>{action === 'edit-summary' ? <Loader2 size={15} className="tv-spin" /> : <Save size={15} />}保存摘要修改</button></div></form> : <><div className={`tv-auto-summary-text${session.summary?.text ? '' : ' is-empty'}`} tabIndex={0} aria-label="当前剧情摘要">{session.summary?.text || '还没有 AI 摘要，可以先聊一段，再整理剧情。'}</div>{session.summary?.text && <button ref={summaryEditButton} type="button" className="tv-button tv-button-secondary tv-summary-edit-trigger" disabled={busy || typeof onEditSummary !== 'function'} onClick={() => { setSummaryDraft(session.summary.text); setSummaryEditing(true); setError(''); setSaved(''); }}><Pencil size={15} />编辑摘要</button>}</>}
          <div className="tv-auto-memory-actions"><button type="button" className="tv-button tv-button-primary" disabled={busy || summaryEditing || typeof onSummarize !== 'function'} onClick={() => runAction(onSummarize, 'summary', '剧情摘要已更新')}>{action === 'summary' ? <Loader2 size={15} className="tv-spin" /> : <Sparkles size={15} />}立即整理剧情</button><button type="button" className="tv-button tv-button-secondary" disabled={busy || summaryEditing || !session.summaryHistory?.length || typeof onRestoreSummary !== 'function'} onClick={() => runAction(onRestoreSummary, 'restore', '已恢复上一版摘要')}>恢复上一版摘要</button></div>
          <label className="tv-check-field"><input type="checkbox" checked={session.autoMemory === true} disabled={busy || summaryEditing || typeof onSettingsChange !== 'function'} onChange={event => { const autoMemory = event.target.checked; runAction(() => onSettingsChange({ autoMemory }), 'settings', '自动摘要设置已保存'); }} />自动整理剧情</label><p className="tv-field-hint">默认关闭。开启后可在需要时自动发起摘要调用，同样计入 Token 用量。</p>
        </section>
        <section className="tv-context-capacity" aria-label="上下文设置"><Field label="常用上下文档位" hint="默认48000字符，也可以在下方自定义；这是本站发送预算，不是模型Token上限。"><select name="tavern-context-chars" value={[12000,24000,48000,96000].includes(session.contextChars ?? 48000) ? session.contextChars ?? 48000 : "custom"} disabled={busy || typeof onSettingsChange !== 'function'} onChange={event => { if (event.target.value === "custom") return; const contextChars = Number(event.target.value); runAction(() => onSettingsChange({ contextChars }), 'settings', '上下文容量已保存'); }}><option value="custom">自定义容量</option>{[12000, 24000, 48000, 96000].map(value => <option key={value} value={value}>{value.toLocaleString('zh-CN')} 字符{value === 48000 ? '（默认）' : ''}</option>)}</select></Field><Field label="自定义上下文容量" hint="4000–120000字符；容量越大，每轮可能重发的历史越多，费用相应增加。请勿超过所用模型的实际限制。"><input name="tavern-custom-context" type="number" min="4000" max="120000" step="1" value={contextDraft} disabled={busy} onChange={event => setContextDraft(event.target.value)} /></Field><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={() => { const contextChars = Number(contextDraft); if (!isValidTavernContextChars(contextChars)) { setError('上下文容量须为4000–120000之间的整数。'); return; } runAction(() => onSettingsChange({ contextChars }), 'settings', '自定义上下文容量已保存'); }}>保存容量</button><TavernContextMeter status={contextStatus} /></section>
      </>}
      {tab === 'lore' && <>
        <p className="tv-context-intro">为人物、地点和事物补充设定，在相关话题出现时带入对话。</p>
        {entry ? <form className="tv-lore-editor" onSubmit={saveEntry}><Field label="条目名称"><input data-initial-focus required maxLength={80} value={entry.name} onChange={event => setEntry(current => ({ ...current, name: event.target.value }))} placeholder="例如：北境观星台" disabled={busy} /></Field><Field label="触发关键词" hint="用逗号分隔。"><input maxLength={1200} value={keys} onChange={event => setKeys(event.target.value)} placeholder="北境，观星台，星图" disabled={busy} /></Field><Field label="设定内容"><textarea required maxLength={3000} rows={5} value={entry.content} onChange={event => setEntry(current => ({ ...current, content: event.target.value }))} placeholder="描述这个设定，让角色知道它意味着什么。" disabled={busy} /></Field><label className="tv-check-field"><input type="checkbox" checked={entry.constant} onChange={event => setEntry(current => ({ ...current, constant: event.target.checked }))} disabled={busy} />始终带入对话</label><div className="tv-lore-actions"><button type="button" className="tv-button tv-button-secondary" onClick={() => { setEntry(null); setError(''); }} disabled={busy}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={busy}><Check size={15} />保存条目</button></div></form> : <>
          <div className="tv-lore-heading"><span>{entries.length} / 30 条设定</span><button type="button" className="tv-button tv-button-secondary" onClick={() => editEntry(EMPTY_LORE)} disabled={entries.length >= 30 || busy}><Plus size={16} />添加</button></div>
          <div className="tv-lore-file-actions"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={() => { setImportOpen(true); setError(''); }}><Upload size={15} />导入世界书</button><button type="button" className="tv-button tv-button-secondary" disabled={busy || !entries.length} onClick={downloadLore}><Download size={15} />导出世界书</button></div>
          {entries.length ? <ul className="tv-lore-list">{entries.map(item => <li key={item.id} className={item.enabled ? '' : 'is-disabled'}><div className="tv-lore-title"><label className="tv-check-field"><input type="checkbox" checked={item.enabled} disabled={busy} onChange={event => commit({ loreEntries: entries.map(value => value.id === item.id ? { ...value, enabled: event.target.checked } : value) })} /><strong>{item.name}</strong></label><button type="button" className="tv-icon-button" onClick={() => editEntry(item)} aria-label={`编辑${item.name}`} disabled={busy}><Pencil size={15} /></button><button type="button" className="tv-icon-button" onClick={() => setDeleting(item.id)} aria-label={`删除${item.name}`} disabled={busy}><Trash2 size={15} /></button></div><p className="tv-lore-keys">{item.constant ? '始终带入' : item.keys.join(' · ') || '未设置关键词'}</p><p className="tv-lore-preview">{item.content}</p>{deleting === item.id && <div className="tv-lore-delete" role="alert"><span>删除这条设定？</span><button type="button" className="tv-button tv-button-secondary" onClick={() => setDeleting('')} disabled={busy}>取消</button><button type="button" className="tv-button tv-button-danger" onClick={async () => { if (await commit({ loreEntries: entries.filter(value => value.id !== item.id) })) setDeleting(''); }} disabled={busy}>删除</button></div>}</li>)}</ul> : <div className="tv-lore-empty"><BookOpen size={30} strokeWidth={1.2} /><strong>每个世界，都从一个细节开始</strong><p>添加一处地点、一段往事，或一个只有你们知道的秘密。</p></div>}
        </>}
      </>}
      {error && !(tab === 'memory' && summaryEditing) && <p className="tv-form-error" role="alert">{error}</p>}
      <p className="tv-save-status" role="status">{action === 'summary' ? '正在整理剧情…' : externalBusy ? '正在等待对话服务…' : saving ? '正在保存…' : saved}</p>
    </div>
    {importOpen && <TavernImportDialog kind="lorebook" onClose={() => setImportOpen(false)} onImport={value => { setPendingLore(value); setImportMode('append'); setImportError(''); setImportOpen(false); }} />}
    {pendingLore && <TavernDialog title="将世界书带入这段故事" eyebrow="APPLY LOREBOOK" icon={BookOpen} onClose={() => !busy && setPendingLore(null)}>
      <div className="tv-dialog-body"><p className="tv-context-intro">「{pendingLore.name}」包含 {pendingLore.entries.length} 条设定；当前对话已有 {entries.length} 条。请选择应用方式。</p><fieldset className="tv-mode-options"><legend className="tv-field-label">导入到当前对话</legend>{[{ id: 'append', title: '追加到现有设定', note: `保留原有 ${entries.length} 条，共 ${entries.length + pendingLore.entries.length} 条` }, { id: 'replace', title: '替换全部设定', note: `移除原有 ${entries.length} 条，使用导入的 ${pendingLore.entries.length} 条` }].map(({ id, title, note }) => <label key={id} className={`tv-mode-option${importMode === id ? ' is-selected' : ''}`}><input type="radio" name="lore-import-mode" value={id} checked={importMode === id} onChange={() => { setImportMode(id); setImportError(''); }} disabled={busy} /><span><strong>{title}</strong><small>{note}</small></span><span className="tv-radio-mark">{importMode === id && <Check size={12} />}</span></label>)}</fieldset>
        <p className="tv-field-hint">最多保存 30 条设定。替换会移除当前对话的原有世界书，建议先导出备份；角色原始设定与聊天消息不受影响。</p>
        {importError && <p className="tv-form-error" role="alert">{importError}</p>}
      </div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" disabled={busy} onClick={() => setPendingLore(null)}>取消</button><button type="button" className={`tv-button ${importMode === 'replace' && entries.length ? 'tv-button-danger' : 'tv-button-primary'}`} disabled={busy} onClick={importLore}>{busy ? <Loader2 size={16} className="tv-spin" /> : <Check size={16} />}{busy ? '正在保存…' : importMode === 'replace' ? '确认替换全部设定' : '确认追加设定'}</button></footer>
    </TavernDialog>}
  </section>;
}
