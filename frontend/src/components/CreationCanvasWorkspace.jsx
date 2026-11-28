import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, BookOpen, Check, ChevronDown, Clapperboard, Folder, FolderOpen, LoaderCircle, Plus, Save, Workflow, X } from "lucide-react";
import {
  cancelPreparingCanvasRun, claimCanvasRun, connectCanvasNodes, createCanvasProject, extractCanvasTailFrame, finishCanvasRun,
  getCanvasAsset, listCanvasProjects, loadCanvasProject, openOrCreateCanvasProject, putCanvasAsset,
  markCanvasRunDispatched, rememberGuestCanvasForLogin, resumeGuestCanvasAfterLogin, CANVAS_LOGIN_READY,
  setLastCanvasProject, updateCanvasProject,
} from "../lib/creationCanvasProject";
import {
  canvasEffectiveControls, canvasGenerationQuoteDetails, canvasGenerationSettings, canvasModelCapabilities, canvasModelOptions, queryCanvasGeneration, submitCanvasGeneration, validateCanvasInputs,
} from "../lib/creationCanvasGeneration";
import { canvasInputInfo, prepareCanvasReference, readCanvasReference, readCanvasVideoDuration } from "../lib/creationCanvasMedia";
import CreationCanvasGraph from "./CreationCanvasGraph";
import CreationCanvasTour from "./CreationCanvasTour";
import useCanvasGuide, { graphGuide, storyboardGuide } from "./useCanvasGuide";
import CreationCanvasExport from "./CreationCanvasExport";
import CreationCanvasStoryboard from "./CreationCanvasStoryboard";
import CanvasPromptWriter from "./CanvasPromptWriter";
import useCanvasTextAssistant from "./useCanvasTextAssistant";
import { canvasNodePrompt, storyboardItemSignature, storyboardPlan } from "../lib/creationCanvasStoryboard";
import { incomingNodes, initialCanvasFields, moveCanvasNode, needsFrameUpdate, newCanvasNode } from "./creationCanvasLayout";
import "./creationCanvas.css";

function replaceNode(project, id, patch) {
  return { ...project, nodes: project.nodes.map(node => node.id === id ? { ...node, ...patch } : node) };
}

function localBlobUrl(value) {
  if (!value) return "";
  try { return new URL(value).protocol === "https:" ? value : ""; } catch { return ""; }
}

async function remoteBlob(url, mime) {
  if (!localBlobUrl(url)) return null;
  try {
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(15000) });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size && (!blob.type || blob.type.startsWith(mime) || blob.type === "application/octet-stream") ? blob : null;
  } catch { return null; }
}

