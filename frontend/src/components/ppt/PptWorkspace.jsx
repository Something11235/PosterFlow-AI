import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Check, ChevronDown, ChevronLeft, ChevronRight, FileText, FileUp, Layers, LoaderCircle, MessageSquare, MousePointer2, Paperclip, Presentation, RefreshCw, Sparkles, X } from "lucide-react";
import { saveBrowserFile } from "../../lib/browserSave";
import { displayCredits } from "../../lib/credits";
import { accessPptProject, continueGuestOriginal, createPptPresentation, deletePptPresentation, finishPptRequest, getPptChat, isPptPreflightError, LEGACY_PPT_PROJECT_ID, newPptChatSession, newPptProject, openPptLibrary, pptChatContext, PPT_MODEL_NAMES, requestPpt, selectPptPresentation, setPptChatDraft } from "../../lib/pptProject";
import PptChat from "./PptChat";
import PptSlide from "./PptSlide";
import PptPresentationBar from "./PptPresentationBar";
import PptExtensions from "./PptExtensions";
import PptPageActions from "./PptPageActions";
import PptRegeneratePages from "./PptRegeneratePages";
import PptOriginalTextEditor from "./PptOriginalTextEditor";
import PptGenerationProgress from "./PptGenerationProgress";
import usePptGeneration from "./usePptGeneration";
import { endPausedGeneration, finishPptStep, isPptStep, pptStepPageIndex, resumePptGeneration, startPptGeneration, startPptMotion, startPptRegeneration } from "../../lib/pptGeneration";
import "./ppt.css";

const high = "gpt-6.2-astra";
const middle = "gpt-6.2-sol";
const economy = "deepseek-v4.1-flash";

function draftKey(owner, projectId, chatId) {
  const prefix = "ppt-chat-draft:" + owner;
  if (projectId === LEGACY_PPT_PROJECT_ID) return prefix + (chatId === "initial" ? "" : ":" + chatId);
  return prefix + ":presentation:" + projectId + ":" + chatId;
}

