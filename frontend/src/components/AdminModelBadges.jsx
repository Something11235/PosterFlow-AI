import {useCallback, useEffect, useId, useRef, useState} from 'react';
import {RefreshCw, Save, Tags} from 'lucide-react';
import {MODEL_BADGE_GROUPS,MODEL_BADGE_OPTIONS} from '../lib/modelBadgeCatalog';
import {BADGE_LABELS, parseModelBadges, publishModelBadges} from '../lib/modelBadges';
import ModelBadge from './ModelBadge';
import ModelPicker from './ModelPicker';

export default function AdminModelBadges({authHeaders}) {
  const editorId = useId();
  const [modelType,setModelType]=useState('image');
  const [selectedModel, setSelectedModel] = useState(MODEL_BADGE_OPTIONS[0].value);
  const options=MODEL_BADGE_GROUPS.find(group=>group.value===modelType).options;
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [conflict, setConflict] = useState(false);
  const active = useRef(null);
  const dirty = saved && MODEL_BADGE_OPTIONS.some(model => draft[model.value] !== saved.badges[model.value]);

  const load = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/admin/model-badges', {headers: authHeaders, credentials: 'include', cache: 'no-store', signal: controller.signal});
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || '模型角标加载失败，请重新加载。');
      const next = parseModelBadges(data);
      if (next.revision < 1) throw new Error('模型角标尚未配置，请稍后重新加载。');
      setSaved(next);
      setDraft(next.badges);
      setConflict(false);
      publishModelBadges(next);
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason.message || '模型角标加载失败。');
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  }, [authHeaders]);

  useEffect(() => {
    setSaved(null);
    setDraft({});
    void load();
    return () => { active.current?.abort(); active.current = null; };
  }, [load]);

  const save = async event => {
    event.preventDefault();
    if (!dirty || busy || conflict) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/admin/model-badges', {
        method: 'POST', headers: {...authHeaders, 'Content-Type': 'application/json'}, credentials: 'include', signal: controller.signal,
        body: JSON.stringify({revision: saved.revision, badges: draft}),
      });
      const data = await response.json();
      if (controller.signal.aborted) return;
      if (response.status === 409) setConflict(true);
      if (!response.ok) throw new Error(data.error || '模型角标保存失败，请重试。');
      const next = parseModelBadges(data);
      if (next.revision <= saved.revision) throw new Error('未收到有效保存结果，请重新加载确认。');
      setSaved(next);
      setDraft(next.badges);
      publishModelBadges(next);
      setSuccess('角标已保存。其他用户将在刷新页面或稍后自动更新时看到。');
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason.message || '模型角标保存失败。');
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  };

  return <section className="mt-5 rounded-lg border border-border-subtle bg-bg-tertiary" aria-labelledby="model-badges-heading">
    <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-3">
      <Tags size={16} className="text-accent"/><h3 id="model-badges-heading" className="text-sm font-semibold text-text-primary">模型角标</h3>
      <button type="button" onClick={load} disabled={busy} className="ml-auto inline-flex min-h-10 items-center gap-1 rounded px-2 text-xs text-accent disabled:opacity-50"><RefreshCw size={14}/>{dirty ? '重新加载并放弃修改' : '重新加载角标'}</button>
    </div>
    <form onSubmit={save} className="p-4">
      <p className="mb-3 text-xs leading-5 text-text-muted">设置图片、音乐和视频模型名称后面的红色提示，同步显示在各自的模型选择器与模型一览中。</p>
      {error && <p role="alert" className="mb-3 rounded-md border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-400">{error}</p>}
      {success && <p role="status" className="mb-3 text-sm text-mint">{success}</p>}
      {!saved ? <p className="py-4 text-sm text-text-muted">{busy ? '正在加载角标…' : '加载后即可编辑。'}</p> : <div className="grid grid-cols-[minmax(0,1fr)_90px] items-end gap-3 sm:grid-cols-[130px_minmax(0,1fr)_110px]">
        <div className="col-span-2 sm:col-span-1"><label htmlFor={`${editorId}-type`} className="mb-2 block text-xs text-text-secondary">模型类型</label><select id={`${editorId}-type`} value={modelType} disabled={busy} onChange={event=>{const group=MODEL_BADGE_GROUPS.find(item=>item.value===event.target.value);setModelType(group.value);setSelectedModel(group.options[0].value);}} className="min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary disabled:opacity-50">{MODEL_BADGE_GROUPS.map(group=><option key={group.value} value={group.value}>{group.label}</option>)}</select></div>
        <div className="min-w-0"><label htmlFor={`${editorId}-model`} className="mb-2 block text-xs text-text-secondary">选择模型</label>
          <ModelPicker id={`${editorId}-model`} options={options} value={selectedModel} onChange={setSelectedModel} badges={draft} disabled={busy}/>
        </div>
        <div><label htmlFor={`${editorId}-badge`} className="mb-2 block text-xs text-text-secondary">角标</label>
          <select id={`${editorId}-badge`} aria-label="当前模型角标" value={draft[selectedModel] || ''} disabled={busy || conflict} onChange={event => {setDraft(current => ({...current, [selectedModel]: event.target.value}));setSuccess('');}} className="min-h-11 w-full rounded-md border border-border-default bg-bg-primary px-3 text-sm text-text-primary disabled:opacity-50">
            {Object.entries(BADGE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
      </div>}
      {saved && <p className="mt-3 text-xs text-text-muted">预览：{MODEL_BADGE_OPTIONS.find(model => model.value === selectedModel)?.label}<ModelBadge value={draft[selectedModel] || ''}/>{dirty && <span className="ml-2 text-gold">有未保存的修改</span>}</p>}
      <button type="submit" disabled={!dirty || busy || conflict} className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-accent/35 bg-accent/10 px-4 text-sm font-medium text-accent disabled:opacity-50"><Save size={15}/>{busy && saved ? '正在保存…' : '保存模型角标'}</button>
    </form>
  </section>;
}
