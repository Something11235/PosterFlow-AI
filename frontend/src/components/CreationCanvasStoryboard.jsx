import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronDown, Clapperboard, FileText, Film, Image as ImageIcon, ListChecks, Plus, Sparkles, Trash2, WandSparkles, X } from "lucide-react";
import { displayCredits } from "../lib/credits";
import { canvasTextReceipt } from "../lib/creationCanvasText";
import {
  addStoryboardShots, getShotNodes, getShotQuote, getStoryboard, moveStoryboardShot, removeStoryboardShot, repairStoryboardShot,
  setShotModel, setShotParam, setShotPrompt, setShotReference, setStoryboardScript, storyboardPlan, updateStoryboardShot,
} from "../lib/creationCanvasStoryboard";
import CanvasNodeParameters from "./CanvasNodeParameters";
import useCanvasNodeMedia from "./useCanvasNodeMedia";
import "./creationCanvasStoryboard.css";

const modes = { image: "分镜图", video: "视频" };
const assistLabels = { draft: "AI 助写", polish: "润色", complete: "补全" };
const seq = value => String(value).padStart(2, "0");
const runLabel = node => ({pending: "处理中", completed: "已完成", failed: "未完成"}[node?.run?.status] || "待生成");

function price(quote) {
  if (quote?.billingMode === "own_key") return "自带 Key";
  return Number.isFinite(quote?.credits) ? displayCredits(quote.credits) + " 积分" : "待核价";
}

function quoteDescription(quote, kind) {
  if (!quote) return "";
  const setting = key => quote.controls?.find(control => control.key === key)?.effectiveValue ?? quote.params?.[key];
  const length = setting("duration");
  return [quote.options?.find(option => option.value === quote.model)?.label || quote.model, setting("resolution"),
    kind === "video" && (length > 0 ? length + " 秒" : "自动时长")].filter(Boolean).join(" · ");
}

// Keep composition and the cursor intact while IndexedDB acknowledges earlier keystrokes.
function DraftField({ label, value = "", onChange, multiline, ...props }) {
  const field = useRef(null);
  useEffect(() => {
    if (field.current && document.activeElement !== field.current) field.current.value = value;
  }, [value]);
  const Tag = multiline ? "textarea" : "input";
  return <label className="cs-field"><span>{label}</span>
    <Tag ref={field} defaultValue={value} onChange={event => onChange(event.target.value)} {...props}/>
  </label>;
}

function ShotMedia({ owner, projectId, node, kind }) {
  const media = useCanvasNodeMedia(owner, projectId, node);
  if (!media || node.run?.status !== "completed") return null;
  return <div className="cs-media">{kind === "video"
    ? <video controls playsInline preload="metadata" src={media} aria-label={node.title}/>
    : <img src={media} alt={node.title} loading="lazy"/>}</div>;
}

function ShotThumbnail({ owner, projectId, node }) {
  const media = useCanvasNodeMedia(owner, projectId, node);
  return media ? <img className="cs-thumb" alt="" loading="lazy" src={media}/> : null;
}