export default function CreationCanvasWorkspace({
  ownerId = "guest", user, generationContext = {}, onOpenAccount, onBalanceChange,
}) {
  const owner = ownerId || "guest";
  const [project, setProject] = useState(null);
  const { tourOpen, openTour, closeTour } = useCanvasGuide(owner, user, Boolean(project));
  const projectRef = useRef(null);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [uploads, setUploads] = useState({});
  const [picker, setPicker] = useState(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [writer, setWriter] = useState(null);
  const batchRunning = useRef(false);
  const [entryName, setEntryName] = useState("");
  const [recent, setRecent] = useState([]);
  const queuedWrites = useRef(Promise.resolve());
  const activeRuns = useRef(new Set());
  const alive = useRef(true);
  const contextRef = useRef(generationContext);
  contextRef.current = generationContext;
  const balanceRef = useRef(onBalanceChange);
  balanceRef.current = onBalanceChange;

  const select = useCallback(next => {
    if (!alive.current || !next) return;
    projectRef.current = next;
    setProject(next);
  }, []);

  const receive = useCallback(next => {
    if (next && projectRef.current?.id === next.id && (next.revision ?? 0) >= (projectRef.current.revision ?? 0)) select(next);
  }, [select]);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let revision = 0;
    const open = async () => {
      const token = ++revision;
      try {
        const next = await resumeGuestCanvasAfterLogin(owner) || await openOrCreateCanvasProject(owner, initialCanvasFields());
        if (!cancelled && token === revision) select(next);
      } catch (error) { if (!cancelled) setLoadError(error.message || "无法打开本机项目"); }
    };
    void open();
    if (owner !== "guest") window.addEventListener(CANVAS_LOGIN_READY, open);
    return () => { cancelled = true; alive.current = false; window.removeEventListener(CANVAS_LOGIN_READY, open); };
  }, [owner, retry, select]);

  const report = useCallback(error => {
    if (alive.current) setNotice(error?.message || String(error || "操作失败"));
  }, []);

  const edit = useCallback((mutate) => {
    const id = projectRef.current?.id;
    if (!id) return Promise.resolve();
    setSaving(current => current + 1);
    const work = queuedWrites.current.then(() => updateCanvasProject(owner, id, mutate));
    queuedWrites.current = work.catch(() => {});
    return work.then(next => { receive(next); if (alive.current) setSaveFailed(false); }).catch(error => {
      if (alive.current && /空间|存储|保存|database|quota/i.test(error.message)) setSaveFailed(true);
      report(error);
    }).finally(() => { if (alive.current) setSaving(count => Math.max(0, count - 1)); });
  }, [owner, receive, report]);

  const textAI = useCanvasTextAssistant({ owner, project, projectRef, contextRef, queuedWrites, receive, report, refresh: balanceRef,
    login: () => { if (owner === "guest" && project) rememberGuestCanvasForLogin(project.id); onOpenAccount?.(); } });

  const commitResult = useCallback(async (projectId, nodeId, requestId, result) => {
    const patch = { status: result.status, message: result.message || "" };
    if (result.status === "completed" && result.blob?.size) patch.blob = result.blob;
    if (result.status === "completed" && result.lastFrameBlob?.size) patch.lastFrameBlob = result.lastFrameBlob;
    if (localBlobUrl(result.url)) patch.url = result.url;
    if (localBlobUrl(result.lastFrameUrl)) patch.lastFrameUrl = result.lastFrameUrl;
    if (result.filename) patch.filename = result.filename;
    const saved = await finishCanvasRun(owner, projectId, nodeId, requestId, patch);
    receive(saved);
    if (result.status === "completed" && saved.nodes.find(n => n.id === nodeId)?.type === "video" && (result.blob || result.url)) {
      // Save the delivered result first. Reading duration is optional for playback.
      void readCanvasVideoDuration(result).then(ms => updateCanvasProject(owner, projectId, current => {
        const node = current.nodes.find(n => n.id === nodeId);
        return node?.run?.requestId === requestId ? replaceNode(current, nodeId, { run: { ...node.run, duration_ms: ms } }) : current;
      })).then(receive).catch(() => {});
    }
    if (result.status !== "pending" && alive.current && balanceRef.current) {
      Promise.resolve().then(() => balanceRef.current?.()).catch(() => {});
    }
  }, [owner, receive]);

  const recover = useCallback(async (p, node) => {
    const run = node.run;
    if (run?.status !== "pending" || run.phase === "preparing" || activeRuns.current.has(run.requestId)) return;
    activeRuns.current.add(run.requestId);
    try {
      const result = await queryCanvasGeneration({ ...run, kind: node.type, context: contextRef.current });
      if (result.status !== run.status || result.message !== run.message) await commitResult(p.id, node.id, run.requestId, result);
    } catch (error) { report(error); }
    finally { activeRuns.current.delete(run.requestId); }
  }, [commitResult, report]);

  useEffect(() => {
    if (!project?.id) return;
    const poll = async () => {
      if (document.visibilityState === "hidden") return;
      const id = projectRef.current?.id;
      if (!id) return;
      try {
        const latest = await loadCanvasProject(owner, id);
        if (!latest || !alive.current || projectRef.current?.id !== id) return;
        receive(latest);
        await Promise.all(latest.nodes.filter(n => n.run?.status === "pending").map(n => recover(latest, n)));
      } catch (error) { report(error); }
    };
    void poll();
    const interval = window.setInterval(poll, 18000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(interval); window.removeEventListener("focus", poll); document.removeEventListener("visibilitychange", poll); };
  }, [owner, project?.id, receive, recover, report]);

  function nodeQuote(node, source = project, context = generationContext) {
    const options = canvasModelOptions(node.type, context);
    const pendingRun = node.run?.status === "pending" ? node.run : null;
    const chosen = pendingRun?.model || node.model;
    let result = { model: chosen, options };
    try {
      const settings = canvasGenerationSettings({ kind: node.type, context, params: node.params, ...(pendingRun || {}), model: chosen });
      const capabilities = canvasModelCapabilities(node.type, settings.model, settings.params, settings);
      const info = incomingNodes(source, node.id).filter(n => n.type !== "prompt").map(canvasInputInfo);
      const support = [[capabilities.maxImages, "张图"], [capabilities.maxVideos, "段视频"], [capabilities.maxAudios, "段音频"], [capabilities.maxDocuments, "份文档"]]
        .filter(([limit]) => limit > 0).map(([limit, unit]) => limit + " " + unit);
      result = { ...result, ...settings, controls: canvasEffectiveControls(settings, info), inputHint: support.length ? "参考素材上限 · " + support.join(" / ") : "仅支持文字输入", upload: uploads[source.id + ":" + node.id] };
      if (!pendingRun && !options.some(option => option.value === settings.model)) {
        throw new Error("当前服务配置无法使用此模型，请重新选择。");
      }
      validateCanvasInputs({ ...settings, kind: node.type }, info);
      result.needsDuration = !pendingRun && info.some(i => ["video","audio"].includes(i.kind) && !i.duration_ms);
      if (result.needsDuration) return result;
      const generation = { ...settings, kind: node.type, context };
      return { ...result, ...canvasGenerationQuoteDetails({ ...generation, referenceInfo: info }) };
    } catch (error) { return { ...result, error: error.message }; }
  }

  function changeNodeModel(id, model) {
    return edit(current => {
      const node = current.nodes.find(item => item.id === id);
      if (!node) throw new Error("这个节点已被移除。");
      if (node.run?.status === "pending") throw new Error("请等原任务结束后再切换模型。");
      if (!canvasModelOptions(node.type, contextRef.current).some(option => option.value === model)) throw new Error("当前服务配置无法使用此模型。");
      return replaceNode(current, id, { model, params: {} });
    });
  }

  function changeNodeParam(id, model, key, value) {
    return edit(current => {
      const node = current.nodes.find(n => n.id === id);
      if (!node || node.run?.status === "pending") throw new Error("当前节点无法更改参数。");
      const settings = canvasGenerationSettings({ kind: node.type, model: node.model, params: node.params, context: contextRef.current });
      if (model !== settings.model) throw new Error("节点模型已变化，请重新查看参数。");
      const refs = incomingNodes(current, id).filter(n => n.type !== "prompt").map(canvasInputInfo);
      const control = canvasEffectiveControls(settings, refs).find(c => c.key === key);
      if (!control || control.disabled) throw new Error("当前模式不支持这项参数。");
      const next = canvasGenerationSettings({ kind: node.type, model, params: { ...settings.params, [key]: value }, context: contextRef.current });
      return replaceNode(current, id, { model, params: next.params });
    });
  }

  function connectNodes(current, from, to) {
    const next = connectCanvasNodes(current, from, to);
    const target = next.nodes.find(n => n.id === to);
    if (target.run?.status === "pending") throw new Error("请等原任务结束后再连接素材。");
    if (target.type === "image" || target.type === "video") {
      const settings = canvasGenerationSettings({ kind: target.type, model: target.model, params: target.params, context: contextRef.current });
      validateCanvasInputs({ ...settings, kind: target.type }, incomingNodes(next, to).filter(n => n.type !== "prompt").map(canvasInputInfo), { partial: true });
    }
    return next;
  }

  async function runNode(nodeId, expectedRequestId, displayed) {
    const source = projectRef.current;
    const marker = source.id + ":" + nodeId;
    if (activeRuns.current.has(marker)) return;
    activeRuns.current.add(marker);
    let requestId;
    try {
      await queuedWrites.current;
      const current = await loadCanvasProject(owner, source.id);
      const node = current.nodes.find(n => n.id === nodeId);
      if (!node) return;
      if (node.run?.status === "pending") { await recover(current, node); return; }
      if ((node.run?.requestId ?? null) !== expectedRequestId) { receive(current); setNotice("已读取这个节点的最新结果。"); return; }
      const context = contextRef.current;
      const settings = canvasGenerationSettings({ kind: node.type, model: node.model, params: node.params, context });
      const latestQuote = nodeQuote(node, current, context);
      if (latestQuote.error) throw new Error(latestQuote.error);
      if (displayed.inputSignature && displayed.inputSignature !== storyboardItemSignature(current, nodeId)) throw new Error("镜头的提示词或参考素材已变化，请重新核对。");
      if (displayed.model !== settings.model || displayed.billingMode !== settings.billingMode || displayed.providerOrigin !== settings.providerOrigin || JSON.stringify(displayed.params) !== JSON.stringify(settings.params) || displayed.credits !== latestQuote.credits || displayed.reservedCredits !== latestQuote.reservedCredits) {
        receive(current); setNotice("节点参数或报价已变化，请核对后再生成。"); return;
      }
      if (!canvasModelOptions(node.type, context).some(option => option.value === settings.model)) throw new Error("请先为此节点选择可用模型。");
      if (!latestQuote.needsDuration && settings.billingMode === "platform" && !context.authenticated) {
        if (owner === "guest") rememberGuestCanvasForLogin(current.id);
        setNotice("登录后即可继续这个项目并使用平台积分。");
        onOpenAccount?.();
        return;
      }
      const inputs = incomingNodes(current, nodeId);
      const prompt = canvasNodePrompt(current, nodeId);
      const media = inputs.filter(n => n.type !== "prompt");
      if (!prompt && (node.type === "image" || !media.length && !settings.params.link_url)) throw new Error("先连接并填写提示词，再运行这个节点。");
      const references = [];
      for (const input of media) {
        if (["image", "video"].includes(input.type) && input.run?.status !== "completed") throw new Error(`「${input.title}」还没有本次生成的结果。`);
        if (needsFrameUpdate(current, input)) throw new Error("上一个视频镜头已变化，请先重新提取尾帧。");
        references.push(await readCanvasReference(owner, current.id, input, node.type));
      }
      validateCanvasInputs({ ...settings, kind: node.type }, references);
      if (latestQuote.needsDuration) {
        const refreshed = await updateCanvasProject(owner, current.id, p => {
          if (p.revision !== current.revision) throw new Error("素材已变化，请重新读取时长。");
          return media.reduce((next, n, i) => {
            const ms = references[i].duration_ms;
            if (!ms) return next;
            return replaceNode(next, n.id, n.run ? { run: { ...n.run, duration_ms: ms } } : { duration_ms: ms });
          }, p);
        });
        receive(refreshed); setNotice("素材时长已读取，请核对报价后生成。"); return;
      }
      const claim = await claimCanvasRun(owner, current.id, node.id, expectedRequestId, settings, node.model ?? null, node.params ?? {}, current.revision);
      receive(claim.project);
      if (!claim.acquired) { setNotice(claim.modelChanged ? "项目已变化，请核对节点参数和报价后再生成。" : "当前任务已保留，正在读取原任务。"); return; }
      requestId = claim.requestId;
      activeRuns.current.add(requestId);
      const result = await submitCanvasGeneration({ ...settings, kind: node.type, requestId, prompt, references, context, expectedCredits: displayed.credits, expectedReservedCredits: displayed.reservedCredits,
        onUploadProgress: progress => { if (alive.current) setUploads(prev => ({ ...prev, [marker]: progress.stage === "complete" ? null : progress })); },
        beforeDispatch: async () => receive(await markCanvasRunDispatched(owner, current.id, node.id, requestId)),
      });
      await commitResult(source.id, nodeId, requestId, result);
      return result.status;
    } catch (error) { report(error); }
    finally {
      activeRuns.current.delete(marker);
      if (requestId) activeRuns.current.delete(requestId);
      if (alive.current) setUploads(prev => {
        if (!Object.hasOwn(prev, marker)) return prev;
        const next = { ...prev };
        delete next[marker];
        return next;
      });
    }
  }

  async function generateShots({ kind, shotIds, plan }) {
    if (batchRunning.current) return;
    const projectId = projectRef.current.id;
    batchRunning.current = true;
    try {
      await queuedWrites.current;
      const latest = await loadCanvasProject(owner, projectId);
      const checked = storyboardPlan(latest, shotIds, kind, contextRef.current);
      if (!checked.items.length || checked.signature !== plan.signature || checked.items.some(item => item.error)) {
        receive(latest); throw new Error("所选镜头或报价已变化，请重新确认。");
      }
      for (const item of checked.items) {
        if (!alive.current || projectRef.current?.id !== projectId) break;
        const state = await runNode(item.nodeId, item.requestId, item.quote);
        if (!state || state === "failed") break;
      }
    } catch (error) { report(error); }
    finally { batchRunning.current = false; }
  }

  async function addReference(id, file) {
    if (!file) return;
    const current = projectRef.current;
    try {
      const metadata = await prepareCanvasReference(file);
      const assetId = await putCanvasAsset(owner, current.id, file);
      receive(await updateCanvasProject(owner, current.id, p => replaceNode(p, id, { assetId, duration_ms: undefined, ...metadata })));
    } catch (error) { report(error); }
  }

  async function extractFrame(nodeId) {
    const current = projectRef.current;
    const lock = current.id + ":frame:" + nodeId;
    if (activeRuns.current.has(lock)) return;
    activeRuns.current.add(lock);
    try {
      const input = incomingNodes(current, nodeId).find(n => n.type === "video");
      if (!input || input.run?.status !== "completed") throw new Error("先连接一个已完成的视频节点。");
      let assetId = input.run?.lastFrameAssetId;
      const url = localBlobUrl(input.run?.lastFrameUrl);
      if (!assetId) {
        let frame = await remoteBlob(url, "image/");
        if (!frame) {
          const video = (input.run.assetId && await getCanvasAsset(owner, current.id, input.run.assetId)) || await remoteBlob(input.run.url, "video/");
          if (video) {
            try { frame = await extractCanvasTailFrame(video); }
            catch (error) { if (!url) throw error; }
          }
        }
        if (frame) assetId = await putCanvasAsset(owner, current.id, frame);
      }
      if (!assetId && !url) throw new Error("视频资源未能读取，请查询原任务取回视频后再试。");
      receive(await updateCanvasProject(owner, current.id, p => {
        const latest = incomingNodes(p, nodeId).find(n => n.type === "video");
        if (latest?.id !== input.id || latest.run?.requestId !== input.run.requestId) throw new Error("视频输入已变化，请重新提取尾帧。");
        return replaceNode(p, nodeId, { assetId: assetId || null, url, sourceNodeId: input.id, sourceRequestId: input.run.requestId });
      }));
    } catch (error) { report(error); }
    finally { activeRuns.current.delete(lock); }
  }

  function addNextShot(node) {
    return edit(p => {
      const count = p.edges.filter(edge => edge.from === node.id).length;
      const next = newCanvasNode("video", node.x + 298, node.y + count * 209, "下一镜");
      return connectCanvasNodes({ ...p, nodes: [...p.nodes, next] }, node.id, next.id);
    });
  }

  async function showProjects() {
    try { setRecent(await listCanvasProjects(owner)); setPicker("list"); setEntryName(""); }
    catch (error) { report(error); }
  }

  async function switchProject(id) {
    try {
      await queuedWrites.current;
      const next = await loadCanvasProject(owner, id);
      if (!next) throw new Error("项目不存在。");
      await setLastCanvasProject(owner, id);
      select(next); setPicker(null); setNotice("");
    } catch (error) { report(error); }
  }

  async function saveName(event) {
    event.preventDefault();
    const name = entryName.trim();
    if (!name) return;
    try {
      if (picker === "new") { select(await createCanvasProject(owner, initialCanvasFields(name))); }
      else { await edit(p => ({ ...p, name })); }
      setPicker(null); setNotice("");
    } catch (error) { report(error); }
  }

  if (!project) return <section className="cc-loading" aria-live="polite"><Workflow size={22} />{loadError || "正在打开创作画布…"}{loadError && <button onClick={() => { setLoadError(""); setRetry(n => n + 1); }}>重新打开</button>}</section>;

  const downloadScope = { owner, projectId: project.id, imageOptions: { authenticated: generationContext.authenticated, headers: generationContext.authHeaders } };
  const boardOpen = project.canvasView === "storyboard";
  const switchView = view => {
    if ((view === "storyboard") !== boardOpen) return edit(p => ({ ...p, canvasView: view }));
  };
  const writingNode = writer?.projectId === project.id ? writer.id : null;
  const aiNode = project.textProposal?.input.nodeId;
  return <section className="cc-workspace" aria-label="AI 创作画布">
    <header className="cc-project-bar">
      <div className="cc-project-identity">
        <div className="cc-heading-icon"><Workflow size={22} /></div>
        <div className="cc-heading"><h1>AI 创作画布</h1><button onClick={showProjects} title={project.name}><Folder size={13} /><span>{project.name}</span><ChevronDown size={13} /></button></div>
      </div>
      <div className="cc-workspace-modes" role="group" aria-label="工作区视图">
        <button type="button" data-canvas-guide="graph" aria-pressed={!boardOpen} onClick={() => switchView("graph")}><Workflow size={18}/><span>节点画布</span></button>
        <button type="button" data-canvas-guide="storyboard" aria-pressed={boardOpen} onClick={() => switchView("storyboard")}><Clapperboard size={18}/><span>分镜工作台</span></button>
      </div>
      <div className="cc-project-actions"><span className="cc-saved" role="status">{saving ? <LoaderCircle size={14} /> : saveFailed ? <X size={14}/> : <Check size={14} />}{saving ? "保存中" : saveFailed ? "保存失败" : "已存本机"}</span>
        <button className="cc-tool-button" data-canvas-guide="export" aria-label="批量导出" title="批量导出" onClick={() => setExportOpen(true)}><Archive size={16} /><span>批量导出</span></button>
        <button className="cc-tool-button" data-canvas-guide="projects" aria-label="我的项目" title="我的项目" onClick={showProjects}><FolderOpen size={16} /><span>我的项目</span></button>
        <button className="cc-tool-button cc-tour-trigger" data-canvas-guide="help" aria-label="新手指引" title="新手指引" onClick={openTour}><BookOpen size={16}/><span>新手指引</span></button>
      </div>
    </header>
    {textAI.configured === false && (boardOpen || writingNode) && <div className="cc-notice" role="status"><span>AI 拆镜与助写等待开通。你可以手动添加镜头、设置模型并查看预计积分。</span></div>}
    {notice && <div className="cc-notice" role="status"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示"><X size={15} /></button></div>}
    {project.textError && <div className="cc-notice" role="alert"><span>{project.textError}</span><button aria-label="关闭 AI 提示" onClick={() => edit(p => ({ ...p, textError: "" }))}><X size={15}/></button></div>}
    {project.textRequest && <div className="cc-notice" role="status"><span>{textAI.missing ? "服务端暂未查到这项 AI 文本任务。" : "AI 文本任务处理中，刷新后会继续查询。"}</span>{textAI.missing && <button className="cc-text-action" onClick={textAI.retry}>用原编号重试</button>}</div>}
    {project.textProposal && (!boardOpen || aiNode) && <div className="cc-notice"><span>AI 建议已就绪</span><button className="cc-text-action" onClick={() => aiNode ? setWriter({ id: aiNode, projectId: project.id }) : switchView("storyboard")}>查看建议</button></div>}
    {writingNode && <CanvasPromptWriter key={project.id + writingNode} project={project} nodeId={writingNode} quote={nodeQuote} configured={textAI.configured} routeLabel={textAI.routeLabel} onClose={() => setWriter(null)}
      onStart={textAI.start} onDismiss={() => textAI.apply()} onApply={textAI.apply}/>}
    {exportOpen && <CreationCanvasExport key={`export-${project.id}`} project={project} scope={downloadScope} onClose={() => setExportOpen(false)} />}
    {tourOpen && <CreationCanvasTour steps={boardOpen ? storyboardGuide : graphGuide} onDismiss={closeTour} />}
    {boardOpen ? <CreationCanvasStoryboard key={project.id} project={project} owner={owner} generationContext={generationContext} textConfigured={textAI.configured} routeLabel={textAI.routeLabel} onEdit={edit} onBack={() => switchView("graph")}
      onGenerate={generateShots} onTextAction={textAI.start} onApplyProposal={textAI.apply} onDismissProposal={() => textAI.apply()}/> :
    <CreationCanvasGraph key={project.id} project={project} owner={owner} downloadScope={downloadScope} quote={nodeQuote} onRun={runNode} onUpload={addReference}
      onExtract={extractFrame} onNextShot={addNextShot} onError={report} onEdit={edit} onModelChange={changeNodeModel} onParamChange={changeNodeParam}
      onCancel={(id,requestId) => cancelPreparingCanvasRun(owner, project.id, id, requestId).then(receive).catch(report)}
      onMove={(id, dx, dy, view) => edit(p => moveCanvasNode(p, id, dx, dy, view))}
      onText={(id, text) => edit(p => replaceNode(p, id, { text }))}
      onAssist={id => setWriter({ id, projectId: project.id })}
      onConnect={(from, to) => edit(p => connectNodes(p, from, to))} />}
    {picker && <div className="cc-dialog-scrim" onClick={() => setPicker(null)} onKeyDown={e => { if (e.key === "Escape") setPicker(null); }}>
      <section className="cc-dialog" aria-label="画布项目" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <header><h2>{picker === "list" ? "我的画布项目" : picker === "new" ? "新建项目" : "修改项目名称"}</h2>
          <button onClick={() => setPicker(null)} aria-label="关闭项目窗口"><X size={18} /></button></header>
        {picker === "list" ? <>
          <p>项目和素材保存在此浏览器。</p>
          <div className="cc-project-list">{recent.map(p => <button key={p.id} onClick={() => switchProject(p.id)}><FolderOpen size={17} /><span>{p.name}</span>{p.id === project.id && <Check size={16} />}</button>)}</div>
          <footer><button onClick={() => { setEntryName(project.name); setPicker("rename"); }}>重命名当前项目</button><button className="cc-primary" onClick={() => { setEntryName(""); setPicker("new"); }}><Plus size={15} />新建项目</button></footer>
        </> : <form onSubmit={saveName}><label>项目名称<input autoFocus required maxLength={64} value={entryName} onChange={e => setEntryName(e.target.value)} placeholder="输入项目名称" /></label><button className="cc-primary" type="submit"><Save size={15} />保存</button></form>}
      </section>
    </div>}
  </section>;
}
