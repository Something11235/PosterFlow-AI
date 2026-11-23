import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, FileUp, Layers, LoaderCircle, MessageSquare, MousePointer2, Paperclip, Presentation, RefreshCw, Sparkles, X } from "lucide-react";
import { saveBrowserFile } from "../../lib/browserSave";
import { displayCredits } from "../../lib/credits";
import { accessPptProject, finishPptRequest, getPptChat, isPptPreflightError, newPptChatSession, newPptProject, pptChatContext, PPT_MODEL_NAMES, requestPpt, setPptChatDraft } from "../../lib/pptProject";
import PptChat from "./PptChat";
import PptSlide from "./PptSlide";
import "./ppt.css";

const high = "gpt-6.2-astra";
const middle = "gpt-6.2-sol";
const economy = "deepseek-v4.1-flash";

function draftKey(owner, chatId) {
  return "ppt-chat-draft:" + owner + (chatId === "initial" ? "" : ":" + chatId);
}

function readDraft(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function resumeGuestProject(current, guest) {
  if (current.pending) return current;
  const guestDraft = getPptChat(guest).draft;
  if (!current.revision) {
    return { ...setPptChatDraft(current, current.activeChatId, guestDraft), topic: guest.topic, pageCount: guest.pageCount,
      autoPageCount: guest.autoPageCount, model: guest.model, template: guest.template, references: guest.references, view: guest.view };
  }
  if (guest.view !== "chat" || !guestDraft) return current;
  const existing = getPptChat(current);
  if (!existing.turns.length && !existing.draft) return { ...setPptChatDraft(current, existing.id, guestDraft), view: "chat" };
  const session = { ...newPptChatSession(), draft: guestDraft };
  return { ...current, view: "chat", chatSessions: [session, ...current.chatSessions], activeChatId: session.id };
}

function BillingNote({ task }) {
  if (!task) return null;
  const { billing } = task;
  const success = { chat: "回复已保存", edit: "修改已保存", generate: "演示稿已保存" };
  return <div className="ppt-receipt" role="status">{task.status === "failed" ? task.error || "任务未完成。" : success[task.action]}
    {billing?.status === "settled" && <> · 本次扣除 {displayCredits(billing.charged_credits)} 积分</>}
    {billing?.status === "refunded" && <> · 预留积分已退还</>}
    {task.note && <> · {task.note}</>}
  </div>;
}

export default function PptWorkspace({ owner, signedIn, authHeaders, onLogin, onAccountRefresh }) {
  const [project, setProject] = useState(newPptProject);
  const [ready, setReady] = useState(false);
  const [topic, setTopic] = useState("");
  const [instruction, setInstruction] = useState("");
  const [selected, setSelected] = useState([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState("");
  const [alert, setAlert] = useState("");
  const [config, setConfig] = useState(null);
  const [missingId, setMissingId] = useState("");
  const activeChat = getPptChat(project);
  const chatId = activeChat.id;
  const cacheKey = draftKey(owner, chatId);
  const [draft, setDraft] = useState(null);
  const localDraft = draft?.key === cacheKey ? draft.value : readDraft(cacheKey);
  const chatText = localDraft ?? activeChat.draft;
  const changeDraft = value => {
    setDraft({ key: cacheKey, value });
    try { sessionStorage.setItem(cacheKey, value); } catch { /* IndexedDB also saves on blur. */ }
  };
  const clearSavedDraft = (key, value) => {
    try {
      if (readDraft(key) === value) sessionStorage.removeItem(key);
    } catch { /* The draft was persisted with its conversation. */ }
    setDraft(previous => previous?.key === key && previous.value === value ? null : previous);
  };
  const pendingChat = project.pending?.action === "chat" && project.pending.chatId === chatId ? project.pending : null;
  const showChat = project.view === "chat";
  const mounted = useRef(false);
  const submitting = useRef(false);
  const topicDirty = useRef(false);
  const checking = useRef(false);
  const headers = useRef(authHeaders);
  headers.current = authHeaders;
  const refresh = useRef(onAccountRefresh);
  refresh.current = onAccountRefresh;
  const patch = useCallback(async transform => {
    const next = await accessPptProject(owner, transform);
    if (mounted.current) setProject(old => old.revision <= next.revision ? next : old);
    return next;
  }, [owner]);
  const update = fields => patch(current => current.pending ? current : { ...current, ...fields }).catch(error => setAlert(error.message));

  function storeDraft(current) {
    if (localDraft === null || (current.pending?.action === "chat" && current.pending.chatId === chatId)) return current;
    return setPptChatDraft(current, chatId, localDraft);
  }
  function saveDraft() {
    if (!ready || localDraft === null) return;
    patch(storeDraft).then(() => clearSavedDraft(cacheKey, localDraft)).catch(error => setAlert(error.message));
  }
  async function selectChat(targetId) {
    if (!ready || targetId === chatId) return;
    try {
      await patch(current => {
        const saved = storeDraft(current);
        if (targetId) return getPptChat(saved, targetId) ? { ...saved, activeChatId: targetId } : saved;
        const empty = saved.chatSessions.find(session => !session.turns.length && !session.draft && session.id !== saved.pending?.chatId);
        const next = empty || newPptChatSession();
        return { ...saved, activeChatId: next.id, chatSessions: empty ? saved.chatSessions : [next, ...saved.chatSessions] };
      });
      if (localDraft !== null) clearSavedDraft(cacheKey, localDraft);
    } catch (error) { setAlert(error.message); }
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    (async () => {
      let initial = await accessPptProject(owner);
      if (!active) return;
      if (signedIn && sessionStorage.getItem("ppt-continue-after-login") === "yes") {
        sessionStorage.removeItem("ppt-continue-after-login");
        const guest = await accessPptProject("guest");
        initial = await accessPptProject(owner, current => resumeGuestProject(current, guest));
      }
      if (active) { setProject(initial); setTopic(initial.topic); setReady(true); }
    })().catch(() => { if (active) setAlert("无法保存到本浏览器。请允许网站使用本地存储后刷新。"); });
    const synchronize = () => { patch().then(current => { if (active && !topicDirty.current) setTopic(current.topic); }).catch(() => {}); };
    window.addEventListener("focus", synchronize);
    requestPpt("config", headers.current).then(data => { if (active) setConfig(data); }).catch(() => {});
    return () => { active = false; mounted.current = false; window.removeEventListener("focus", synchronize); };
  }, [owner, signedIn, patch]);

  const pages = project.deck?.slides || [];
  const pageIndex = Math.min(index, pages.length - 1);
  const page = pages[pageIndex];
  const rate = config?.models?.find(model => model.id === project.model)?.credits_per_million;
  const maxPages = config?.max_pages || 16;
  const locked = !ready || Boolean(project.pending) || Boolean(busy);
  const finish = useCallback(async (id, result) => {
    if (result.status === "processing") return;
    const next = await patch(current => finishPptRequest(current, id, result));
    if (mounted.current && next.lastTask?.id === id) {
      setAlert(""); setMissingId("");
      if (next.lastTask.action !== "chat") { setSelected([]); setInstruction(""); }
      refresh.current?.();
    }
  }, [patch]);
  const check = useCallback(async (pending, manual = false) => {
    if (!pending || checking.current || submitting.current) return;
    checking.current = true;
    try {
      const data = await requestPpt("requests/" + encodeURIComponent(pending.id), headers.current);
      await finish(pending.id, data);
      if (manual && mounted.current && data.status === "processing") setAlert("原任务仍在处理，将自动查询。");
    } catch (error) {
      const missing = error.status === 404 && error.code === "PPT_NOT_FOUND";
      if (mounted.current && missing && Date.now() - pending.at > 15_000) setMissingId(pending.id);
      if (manual && mounted.current) setAlert(missing ? "服务端暂未查到原任务，可以稍后再次查询。" : error.message);
    } finally { checking.current = false; }
  }, [finish]);
  useEffect(() => {
    if (!project.pending || !signedIn) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") check(project.pending); }, 8000);
    check(project.pending);
    return () => window.clearInterval(timer);
  }, [check, project.pending, signedIn]);
  useEffect(() => {
    if (!ready || project.pending || !topicDirty.current) return;
    if (topic === project.topic) { topicDirty.current = false; return; }
    const timer = window.setTimeout(() => {
      patch(current => current.pending ? current : { ...current, topic }).catch(error => setAlert(error.message));
    }, 400);
    return () => window.clearTimeout(timer);
  }, [ready, topic, project.pending, project.topic, patch]);

  async function importFiles(files, kind) {
    if (!files.length || locked) return;
    setBusy("正在读取文件…"); setAlert("");
    try {
      const { importPptFile } = await import("../../lib/pptFiles");
      const parsed = [];
      if (kind === "reference" && project.references.length + files.length > 8) throw new Error("最多可添加 8 份参考资料。");
      for (const file of files) {
        const data = await importPptFile(file, kind);
        parsed.push({ file, ...data });
      }
      await patch(current => {
        if (current.pending) throw new Error("请等当前任务结束后更换资料。");
        if (kind === "template") return { ...current, template: parsed[0] };
        const references = [...current.references, ...parsed.map(item => item.source)];
        if (references.length > 8) throw new Error("最多可添加 8 份参考资料。");
        return { ...current, references };
      });
    } catch (error) { setAlert(error.message || "文件读取失败。"); }
    finally { if (mounted.current) setBusy(""); }
  }
  async function sendPending(pending) {
    try {
      const result = await requestPpt(pending.action, headers.current, pending.body);
      await finish(pending.id, result);
      if (pending.action === "generate" && result.status === "succeeded" && mounted.current) setIndex(0);
    } catch (error) {
      if (isPptPreflightError(error)) {
        await patch(current => current.pending?.id === pending.id ? { ...current, pending: null } : current);
        if (mounted.current) setAlert(error.message);
      } else if (mounted.current) setAlert("尚未收到最终结果，将按原任务编号查询。");
    }
  }
  async function submit(action, retry = false) {
    if ((!retry && locked) || submitting.current || (retry && !project.pending?.body)) return;
    if (!signedIn) {
      try {
        await patch(current => ({ ...setPptChatDraft(current, chatId, chatText), topic, activeChatId: chatId }));
      } catch (error) { setAlert(error.message); return; }
      try { sessionStorage.setItem("ppt-continue-after-login", "yes"); } catch { /* No transferable guest draft. */ }
      onLogin(); return;
    }
    if (!retry && action === "generate" && !topic.trim()) { setAlert("请填写演示主题。"); return; }
    if (!retry && action === "edit" && (!instruction.trim() || !selected.length)) { setAlert("请先选中元素并填写修改要求。"); return; }
    if (!retry && action === "chat" && !chatText.trim()) return;
    submitting.current = true;
    setBusy({ chat: "正在等待 AI 回复…", edit: "正在修改…", generate: "正在生成…" }[action]); setAlert(""); setMissingId("");
    try {
      if (retry) {
        const latest = await patch();
        if (latest.pending?.id === project.pending?.id) await sendPending(latest.pending);
        return;
      }
      const id = crypto.randomUUID();
      const snapshot = await patch(current => {
        if (current.pending) throw new Error("已有任务正在处理，请先查询原任务。");
        if (action === "edit" && JSON.stringify(page) !== JSON.stringify(current.deck?.slides.find(slide => slide.id === page?.id))) throw new Error("当前页已更新，请重新选择后修改。");
        const body = { request_id: id, model: current.model, references: current.references };
        if (action === "generate") Object.assign(body, { topic: topic.trim(), page_count: current.autoPageCount ? "auto" : current.pageCount, template: current.template?.template });
        else if (action === "chat") Object.assign(body, pptChatContext(current, topic, chatText, page?.id, chatId));
        else Object.assign(body, { instruction: instruction.trim(), slide: page, element_ids: selected });
        const saved = action === "chat" ? setPptChatDraft(current, chatId, chatText) : current;
        return { ...saved, topic, pending: { id, action, ...(action === "chat" && { chatId }), model: current.model, slideId: page?.id, body, at: Date.now() } };
      });
      if (action === "chat") clearSavedDraft(cacheKey, chatText);
      await sendPending(snapshot.pending);
    } catch (error) {
      await patch().catch(() => {});
      if (mounted.current) setAlert(error.message || "无法保存任务，请检查浏览器存储空间。");
    } finally { submitting.current = false; if (mounted.current) setBusy(""); }
  }
  async function download() {
    if (!project.deck) return;
    setBusy("正在准备导出…"); setAlert("");
    try {
      const name = Array.from(project.deck.title || "演示文稿", ch => ch.codePointAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? "_" : ch).join("").slice(0, 100);
      await saveBrowserFile(name + ".pptx", async () => {
        const { exportPptFile } = await import("../../lib/pptFiles");
        return exportPptFile(project.deck, project.deckTemplate || undefined);
      });
    } catch (error) { setAlert(error.message || "导出失败，请重试。"); }
    finally { if (mounted.current) setBusy(""); }
  }
  const switchPage = next => { setIndex(next); setSelected([]); setInstruction(""); };
  const switchView = view => patch(current => current.view === view ? current : { ...current, view }).catch(error => setAlert(error.message));

  return <main className="studio-page ppt-workspace">
    <header className="ppt-heading"><div className="ppt-heading-icon"><Presentation size={25}/></div><div><h1>一键 PPT</h1><p>输入主题或添加参考资料，生成可直接编辑的演示稿。</p></div>
      <div className="ppt-view-switch ppt-segments" role="group" aria-label="工作区视图">
        <button aria-pressed={!showChat} disabled={!ready} onClick={() => switchView("preview")}><Presentation size={16}/>演示稿预览</button>
        <button aria-pressed={showChat} disabled={!ready} onClick={() => switchView("chat")}><MessageSquare size={16}/>AI 对话</button>
      </div>
    </header>
    {alert && <div role="alert" className="ppt-alert">{alert}<button aria-label="关闭提示" onClick={() => setAlert("")}><X size={16}/></button></div>}
    <div className={"ppt-columns" + (showChat ? " ppt-columns-chat" : "")}>
      <section className="ppt-brief" aria-label="生成设置">
        <h2><Layers size={17}/>生成设置</h2>
        <label className="ppt-field">演示主题<textarea rows={4} maxLength={6000} placeholder="例如：为设计团队做一份季度项目复盘，突出成果与下季度计划" value={topic} disabled={locked} onChange={event => { topicDirty.current = true; setTopic(event.target.value); }} onBlur={() => { if (ready && topicDirty.current && topic !== project.topic) update({ topic }); }}/></label>
        <fieldset disabled={locked} className="ppt-page-count">
          <legend>页数</legend>
          <div className="ppt-segments">
            <button type="button" aria-pressed={!project.autoPageCount} onClick={() => update({ autoPageCount: false })}>手动指定</button>
            <button type="button" aria-pressed={Boolean(project.autoPageCount)} onClick={() => update({ autoPageCount: true })}>由模型决定</button>
          </div>
          {project.autoPageCount ? <p>模型会根据主题和参考资料生成 1–{maxPages} 页。</p> :
            <label className="ppt-field ppt-inline">生成页数<input aria-label="页数" type="number" min="1" max={maxPages} key={project.pageCount} defaultValue={project.pageCount} onBlur={event => {
              const value = Math.max(1, Math.min(maxPages, Math.round(Number(event.target.value) || 6))); event.target.value = value; update({ pageCount: value });
            }}/></label>}
        </fieldset>
        <fieldset className="ppt-models" disabled={locked}><legend>生成模型</legend><div className="ppt-segments">
          <button aria-pressed={project.model !== economy} onClick={() => update({ model: high })}>高级模型</button>
          <button aria-pressed={project.model === economy} onClick={() => update({ model: economy })}>性价比模型</button>
        </div>{project.model === economy ? <p>{PPT_MODEL_NAMES[economy]}</p> : <select aria-label="高级模型" value={project.model} onChange={event => update({ model: event.target.value })}><option value={high}>GPT 6.2 Astra · 高级</option><option value={middle}>GPT 6.2 Sol · 均衡</option></select>}
          <small className="ppt-rate">{rate ? <>每百万 Token 积分：<span>输入 {rate.input}</span> · <span>输出 {rate.output}</span> · <span>缓存读取 {rate.cache_read}</span>{rate.cache_write != null && <> · <span>缓存写入 {rate.cache_write}</span></>}</> : "生成和 AI 修改按实际 Token 用量结算。"}</small>
        </fieldset>
        <fieldset className="ppt-attachments" disabled={locked}><legend>模板与参考资料</legend>
          <label className="ppt-upload"><FileUp size={16}/>{project.template ? "更换 PPT 模板" : "添加 PPT 模板"}<input type="file" accept=".pptx" aria-label="上传 PPT 模板" onChange={event => { const files = [...event.target.files]; event.target.value = ""; importFiles(files, "template"); }}/><small>.pptx</small></label>
          {project.template && <div className="ppt-file"><Check size={14}/><span>{project.template.file?.name}</span><button aria-label="移除模板" onClick={() => update({ template: null })}><X size={14}/></button></div>}
          <label className="ppt-upload"><Paperclip size={16}/>添加参考资料<input type="file" multiple accept=".pptx,.docx,.xlsx,.pdf,.txt,.md,.csv" aria-label="上传参考资料" onChange={event => { const files = [...event.target.files]; event.target.value = ""; importFiles(files, "reference"); }}/><small>{project.references.length}/8</small></label>
          {project.references.map((source, i) => <div className="ppt-file" key={i}><FileText size={14}/><span>{source.name}</span><button aria-label={"移除 " + source.name} onClick={() => patch(current => current.pending ? current : { ...current, references: current.references.filter((_, n) => n !== i) }).catch(error => setAlert(error.message))}><X size={14}/></button></div>)}
          <details className="ppt-format-help"><summary>支持的格式与大小<ChevronDown size={14} aria-hidden="true"/></summary><p>支持 PPTX、DOCX、XLSX、PDF、TXT、MD 和 CSV，单个文件最多 24 MB。每份参考资料读取前 12,000 字，PDF 最多读取前 100 页。</p></details>
        </fieldset>
        <button className="ppt-primary" disabled={locked || !topic.trim()} onClick={async () => { await switchView("preview"); await submit("generate"); }}><Sparkles size={17}/>{project.deck ? "重新生成演示稿" : "生成演示稿"}</button>
      </section>
      <section className="ppt-editor" aria-label={showChat ? "AI 对话" : "演示稿预览"}>
        {showChat ? <PptChat sessions={project.chatSessions} activeChatId={chatId} onNewChat={() => selectChat()} onSelectChat={selectChat} historyDisabled={!ready}
          turns={activeChat.turns} pending={pendingChat} model={project.model} busy={locked}
          composerDisabled={!ready || Boolean(pendingChat) || (!project.pending && Boolean(busy))}
          value={pendingChat ? "" : chatText} onChange={changeDraft} onSaveDraft={saveDraft}
          onSend={() => submit("chat")} onUseTopic={async text => {
            await update({ topic: text }); setTopic(text); topicDirty.current = false; await switchView("preview");
          }}/> : <>
        <header><div><Presentation size={17}/><h2>{project.deck?.title || "演示稿预览"}</h2></div><button className="ppt-export" disabled={!page || Boolean(busy)} onClick={download}><ArrowDownToLine size={16}/>导出 PPTX</button></header>
        {page ? <>
          <div className="ppt-paper"><PptSlide key={page.id} slide={page} selected={selected} font={project.deckFont || "Microsoft YaHei, sans-serif"} onSelect={locked ? undefined : setSelected}/></div>
          <div className="ppt-pagebar"><span>{pageIndex + 1} / {pages.length} 页</span><div><button aria-label="上一页" disabled={!pageIndex} onClick={() => switchPage(pageIndex - 1)}><ChevronLeft size={17}/></button><button aria-label="下一页" disabled={pageIndex >= pages.length - 1} onClick={() => switchPage(pageIndex + 1)}><ChevronRight size={17}/></button></div></div>
          <div className="ppt-thumbnails" aria-label="选择幻灯片">{pages.map((slide, i) => <button key={slide.id} aria-label={"第 " + (i + 1) + " 页 " + slide.title} aria-current={page.id === slide.id ? "page" : undefined} onClick={() => switchPage(i)}><PptSlide slide={slide} font={project.deckFont || "Microsoft YaHei, sans-serif"}/><span>{i + 1}</span></button>)}</div>
          <section className="ppt-edit"><div><strong><MousePointer2 size={16}/>局部修改</strong><button disabled={locked} onClick={() => setSelected(page.elements.map(el => el.id))}>选择整页</button></div>
            <p>{selected.length ? `已选中 ${selected.length} 个元素` : "点选元素，或在页面上拖动框选多个元素。"}</p>
            <label className="ppt-field"><span className="sr-only">修改要求</span><textarea disabled={locked} rows={2} maxLength={6000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="希望怎样修改选中的内容？"/></label>
            <button className="ppt-secondary" disabled={locked || !instruction.trim() || !selected.length} onClick={() => submit("edit")}><Sparkles size={15}/>应用 AI 修改</button>
          </section>
        </> : <div className="ppt-empty">
          <div className="ppt-empty-stack" aria-hidden="true">
            <div className="ppt-cover"><div className="ppt-cover-lines"><i/><i/><i/></div><span className="ppt-cover-arc"/></div>
          </div>
          <h3>演示稿将在这里预览</h3><p>生成后可逐页浏览，点选文字或图形即可修改。</p>
        </div>}</>}
        {(project.pending || busy) && <div className="ppt-progress" role="status"><LoaderCircle size={16} className="ppt-spin"/><span>{showChat && project.pending?.action === "chat" && !pendingChat ? "另一段对话正在等待回复…" : busy || "正在查询原任务…"}{project.pending && <small>刷新页面后会继续查询本次任务。</small>}</span>{project.pending && !busy && <button onClick={() => check(project.pending, true)}><RefreshCw size={15}/>查询</button>}</div>}
        {project.pending?.body && missingId === project.pending.id && <button className="ppt-secondary" disabled={Boolean(busy)} onClick={() => submit(project.pending.action, true)}>用原任务编号再次提交</button>}
        {!project.pending && (showChat ? project.lastTask?.chatId === chatId : project.lastTask?.action !== "chat") && <BillingNote task={project.lastTask}/>}
      </section>
    </div>
  </main>;
}