function PromptProposal({ proposal, project, context, onApply, onDismiss, busy }) {
  const { input } = proposal;
  const receipt = canvasTextReceipt(proposal);
  const split = input.action === "split";
  const shots = getStoryboard(project).shots;
  const target = shots.find(shot => shot.id === input.shotId);
  const targetPrompt = target && getShotNodes(project, target)[input.kind + "Prompt"];
  const hasTarget = split || Boolean(targetPrompt);
  const changed = targetPrompt && (targetPrompt.text || "") !== (input.text || "");
  function apply() {
    onApply(current => {
      if (split) return addStoryboardShots(current, proposal.shots, context, proposal.id);
      const currentShot = getStoryboard(current).shots.find(shot => shot.id === input.shotId);
      const currentPrompt = currentShot && getShotNodes(current, currentShot)[input.kind + "Prompt"];
      if (!currentPrompt) throw new Error("这个提示词节点已移除。");
      if ((currentPrompt.text || "") !== (targetPrompt.text || "")) throw new Error("提示词刚刚更新，请核对后再采纳。");
      return setShotPrompt(current, currentShot.id, input.kind, proposal.text);
    });
  }
  return <section className="cs-proposal" aria-label="AI 建议">
    <header><span className="cs-symbol"><Sparkles size={17}/></span><h3>{split ? "分镜草案" : "提示词建议"}</h3>
      <small>{split ? (proposal.shots?.length || 0) + " 镜" : (target?.title || "已移除的镜头") + " · " + modes[input.kind]}</small>
    </header>
    {receipt && <small>{receipt}</small>}
    {split ? <ol>{proposal.shots?.map((shot, index) => <li key={index}>
      <div><strong>{shot.title}</strong>{shot.duration > 0 && <small>{shot.duration} 秒</small>}</div>
      <p>{shot.description}</p>
      {(shot.camera || shot.imagePrompt || shot.videoPrompt) && <details><summary>查看镜头设计</summary>
        {shot.camera && <p>运镜 · {shot.camera}</p>}{shot.imagePrompt && <p>分镜图 · {shot.imagePrompt}</p>}{shot.videoPrompt && <p>视频 · {shot.videoPrompt}</p>}
      </details>}
    </li>)}</ol> : <p className="cs-suggestion-text">{proposal.text}</p>}
    {!split && !hasTarget && <p role="status">原镜头或提示词节点已移除。</p>}
    {changed && <p role="status">当前提示词已编辑，采纳后会替换为这段建议。</p>}
    <footer><button type="button" onClick={onDismiss} disabled={busy}>舍弃</button>
      <button type="button" className="cs-accent" onClick={apply} disabled={busy || !hasTarget}><Check size={15}/>{split ? "将草案加入分镜" : "采纳提示词"}</button>
    </footer>
  </section>;
}

function GenerateReview({ snapshot, latest, working, onConfirm, onClose }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    if (!dialog.current.open) dialog.current.showModal();
    return () => previous?.focus?.({preventScroll:true});
  }, []);
  const { plan, kind } = snapshot;
  const changed = latest.signature !== plan.signature;
  const label = modes[kind];
  const blocked = plan.items.some(item => item.error);
  const ownKey = plan.items.every(item => item.quote?.billingMode === "own_key");
  return <dialog ref={dialog} className="cc-dialog cs-review" aria-label="确认生成清单"
    onCancel={event => { event.preventDefault(); if (!working) onClose(); }}>
    <header><h2>确认生成清单</h2><button type="button" onClick={onClose} disabled={working} aria-label="关闭生成清单"><X size={18}/></button></header>
    <p>本次将为 {plan.items.length} 个镜头生成{label}。</p>
    <ul>{plan.items.map(item => <li key={item.shotId}><div><strong>{item.title || "未命名镜头"}</strong>
      <small>{quoteDescription(item.quote, kind)}</small>
      {item.error && <span className="cs-error">{item.error}</span>}</div><b>{item.error ? "待处理" : price(item.quote)}</b></li>)}</ul>
    <div className="cs-total"><span>预计合计</span><strong>{blocked ? "待核价" : ownKey ? "自带 Key" : displayCredits(plan.credits) + " 积分"}</strong>
      {!blocked && !ownKey && plan.reservedCredits > plan.credits && <small>需预留 {displayCredits(plan.reservedCredits)} 积分</small>}
    </div>
    {changed && <p role="status">所选镜头或报价已更新，请返回重新查看清单。</p>}
    <footer><button type="button" onClick={onClose} disabled={working}>返回调整</button>
      <button type="button" className="cs-accent" disabled={blocked || changed || working} onClick={onConfirm}>{working ? "正在提交…" : "确认生成" + label}</button>
    </footer>
  </dialog>;
}