function readDraft(key) {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function resumeGuestProject(current, guest) {
  if (current.pending) return current;
  const guestDraft = getPptChat(guest).draft;
  if (!current.revision) {
    return { ...setPptChatDraft(current, current.activeChatId, guestDraft), topic: guest.topic, pageCount: guest.pageCount,
      ...(guest.name && !current.name && { name: guest.name }),
      autoPageCount: guest.autoPageCount, motionEnabled: Boolean(guest.motionEnabled), model: guest.model, template: guest.template, references: guest.references, view: guest.view };
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
  const success = { chat: "回复已保存", edit: "修改已保存", generate: "演示稿已保存", regenerate: "指定页面已更新", motion: "动效编排已保存", partial: "处理已结束，已完成的内容已保存" };
  return <div className="ppt-receipt" role="status">{task.status === "failed" ? task.error || "任务未完成。" : success[task.action]}
    {billing?.status === "settled" && <> · 本次扣除 {displayCredits(billing.charged_credits)} 积分</>}
    {billing?.status === "refunded" && <> · 预留积分已退还</>}
    {task.note && <> · {task.note}</>}
  </div>;
}

export default function PptWorkspace(props) {
  const { owner } = props;
  const [library, setLibrary] = useState(null);
  const [libraryError, setLibraryError] = useState("");
  const refreshLibrary = useCallback(async () => {
    try {
      const guestId = owner !== "guest" && readDraft("ppt-open-guest-original");
      const next = guestId ? await continueGuestOriginal(owner, guestId) : await openPptLibrary(owner);
      if (guestId) sessionStorage.removeItem("ppt-open-guest-original");
      setLibrary(previous => {
        const id = previous?.activeId;
        // Keep each open tab on its own document, unless another tab deleted it.
        return !guestId && id && next.projects.some(item => item.id === id) ? { ...next, activeId: id } : next;
      });
      setLibraryError("");
    } catch (error) { setLibraryError(error.message || "无法读取本地演示稿。"); }
  }, [owner]);
  useEffect(() => {
    void refreshLibrary();
    window.addEventListener("focus", refreshLibrary);
    return () => window.removeEventListener("focus", refreshLibrary);
  }, [refreshLibrary]);
  if (!library) return <main className="studio-page ppt-workspace">
    {libraryError ? <div className="ppt-alert" role="alert">{libraryError}<button onClick={refreshLibrary}>重试</button></div> : <p role="status">正在打开演示稿…</p>}
  </main>;
  return <PptEditor key={library.activeId} {...props} projectId={library.activeId} library={library}
    onLibraryChange={setLibrary} onPresentationMissing={refreshLibrary} />;
}

function PptEditor({ owner, signedIn, authHeaders, onLogin, onAccountRefresh, projectId, library, onLibraryChange, onPresentationMissing }) {
  const [project, setProject] = useState(newPptProject);
  const [ready, setReady] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [topic, setTopic] = useState("");
  const [instruction, setInstruction] = useState("");
  const [selected, setSelected] = useState([]);
  const [mobileTool, setMobileTool] = useState("");
  const [index, setIndex] = useState(0);
  const [followGeneration, setFollowGeneration] = useState(true);
  const following = useRef(true);
  following.current = followGeneration;
  const [busy, setBusy] = useState("");
  const [alert, setAlert] = useState("");
  const [config, setConfig] = useState(null);
  const [metadataError, setMetadataError] = useState("");
  const [metadataAttempt, setMetadataAttempt] = useState(0);
  const [missingId, setMissingId] = useState("");
  const preview = useRef(null);
  const activeChat = getPptChat(project);
  const chatId = activeChat.id;
  const cacheKey = draftKey(owner, projectId, chatId);
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
  const changingPresentation = useRef(false);
  const headers = useRef(authHeaders);
  headers.current = authHeaders;
  const refresh = useRef(onAccountRefresh);
  refresh.current = onAccountRefresh;
  const patch = useCallback(async transform => {
    try {
      const next = await accessPptProject(owner, transform, projectId);
      if (mounted.current) setProject(old => old.revision <= next.revision ? next : old);
      return next;
    } catch (error) {
      if (mounted.current && error.code === "PPT_PROJECT_NOT_FOUND") void onPresentationMissing();
      throw error;
    }
  }, [owner, projectId, onPresentationMissing]);
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
      let initial = await patch();
      if (!active) return;
      const continuation = signedIn && sessionStorage.getItem("ppt-continue-after-login");
      if (continuation) {
        const guest = await accessPptProject("guest", undefined, continuation === "yes" ? LEGACY_PPT_PROJECT_ID : continuation)
          .catch(error => { if (error.code === "PPT_PROJECT_NOT_FOUND") return null; throw error; });
        if (guest && active) initial = await patch(current => resumeGuestProject(current, guest));
        if (active) sessionStorage.removeItem("ppt-continue-after-login");
      }
      if (active) { setProject(initial); setTopic(initial.topic); setReady(true); setLoadError(""); }
    })().catch(() => { if (active) setLoadError("暂时无法读取演示稿。请确认浏览器允许网站保存数据后重试。"); });
    const synchronize = () => { patch().then(current => { if (active && !topicDirty.current) setTopic(current.topic); }).catch(() => {}); };
    window.addEventListener("focus", synchronize);
    requestPpt("config", headers.current).then(data => { if (active) setConfig(data); }).catch(() => {});
    return () => { active = false; mounted.current = false; window.removeEventListener("focus", synchronize); };
  }, [owner, signedIn, patch, loadAttempt]);

  const run = project.generation;
  const original = Boolean(project.originalPptx);
  const producing = run?.status === "running" || run?.status === "paused";
  const planningMotion = producing && run.mode === "motion";
  const regenerating = producing && (run.mode === "regenerate" || planningMotion);
  const needsMetadata = original && project.deck?.slides.some(slide => typeof slide.nativeTiming !== "boolean" || typeof slide.nativeTransition !== "boolean");
  useEffect(() => {
    if (!ready || !needsMetadata || producing || project.pending) return;
    let active = true;
    (async () => {
      const { ensureOriginalMotionMetadata } = await import("../../lib/pptOriginal");
      const deck = await ensureOriginalMotionMetadata(project.deck, project.originalPptx);
      if (!active) return;
      await patch(current => current.revision === project.revision && !current.pending ? { ...current, deck } : current);
      if (active) setMetadataError("");
    })().catch(error => { if (active) setMetadataError(error.message || "暂时无法读取原稿动效。"); });
    return () => { active = false; };
  }, [ready, needsMetadata, producing, project.revision, project.pending, project.deck, project.originalPptx, patch, metadataAttempt]);
  const targetIndex = pptStepPageIndex(run);
  const pages = producing && !regenerating && !run.completed ? [] : project.deck?.slides || [];
  const pageIndex = producing && followGeneration ? (regenerating ? targetIndex : pages.length - 1) : Math.min(index, pages.length - 1);
  const page = pages[pageIndex];
  const firstThumbnail = original && pages.length > 16 ? Math.max(0, Math.min(pageIndex - 4, pages.length - 9)) : 0;
  const thumbnails = original && pages.length > 16 ? pages.slice(firstThumbnail, firstThumbnail + 9) : pages;
  useEffect(() => {
    if (!ready || owner !== "guest") return;
    try {
      if (original) sessionStorage.setItem("ppt-open-guest-original", projectId);
      else sessionStorage.removeItem("ppt-open-guest-original");
    } catch { /* The guest can always reopen the file after signing in. */ }
  }, [original, owner, projectId, ready]);
  const maxPages = config?.max_pages || 16;
  const locked = !ready || Boolean(project.pending) || Boolean(busy) || run?.status === "paused";
  const finish = useCallback(async (id, result) => {
    if (result.status === "processing") return;
    const next = await patch(current => isPptStep(current.pending?.action)
      ? finishPptStep(current, id, result) : finishPptRequest(current, id, result));
    if (mounted.current && next.pending?.id !== id) {
      setAlert(""); setMissingId("");
      if (next.lastTask?.action !== "chat") { setSelected([]); setInstruction(""); }
      if (following.current && next.lastTask?.id === id && next.generation?.status === "done" && ["generate", "regenerate", "motion"].includes(next.lastTask.action)) {
        setIndex(next.generation.targets?.at(-1)?.index ?? next.generation.completed - 1);
      }
      refresh.current?.();
    }
  }, [patch]);
  const { live, reconnect } = usePptGeneration(project.pending, signedIn, patch, headers, finish);
  const provisional = !original && !planningMotion && followGeneration && project.pending?.action === "page" && live?.elements.length > 0
    ? { title: run.outline.slides[targetIndex].title, background: live.background || run.settings.template?.background,
        elements: regenerating ? live.elements.map(el => el.type === "image" ? { ...el, src: page.elements.find(item => item.id === el.id)?.src } : el) : live.elements }
    : null;
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
    if (!project.pending || isPptStep(project.pending.action) || !signedIn) return;
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
        parsed.push(data);
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
    if (original && action === "edit") {
      try { await regeneratePages({ ids: [page.id], revision: project.revision, elementIds: selected }, instruction); }
      catch (error) { setAlert(error.message || "暂时无法修改原稿，请重试。"); }
      return;
    }
    if (original && action === "generate") return;
    if (!signedIn) {
      try {
        await patch(current => ({ ...setPptChatDraft(current, chatId, chatText), topic, activeChatId: chatId }));
      } catch (error) { setAlert(error.message); return; }
      if (!original) try { sessionStorage.setItem("ppt-continue-after-login", projectId); } catch { /* No transferable guest draft. */ }
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
      if (action === "generate") {
        await patch(current => startPptGeneration(current, topic));
        setFollowGeneration(true); setIndex(0); setSelected([]); setInstruction("");
        if (window.matchMedia("(max-width: 940px)").matches) preview.current?.scrollIntoView({ block: "start" });
        return;
      }
      const id = crypto.randomUUID();
      const snapshot = await patch(current => {
        if (current.pending || current.generation?.status === "paused") throw new Error("请先处理当前生成任务。");
        if (action === "edit" && JSON.stringify(page) !== JSON.stringify(current.deck?.slides.find(slide => slide.id === page?.id))) throw new Error("当前页已更新，请重新选择后修改。");
        const body = { request_id: id, model: current.model, references: current.references };
        if (action === "chat") Object.assign(body, pptChatContext(current, topic, chatText, page?.id, chatId));
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
  const currentTitle = project.name || project.deck?.title || project.topic.trim() || library.projects.find(item => item.id === projectId)?.title;
  async function regeneratePages(selection, requirements) {
    if (!signedIn) { onLogin(); return; }
    let started = false;
    await patch(current => {
      if (current.revision !== selection.revision) return current;
      started = true;
      return startPptRegeneration(current, selection.ids, requirements, topicDirty.current ? topic : current.topic,
        selection.elementIds && { elementIds: selection.elementIds });
    });
    if (!started) throw new Error("演示稿已更新，请取消后重新选择。");
    setFollowGeneration(true); setSelected([]); setInstruction(""); setAlert("");
  }
  async function planMotion() {
    if (locked || needsMetadata || submitting.current) return;
    if (!signedIn) { onLogin(); return; }
    submitting.current = true;
    try {
      await patch(startPptMotion);
      setFollowGeneration(true); setSelected([]); setAlert("");
    } catch (error) { setAlert(error.message || "暂时无法开始动效编排。"); }
    finally { submitting.current = false; }
  }
  async function download() {
    if (!project.deck) return;
    setBusy("正在准备导出…"); setAlert("");
    try {
      const name = Array.from(currentTitle || "演示文稿", ch => ch.codePointAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? "_" : ch).slice(0, 100).join("");
      await saveBrowserFile(name + (original ? "-修改稿.pptx" : ".pptx"), async () => {
        if (original) {
          const { exportOriginalPpt } = await import("../../lib/pptOriginal");
          return exportOriginalPpt(project.deck, project.originalPptx, Boolean(project.motionEnabled));
        }
        const { exportPptFile } = await import("../../lib/pptFiles");
        return exportPptFile({ ...project.deck, title: currentTitle }, project.deckTemplate || undefined, Boolean(project.motionEnabled));
      });
    } catch (error) { setAlert(error.message || "导出失败，请重试。"); }
    finally { if (mounted.current) setBusy(""); }
  }
  const switchPage = next => { setFollowGeneration(false); setIndex(next); setSelected([]); setInstruction(""); };
  const switchView = view => patch(current => current.view === view ? current : { ...current, view }).catch(error => setAlert(error.message));
  async function changePresentation(action, targetId, title = "", file) {
    if (locked || changingPresentation.current || (action !== "select" && targetId !== projectId)) return false;
    changingPresentation.current = true;
    setAlert("");
    setBusy(file ? "正在打开 PPTX 原稿…" : "正在更新演示稿…");
    try {
      if (action === "rename") {
        const name = title.trim();
        if (!name) throw new Error("请输入演示稿名称。");
        await patch(current => current.name === name ? current : { ...current, name });
        return true;
      }
      if (action !== "delete") {
        await patch(current => {
          if (current.pending) throw new Error("请等当前任务结束后再切换演示稿。");
          const saved = storeDraft(current);
          return topicDirty.current && saved.topic !== topic ? { ...saved, topic } : saved;
        });
      }
      let imported;
      if (action === "open-original") {
        const { importOriginalPpt } = await import("../../lib/pptOriginal");
        imported = await importOriginalPpt(file);
        if (!mounted.current) return false;
      }
      const next = imported ? await createPptPresentation(owner, imported.deck.title, imported)
        : action === "create" ? await createPptPresentation(owner, title)
        : action === "select" ? await selectPptPresentation(owner, targetId) : await deletePptPresentation(owner, targetId);
      if (action === "delete") {
        try {
          for (const chat of project.chatSessions) sessionStorage.removeItem(draftKey(owner, targetId, chat.id));
        } catch { /* Persistent project data was already removed from IndexedDB. */ }
      }
      if (mounted.current) onLibraryChange(next);
      return true;
    } catch (error) {
      if (error.code === "PPT_PROJECT_NOT_FOUND") void onPresentationMissing();
      if (mounted.current) setAlert(error.name === "QuotaExceededError" ? "浏览器存储空间不足，无法保存这份演示稿。" : error.message);
      return false;
    } finally {
      changingPresentation.current = false;
      if (mounted.current) setBusy("");
    }
  }
  const pageActions = !original && <PptPageActions page={page} count={pages.length} maxPages={maxPages}
    locked={locked} patch={patch} onSelectPage={switchPage} onError={setAlert} />;

  if (loadError && !ready) return <main className="studio-page ppt-workspace">
    <div className="ppt-alert" role="alert">{loadError}<button onClick={() => {
      setLoadError(""); setLoadAttempt(value => value + 1);
    }}>重试</button></div>
  </main>;

  return <main className="studio-page ppt-workspace">
    <header className="ppt-heading"><div className="ppt-heading-icon"><Presentation size={25}/></div><div><h1>一键 PPT</h1><p>演示稿保存在此设备，可导出为 PPTX。</p></div>
      <div className="ppt-view-switch ppt-segments" role="group" aria-label="工作区视图">
        <button aria-pressed={!showChat} disabled={!ready} onClick={() => switchView("preview")}><Presentation size={16}/>演示稿预览</button>
        <button aria-pressed={showChat} disabled={!ready} onClick={() => switchView("chat")}><MessageSquare size={16}/>AI 对话</button>
      </div>
    </header>
    <PptExtensions project={project} locked={locked} onOpen={file => changePresentation("open-original", projectId, "", file)}
      onToggle={enabled => update({ motionEnabled: enabled })} onPlan={planMotion} metadataLoading={needsMetadata}
      metadataError={needsMetadata ? metadataError : ""} onRetryMetadata={() => { setMetadataError(""); setMetadataAttempt(value => value + 1); }}/>
    <PptPresentationBar projects={library.projects} projectId={projectId} currentTitle={currentTitle} locked={locked}
      onCreate={title => changePresentation("create", projectId, title)} onRename={(id, title) => changePresentation("rename", id, title)}
      onSelect={id => changePresentation("select", id)}
      onDelete={id => changePresentation("delete", id)} />
    {alert && <div role="alert" className="ppt-alert">{alert}<button aria-label="关闭提示" onClick={() => setAlert("")}><X size={16}/></button></div>}
    <div className={"ppt-columns" + (showChat ? " ppt-columns-chat" : "") + (page || provisional ? " ppt-has-pages" : "")} data-mobile-tool={mobileTool}>
      <section className="ppt-brief" aria-label={original ? "原稿设置" : "生成设置"}>
        <h2><Layers size={17}/>{original ? "原稿设置" : "生成设置"}</h2>
        {original && <p className="ppt-original-source"><FileText size={16}/><span>{project.originalPptx.name}<small>{pages.length} 页 · 浏览器本地副本</small></span></p>}
        <label className="ppt-field">{original ? "修改背景（选填）" : "演示主题"}<textarea rows={original ? 2 : 4} maxLength={6000} placeholder={original ? "例如：这是一份小组文献汇报，我负责研究方法部分" : "例如：为设计团队做一份季度项目复盘，突出成果与下季度计划"} value={topic} disabled={locked} onChange={event => { topicDirty.current = true; setTopic(event.target.value); }} onBlur={() => { if (ready && topicDirty.current && topic !== project.topic) update({ topic }); }}/></label>
        {!original && <fieldset disabled={locked} className="ppt-page-count">
          <legend>页数</legend>
          <div className="ppt-segments">
            <button type="button" aria-pressed={!project.autoPageCount} onClick={() => update({ autoPageCount: false })}>手动指定</button>
            <button type="button" aria-pressed={Boolean(project.autoPageCount)} onClick={() => update({ autoPageCount: true })}>由模型决定</button>
          </div>
          {project.autoPageCount ? <p>模型会根据主题和参考资料生成 1–{maxPages} 页。</p> :
            <label className="ppt-field ppt-inline">生成页数<input aria-label="页数" type="number" min="1" max={maxPages} key={project.pageCount} defaultValue={project.pageCount} onBlur={event => {
              const value = Math.max(1, Math.min(maxPages, Math.round(Number(event.target.value) || 6))); event.target.value = value; update({ pageCount: value });
            }}/></label>}
        </fieldset>}
        <fieldset className="ppt-models" disabled={locked}><legend>生成模型</legend><div className="ppt-segments">
          <button aria-pressed={project.model !== economy} onClick={() => update({ model: high })}>高级模型</button>
          <button aria-pressed={project.model === economy} onClick={() => update({ model: economy })}>性价比模型</button>
        </div>{project.model === economy ? <p>{PPT_MODEL_NAMES[economy]}</p> : <select aria-label="高级模型" value={project.model} onChange={event => update({ model: event.target.value })}><option value={high}>GPT 6.2 Astra · 高级</option><option value={middle}>GPT 6.2 Sol · 均衡</option></select>}
        </fieldset>
        <fieldset className="ppt-attachments" disabled={locked}><legend>{original ? "补充资料" : "模板与参考资料"}</legend>
          <label className="ppt-upload"><FileUp size={16}/>{project.template ? "更换 PPT 模板" : "添加 PPT 模板"}<input type="file" accept=".pptx" aria-label="上传 PPT 模板" onChange={event => { const files = [...event.target.files]; event.target.value = ""; importFiles(files, "template"); }}/><small>.pptx</small></label>
          <small className="ppt-format-help">{original ? "可另附一份 PPT 供 AI 参考内容与结构，导出沿用原稿版式。" : "生成新稿时参考模板的配色、字体和布局。"}</small>
          {project.template && <div className="ppt-file"><Check size={14}/><span>{project.template.source?.name || project.template.file?.name}</span><button aria-label="移除模板" onClick={() => update({ template: null })}><X size={14}/></button></div>}
          <label className="ppt-upload"><Paperclip size={16}/>添加参考资料<input type="file" multiple accept=".pptx,.docx,.xlsx,.pdf,.txt,.md,.csv" aria-label="上传参考资料" onChange={event => { const files = [...event.target.files]; event.target.value = ""; importFiles(files, "reference"); }}/><small>{project.references.length}/8</small></label>
          {project.references.map((source, i) => <div className="ppt-file" key={i}><FileText size={14}/><span>{source.name}</span><button aria-label={"移除 " + source.name} onClick={() => patch(current => current.pending ? current : { ...current, references: current.references.filter((_, n) => n !== i) }).catch(error => setAlert(error.message))}><X size={14}/></button></div>)}
          <details className="ppt-format-help"><summary>支持的格式与大小<ChevronDown size={14} aria-hidden="true"/></summary><p>支持 PPTX、DOCX、XLSX、PDF、TXT、MD 和 CSV，单个文件最多 24 MB。每份参考资料读取前 12,000 字，PDF 最多读取前 100 页。</p></details>
        </fieldset>
        {!original && <button className="ppt-primary" disabled={locked || !topic.trim()} onClick={async () => { await switchView("preview"); await submit("generate"); }}><Sparkles size={17}/>{producing ? (planningMotion ? (run.status === "paused" ? "动效编排已暂停" : "正在编排动效") : run.status === "paused" ? "生成已暂停" : regenerating ? "正在重做指定页" : "正在生成演示稿") : project.deck ? "重新生成演示稿" : "生成演示稿"}</button>}
        {!original && !producing && <small className="ppt-format-help">大纲和每页按实际 Token 分别结算。</small>}
      </section>
      <section ref={preview} className="ppt-editor" aria-label={showChat ? "AI 对话" : "演示稿预览"}>
        {showChat ? <PptChat sessions={project.chatSessions} activeChatId={chatId} onNewChat={() => selectChat()} onSelectChat={selectChat} historyDisabled={!ready}
          turns={activeChat.turns} pending={pendingChat} model={project.model} busy={locked}
          composerDisabled={!ready || Boolean(pendingChat) || (!project.pending && Boolean(busy))}
          value={pendingChat ? "" : chatText} onChange={changeDraft} onSaveDraft={saveDraft}
          onSend={() => submit("chat")} onUseTopic={async text => {
            await update({ topic: text }); setTopic(text); topicDirty.current = false; await switchView("preview");
          }}/> : <>
        <header className="ppt-preview-header"><div><Presentation size={17}/><h2>{project.name || (producing && run.outline?.title) || project.deck?.title || "演示稿预览"}</h2></div>
          <div className="ppt-preview-actions"><PptRegeneratePages project={project} page={page} locked={locked} onStart={regeneratePages}/>
            <button className="ppt-export" disabled={!page || Boolean(busy)} onClick={download}><ArrowDownToLine size={16}/>{producing && !regenerating && run.completed ? "导出已完成页" : "导出 PPTX"}</button></div>
        </header>
        <PptGenerationProgress generation={run} live={live} following={followGeneration} onFollow={() => setFollowGeneration(true)} onReconnect={reconnect}
          onResume={() => patch(resumePptGeneration).catch(error => setAlert(error.message))}
          onEnd={() => patch(endPausedGeneration).catch(error => setAlert(error.message))} />
        {page || provisional ? <>
          {original && <p className="ppt-format-help">原稿预览 · 可修改文本框和表格文字。复杂图形、动画及母版效果以导出的 PPTX 为准。</p>}
          <div className="ppt-paper" style={original ? {aspectRatio: page.originalAspectRatio} : undefined}><PptSlide key={provisional ? project.pending.id : page.id} slide={provisional || page} selected={selected} font={(provisional ? run.settings.template?.font : project.deckFont) || "Microsoft YaHei, sans-serif"} onSelect={locked ? undefined : ids => { setSelected(ids); if (ids.length) setMobileTool("edit"); }}/></div>
          <div className="ppt-pagebar"><span>{provisional ? `第 ${targetIndex + 1} 页 · 生成中` : `${pageIndex + 1} / ${pages.length} 页`}</span>{pageActions}<div><button aria-label="上一页" disabled={provisional && !regenerating ? !pages.length : pageIndex <= 0} onClick={() => switchPage(provisional && !regenerating ? pages.length - 1 : pageIndex - 1)}><ChevronLeft size={17}/></button><button aria-label="下一页" disabled={pageIndex >= pages.length - 1} onClick={() => switchPage(pageIndex + 1)}><ChevronRight size={17}/></button></div></div>
          <div className="ppt-mobile-tools" role="group" aria-label="页面工具">
            <button type="button" aria-expanded={mobileTool === "pages"} onClick={() => setMobileTool(tool => tool === "pages" ? "" : "pages")}><Layers size={16}/>缩略图</button>
            {page && !provisional && <button type="button" aria-expanded={mobileTool === "edit"} onClick={() => setMobileTool(tool => tool === "edit" ? "" : "edit")}><MousePointer2 size={16}/>编辑本页</button>}
          </div>
          {original && pages.length > 16 && <label className="ppt-field ppt-inline ppt-jump-page">跳到第几页<select value={pageIndex} onChange={event => switchPage(Number(event.target.value))}>
            {pages.map((slide, i) => <option key={slide.id} value={i}>{i + 1} · {slide.title}</option>)}
          </select></label>}
          <div className="ppt-thumbnails" aria-label="选择幻灯片">{thumbnails.map((slide, i) => {
            const position = firstThumbnail + i;
            return <button key={slide.id} aria-label={`第 ${position + 1} 页 ${slide.title}`} aria-current={!provisional && page?.id === slide.id ? "page" : undefined} onClick={() => switchPage(position)}>
              <PptSlide slide={slide} font={project.deckFont || "Microsoft YaHei, sans-serif"}/><span>{position + 1}</span>
            </button>;
          })}</div>
          {page && !provisional && <section className="ppt-edit"><div><strong><MousePointer2 size={16}/>{original ? "修改原稿文字" : "局部修改"}</strong><button disabled={locked} onClick={() => setSelected(page.elements.filter(el => !original || typeof el.originalText === "string").map(el => el.id))}>{original ? "选择本页文字" : "选择整页"}</button></div>
            <p>{selected.length ? `已选中 ${selected.length} 个${original ? "文本框或单元格" : "元素"}` : original ? "点选文字或拖动框选，多页修改可使用上方的「修改指定页」。" : "点选元素，或在页面上拖动框选多个元素。"}</p>
            {original && selected.length === 1 && <PptOriginalTextEditor page={page} element={page.elements.find(el => el.id === selected[0])} locked={locked} patch={patch}/>}
            <label className="ppt-field"><span className="sr-only">修改要求</span><textarea disabled={locked} rows={2} maxLength={6000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="希望怎样修改选中的内容？"/></label>
            <button className="ppt-secondary" disabled={locked || !instruction.trim() || !selected.length} onClick={() => submit("edit")}><Sparkles size={15}/>应用 AI 修改</button>
          </section>}
        </> : producing ? null : <div className="ppt-empty">
          <div className="ppt-empty-stack" aria-hidden="true">
            <div className="ppt-cover"><div className="ppt-cover-lines"><i/><i/><i/></div><span className="ppt-cover-arc"/></div>
          </div>
          <h3>演示稿将在这里预览</h3><p>可以先新建一页，也可以填写主题后让 AI 生成。</p>
          {pageActions}
        </div>}</>}
        {(!isPptStep(project.pending?.action) && (project.pending || busy)) && <div className="ppt-progress" role="status"><LoaderCircle size={16} className="ppt-spin"/><span>{showChat && project.pending?.action === "chat" && !pendingChat ? "另一段对话正在等待回复…" : busy || "正在查询原任务…"}{project.pending && <small>刷新页面后会继续查询本次任务。</small>}</span>{project.pending && !busy && <button onClick={() => check(project.pending, true)}><RefreshCw size={15}/>查询</button>}</div>}
        {showChat && producing && <div className="ppt-progress"><span>{run.status === "paused" ? "演示稿生成已暂停。" : "演示稿正在生成。"}</span><button onClick={() => switchView("preview")}>查看生成进度</button></div>}
        {project.pending?.body && missingId === project.pending.id && <button className="ppt-secondary" disabled={Boolean(busy)} onClick={() => submit(project.pending.action, true)}>用原任务编号再次提交</button>}
        {!project.pending && (showChat ? project.lastTask?.chatId === chatId : project.lastTask?.action !== "chat") && <BillingNote task={project.lastTask}/>}
      </section>
    </div>
  </main>;
}