function ShotEditor({ project, owner, shot, index, context, kind, setKind, onEdit, onAssist, aiBusy }) {
  const nodes = getShotNodes(project, shot);
  const node = nodes[kind];
  const promptNode = nodes[kind + "Prompt"];
  const quote = getShotQuote(project, shot, kind, context);
  const durationControl = quote.controls.find(control => control.key === "duration");
  const duration = durationControl?.effectiveValue ?? quote.params?.duration;
  const pending = node?.run?.status === "pending";
  const connected = new Set(project.edges.filter(edge => edge.to === node?.id).map(edge => edge.from));
  const needsRepair = !node || !promptNode || !connected.has(promptNode.id);
  const referenceOptions = project.nodes.filter(item => item.id !== node?.id && item.type !== "prompt" &&
    (connected.has(item.id) || ((kind === "video" || ["image","reference","frame"].includes(item.type)) &&
      (item.run ? item.run.status === "completed" : item.assetId || item.url) &&
      (kind === "video" || !item.assetKind || item.assetKind === "image"))));
  const update = fields => onEdit(current => updateStoryboardShot(current, shot.id, fields));
  const assist = action => onAssist({
    action, kind, shotId:shot.id, text:promptNode?.text || "", script:getStoryboard(project).script,
    target_model:quote.model || "", context:[shot.title,shot.description,shot.camera].filter(Boolean).join("\n"),
  });
  return <section className="cs-edit" aria-label={"编辑镜头 " + (index + 1)}>
    <header className="cs-edit-head"><div><Clapperboard size={18}/><h3>镜头 {seq(index + 1)}</h3></div><span>{runLabel(node)}</span></header>
    <div className="cs-edit-body">
      <div className="cs-shot-writing">
        <DraftField label="镜头名称" maxLength={120} value={shot.title} onChange={title => update({title})} placeholder="给这个镜头起个名字"/>
        <DraftField label="镜头与运镜" maxLength={500} value={shot.camera} onChange={camera => update({camera})} placeholder="例如，近景，镜头缓慢推向人物"/>
      </div>
      <DraftField label="画面描述" multiline rows={2} maxLength={2000} value={shot.description} onChange={description => update({description})}
        placeholder="谁在什么地方，正在发生什么？"/>
      <div className="cs-mode" role="group" aria-label="镜头生成类型">{Object.keys(modes).map(type => {
        const Icon = type === "image" ? ImageIcon : Film;
        return <button key={type} type="button" aria-pressed={kind === type} onClick={() => setKind(type)}><Icon size={15}/>{modes[type]}</button>;
      })}</div>
      {node && promptNode ? <div className="cs-kind-fields" key={kind}>
        <div className="cs-prompt">
          <DraftField label={modes[kind] + "提示词"} multiline rows={3} value={promptNode.text || ""} disabled={pending} maxLength={6000}
            onChange={text => onEdit(current => setShotPrompt(current, shot.id, kind, text))}
            placeholder={kind === "image" ? "描述主体、构图、光线与风格…" : "描述人物动作、镜头运动与节奏…"}/>
          <div className="cs-assist-actions">{Object.entries(assistLabels).map(([action,label]) => <button type="button" key={action}
            disabled={pending || aiBusy || (action !== "draft" && !promptNode.text?.trim())}
            onClick={() => assist(action)}>{action === "draft" && <WandSparkles size={14}/>} {label}</button>)}<small>按实际 Token 计费</small></div>
        </div>
        <div className="cs-setup"><label className="cs-field"><span>{modes[kind]}模型</span><select value={quote.model || ""} disabled={pending || !quote.options?.length}
          onChange={event => { const model = event.target.value; onEdit(current => setShotModel(current, shot.id, kind, model, context)); }}>
          {!quote.options?.some(option => option.value === quote.model) && <option value={quote.model || ""}>{quote.model || "选择模型"}</option>}
          {quote.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <CanvasNodeParameters title={(shot.title || "当前镜头") + " · " + modes[kind]} quote={quote} disabled={pending}
          onChange={(key,value) => onEdit(current => setShotParam(current, shot.id, kind, key, value, context))}/>
        </div>
        {kind === "video" && shot.suggestedDuration > 0 && <p className="cs-note">剧本建议 {shot.suggestedDuration} 秒
          {duration !== shot.suggestedDuration && <> · 本次按{duration > 0 ? duration + " 秒生成" : "模型自动时长生成"}</>}</p>}
        <details className="cs-refs"><summary><span>画布参考素材</span><small>{[...connected].filter(id => project.nodes.some(n => n.id === id && n.type !== "prompt")).length} 份</small></summary>
          {referenceOptions.length ? referenceOptions.map(item => <label key={item.id}><input type="checkbox" checked={connected.has(item.id)} disabled={pending}
            onChange={event => { const enabled = event.target.checked; onEdit(current => setShotReference(current, shot.id, kind, item.id, enabled, context)); }}/>
            {item.filename || item.title}{item.id === shot.imageNodeId && "（本镜分镜图）"}</label>) : <p>可在节点画布添加参考素材，或先生成分镜图。</p>}
        </details>
        <div className="cs-shot-quote"><span>本镜预计</span><b>{quote.error ? "待核价" : price(quote)}</b>
          {!quote.error && quote.reservedCredits > quote.credits && <small>预留 {displayCredits(quote.reservedCredits)} 积分</small>}</div>
        {(quote.error || node.run?.message) && <p className="cs-note" role="status">{quote.error || node.run.message}</p>}
        <ShotMedia owner={owner} projectId={project.id} node={node} kind={kind}/>
      </div> : null}
      {needsRepair && <button type="button" disabled={pending} onClick={() => onEdit(current => repairStoryboardShot(current, shot.id, context))}>恢复节点与提示词连接</button>}
    </div>
  </section>;
}

export default function CreationCanvasStoryboard({
  project, owner, generationContext, textConfigured, routeLabel, onEdit, onGenerate, onTextAction, onApplyProposal, onDismissProposal, onBack,
}) {
  const { script, shots } = getStoryboard(project);
  const [activeId, setActiveId] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [kind, setKind] = useState("image");
  const [shotCount, setShotCount] = useState("");
  const [review, setReview] = useState(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [removeId, setRemoveId] = useState(null);
  const [scriptOpen, setScriptOpen] = useState(!shots.length);
  const gate = useRef(false);
  const active = (activeId === "last" ? shots.at(-1) : shots.find(shot => shot.id === activeId)) || shots[0];
  const selectedIds = shots.filter(shot => chosen.includes(shot.id)).map(shot => shot.id);
  const plan = storyboardPlan(project, selectedIds, kind, generationContext);
  const problem = plan.items.some(item => item.error);
  const proposal = project.textProposal;
  const boardProposal = proposal && !proposal.input?.nodeId;
  const aiBusy = textConfigured === false || Boolean(working || project.textRequest || proposal);
  const summary = problem ? "待核价" : plan.items.length && plan.items.every(item => item.quote?.billingMode === "own_key")
    ? "自带 Key" : displayCredits(plan.credits) + " 积分";

  async function perform(label, work) {
    if (gate.current) return;
    gate.current = true;
    setWorking(label); setError("");
    try { await work(); }
    catch (failure) { setError(failure.message || "操作未完成，请重试。"); }
    finally { gate.current = false; setWorking(""); }
  }
  function requestText(input) {
    if (aiBusy) return;
    void perform("text", () => onTextAction(input));
  }
  function add() {
    void perform("add", async () => {
      await onEdit(current => addStoryboardShots(current, [{}], generationContext));
      setActiveId("last"); setRemoveId(null);
    });
  }
  function toggle(id) {
    setChosen(ids => ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]);
  }
  function confirmGeneration() {
    if (!review || review.plan.signature !== plan.signature) return;
    void perform("generate", async () => {
      setReview(null);
      await onGenerate(review);
    });
  }

  return <section className="cs-workbench" aria-label="分镜工作台">
    <header className="cs-titlebar">
      <div className="cs-heading"><span className="cs-symbol"><Clapperboard size={21}/></span><h2>分镜工作台</h2></div>
      {onBack && <button className="cs-back" type="button" onClick={onBack}><ArrowLeft size={15}/>返回节点画布</button>}
    </header>
    <div className="cs-body">
      <section className="cs-script">
        <button type="button" className="cs-script-toggle" aria-expanded={scriptOpen} onClick={() => setScriptOpen(open => !open)}>
          <FileText size={17}/><strong>创作剧本</strong>{!scriptOpen && script && <span>{script}</span>}<ChevronDown size={16}/></button>
        {scriptOpen && <div className="cs-script-body">
          <DraftField multiline label="剧本内容" maxLength={16000} value={script} onChange={text => onEdit(current => setStoryboardScript(current, text))}
            rows={3} placeholder="粘贴一段剧本或故事梗概，AI 可以把它拆成逐镜可编辑的草案。"/>
          <div className="cs-script-foot"><small>AI 拆镜按实际 Token 计费{routeLabel && <><br/>{routeLabel}</>}</small>
            <div className="cs-split-settings"><label>镜头数<select aria-label="拆分镜头数" value={shotCount} onChange={event => setShotCount(event.target.value)}>
              <option value="">自动</option>{Array.from({length:16},(_,i) => <option key={i+1} value={i+1}>{i+1} 镜</option>)}
            </select></label><button type="button" className="cs-accent" disabled={aiBusy || !script.trim()}
              onClick={() => requestText({action:"split",script,...(shotCount && {shot_count:Number(shotCount)})})}><Sparkles size={15}/>AI 拆镜</button></div></div>
        </div>}
      </section>
      {boardProposal && <PromptProposal proposal={proposal} project={project} context={generationContext}
        onApply={mutate => perform("apply", async () => { await onApplyProposal(mutate); if (proposal.input.action === "split") setScriptOpen(false); })}
        onDismiss={() => perform("discard", onDismissProposal)} busy={Boolean(working)}/>}
      {error && <p className="cs-error" role="alert">{error}</p>}
      <div className="cs-layout">
        <section className="cs-list-panel" aria-label="镜头列表">
          <header><div><h3>镜头列表</h3><span>{shots.length} 镜</span></div><button type="button" onClick={add} disabled={Boolean(working)}><Plus size={15}/>添加镜头</button></header>
          {shots.length ? <>
            <label className="cs-select-all"><input type="checkbox" checked={selectedIds.length === shots.length}
              ref={el => { if (el) el.indeterminate = Boolean(selectedIds.length && selectedIds.length < shots.length); }}
              onChange={event => setChosen(event.target.checked ? shots.map(shot => shot.id) : [])}/>全选镜头</label>
            <ol className="cs-shot-list">{shots.map((shot,i) => {
              const shotNodes = getShotNodes(project, shot);
              return <li key={shot.id} className={active?.id === shot.id ? "cs-active-shot" : undefined}>
                <input type="checkbox" aria-label={"选择镜头 " + (i + 1)} checked={chosen.includes(shot.id)} onChange={() => toggle(shot.id)}/>
                <button type="button" className="cs-select-shot" aria-current={active?.id === shot.id ? "true" : undefined}
                  onClick={() => { setActiveId(shot.id); setRemoveId(null); }}>
                  <span className="cs-number">{seq(i + 1)}</span>
                  {shotNodes.image?.run?.status === "completed" && <ShotThumbnail owner={owner} projectId={project.id} node={shotNodes.image}/>}
                  <span className="cs-shot-name"><strong>{shot.title || "未命名镜头"}</strong>
                    <small>{shot.suggestedDuration > 0 && shot.suggestedDuration + " 秒 · "}图{runLabel(shotNodes.image)} · 视频{runLabel(shotNodes.video)}</small></span>
                </button>
              </li>;
            })}</ol>
          </> : <p className="cs-list-empty">拆解剧本后，镜头会按故事顺序显示在这里。也可以手动添加第一镜。</p>}
        </section>
        <div className="cs-detail-panel">
          {active ? <>
            <ShotEditor key={active.id} project={project} owner={owner} context={generationContext} shot={active}
              index={shots.indexOf(active)} kind={kind} setKind={setKind} onEdit={onEdit} onAssist={requestText} aiBusy={aiBusy}/>
            <div className="cs-shot-actions">
              <button type="button" disabled={active === shots[0]} onClick={() => { setActiveId(active.id); onEdit(current => moveStoryboardShot(current, active.id, -1)); }}><ArrowUp size={14}/>上移</button>
              <button type="button" disabled={active === shots.at(-1)} onClick={() => { setActiveId(active.id); onEdit(current => moveStoryboardShot(current, active.id, 1)); }}><ArrowDown size={14}/>下移</button>
              {removeId !== active.id ? <button type="button" className="cs-remove" onClick={() => setRemoveId(active.id)}><Trash2 size={14}/>移出分镜表</button>
                : <div className="cs-remove-confirm"><span>保留画布节点，移出此镜？</span>
                  <button type="button" onClick={() => setRemoveId(null)}>取消</button>
                  <button type="button" onClick={() => perform("remove", async () => { await onEdit(current => removeStoryboardShot(current, active.id)); setRemoveId(null); })}>确认移出</button>
                </div>}
            </div>
          </> : <div className="cs-empty-edit"><Clapperboard size={32}/><h3>还没有分镜</h3><button type="button" onClick={add} disabled={Boolean(working)}><Plus size={15}/>手动添加镜头</button></div>}
        </div>
      </div>
    </div>
    <footer className="cs-generate-bar">
      <div><ListChecks size={17}/><strong>已选 {selectedIds.length} 镜</strong>{selectedIds.length > 0 && <span>{modes[kind]} · {summary}</span>}</div>
      <button type="button" className="cs-accent" disabled={!selectedIds.length || Boolean(working)} onClick={() => setReview({kind,shotIds:selectedIds,plan})}>
        {working === "generate" ? "正在提交…" : "查看生成清单"}</button>
    </footer>
    {review && <GenerateReview snapshot={review} latest={plan} working={working === "generate"} onClose={() => setReview(null)} onConfirm={confirmGeneration}/>}
  </section>;
}
