const storeName = "projects";
const initialChatId = "initial";
export const LEGACY_PPT_PROJECT_ID = "initial";
let connection;

export function newPptChatSession(id = crypto.randomUUID()) {
  return { id, turns: [], draft: "", updatedAt: Date.now() };
}

export function newPptProject() {
  return {
    revision: 0, topic: "", model: "gpt-6.2-astra", pageCount: 6, autoPageCount: false, references: [],
    template: null, deck: null, deckTemplate: null, deckFont: null, motionEnabled: false, pending: null, lastTask: null,
    chatSessions: [newPptChatSession(initialChatId)], activeChatId: initialChatId, view: "preview",
  };
}

export function restorePptProject(stored) {
  const fresh = newPptProject();
  if (!stored) return fresh;
  const { chatDraft = "", chatTurns = [], ...fields } = stored;
  const chatSessions = fields.chatSessions?.length ? fields.chatSessions : [{
    id: initialChatId, turns: chatTurns, draft: chatDraft, updatedAt: stored.pending?.action === "chat" ? stored.pending.at || 0 : 0,
  }];
  const project = { ...fresh, ...fields, chatSessions };
  if (!getPptChat(project)) project.activeChatId = chatSessions[0].id;
  // Requests already submitted by the single-chat client belong to its original thread.
  for (const key of ["pending", "lastTask"]) {
    const task = project[key];
    if (task?.action === "chat" && !task.chatId) project[key] = { ...task, chatId: initialChatId };
  }
  return project;
}

export function getPptChat(project, id = project.activeChatId) {
  return project.chatSessions.find(session => session.id === id);
}

export function setPptChatDraft(project, id, draft) {
  const session = getPptChat(project, id);
  if (!session || session.draft === draft) return project;
  const updated = { ...session, draft, updatedAt: Date.now() };
  return { ...project, chatSessions: project.chatSessions.map(item => item.id === id ? updated : item) };
}

function database() {
  if (connection) return connection;
  const opening = new Promise((resolve, reject) => {
    const request = indexedDB.open("posterflow-ppt-projects", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = forget;
      db.onversionchange = () => { forget(); db.close(); };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
  function forget() {
    if (connection === opening) connection = null;
  }
  connection = opening;
  opening.catch(forget);
  return opening;
}

async function beginTransaction() {
  for (let attempt = 0; ; attempt++) {
    const opening = database();
    const db = await opening;
    try {
      return db.transaction(storeName, "readwrite");
    } catch (error) {
      // An explicit close() does not emit a close event. No transaction has
      // started here, so reopening once cannot replay any reads or writes.
      if (error.name !== "InvalidStateError") throw error;
      if (connection === opening) connection = null;
      db.close();
      if (attempt > 0) throw error;
    }
  }
}

function projectKey(owner, id) {
  return id === LEGACY_PPT_PROJECT_ID ? owner : [owner, "presentation", id];
}

function readRow(store, key) {
  return new Promise((resolve, reject) => {
    const read = store.get(key);
    read.onsuccess = () => resolve(read.result);
    read.onerror = () => reject(read.error);
  });
}

function describeProject(id, project, updatedAt) {
  const title = project.name || project.deck?.title || project.topic?.trim() || `未命名演示稿 ${project.draftNumber || 1}`;
  return { id, title,
    updatedAt, pageCount: project.deck?.slides?.length || 0, pending: Boolean(project.pending) };
}

function requirePresentation(library, id) {
  if (!library.projects.some(entry => entry.id === id)) {
    throw Object.assign(new Error("这份演示稿已被删除，请重新选择。"), { code: "PPT_PROJECT_NOT_FOUND" });
  }
}

// Keep the original owner key for the legacy presentation, including its pending
// request. The catalog is authoritative so stale tabs cannot recreate deleted drafts.
async function withLibrary(owner, operate) {
  if (typeof owner !== "string" || !owner.trim()) throw new Error("请先选择账户。");
  const tx = await beginTransaction();
  const store = tx.objectStore(storeName);
  const catalogKey = [owner, "library"];
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("保存演示稿失败，请检查浏览器存储空间。"));
  });
  finished.catch(() => {});
  try {
    let library = await readRow(store, catalogKey);
    if (!library) {
      const original = await readRow(store, owner);
      const project = restorePptProject(original);
      const id = LEGACY_PPT_PROJECT_ID;
      library = { activeId: id, nextDraftNumber: 2, projects: [describeProject(id, project, Date.now())] };
      if (!original) store.put(project, owner);
      store.put(library, catalogKey);
    }
    const result = await operate(store, library, catalogKey);
    await finished;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* Already completed or aborted. */ }
    throw error;
  }
}

export function openPptLibrary(owner) {
  return withLibrary(owner, (_store, library) => library);
}

function insertPresentation(store, owner, library, title, fields, id = crypto.randomUUID()) {
  const project = { ...newPptProject(), ...fields, draftNumber: library.nextDraftNumber };
  if (title?.trim()) project.name = title.trim();
  store.add(project, projectKey(owner, id));
  return { activeId: id, nextDraftNumber: project.draftNumber + 1, projects: [describeProject(id, project, Date.now()), ...library.projects] };
}

export function createPptPresentation(owner, title, original) {
  return withLibrary(owner, (store, library, key) => {
    const fields = original && { deck: original.deck, originalPptx: original.originalFile };
    const next = insertPresentation(store, owner, library, title, fields);
    store.put(next, key);
    return next;
  });
}

// Signing in after opening a local file creates a separate account draft.
// A stable destination lets a refresh or a second tab finish the handoff once.
export function continueGuestOriginal(owner, guestId) {
  return withLibrary(owner, async (store, library, key) => {
    const id = "guest-original-" + guestId;
    let next;
    if (library.projects.some(entry => entry.id === id)) {
      next = { ...library, activeId: id };
    } else {
      const guest = await readRow(store, projectKey("guest", guestId));
      if (!guest?.originalPptx || !guest.deck) return library;
      next = insertPresentation(store, owner, library, guest.name, {
        originalPptx: guest.originalPptx, deck: guest.deck, references: guest.references, model: guest.model,
          topic: guest.topic, template: guest.template, motionEnabled: Boolean(guest.motionEnabled),
          chatSessions: guest.chatSessions, activeChatId: guest.activeChatId,
      }, id);
    }
    store.put(next, key);
    return next;
  });
}

export function selectPptPresentation(owner, id) {
  return withLibrary(owner, (store, library, key) => {
    requirePresentation(library, id);
    if (library.activeId === id) return library;
    const next = { ...library, activeId: id };
    store.put(next, key);
    return next;
  });
}

export function deletePptPresentation(owner, id) {
  return withLibrary(owner, async (store, library, key) => {
    requirePresentation(library, id);
    const dataKey = projectKey(owner, id);
    const project = await readRow(store, dataKey);
    if (project?.pending) throw new Error("这份演示稿还有进行中的任务，请等任务结束后再删除。");
    store.delete(dataKey);
    const projects = library.projects.filter(entry => entry.id !== id);
    let next = { ...library, activeId: library.activeId === id ? projects[0]?.id : library.activeId, projects };
    if (!projects.length) next = insertPresentation(store, owner, next);
    store.put(next, key);
    return next;
  });
}

// Pass the presentation ID captured at submission to update the original
// presentation even if another tab subsequently switches the active one.
export function accessPptProject(owner, update, projectId) {
  return withLibrary(owner, async (store, library, catalogKey) => {
    const id = projectId ?? library.activeId;
    requirePresentation(library, id);
    const key = projectKey(owner, id);
    const row = await readRow(store, key);
    if (!row) throw new Error("本机未找到这份演示稿的数据。");
    const current = restorePptProject(row);
    const changed = update ? update(current) : current;
    if (changed === current) return current;
    const next = { ...changed, revision: current.revision + 1 };
    const summary = describeProject(id, next, Date.now());
    store.put(next, key);
    store.put({ ...library, projects: [summary, ...library.projects.filter(entry => entry.id !== id)] }, catalogKey);
    return next;
  });
}

export function pptChatContext(project, topic, message, slideId, chatId = project.activeChatId) {
  const slides = project.deck?.slides || [];
  const currentSlide = slides.find(slide => slide.id === slideId);
  // Chat accepts sixteen titles. For a longer original, give it the nearby pages.
  const firstTitle = Math.max(0, Math.min(slides.indexOf(currentSlide) - 7, slides.length - 16));
  const nearby = project.originalPptx ? slides.slice(firstTitle, firstTitle + 16) : slides;
  const context = { topic: topic.trim(), message: message.trim(), references: project.references,
    deck_title: (project.deck?.title || "").slice(0, 240),
    slide_titles: nearby.map((slide, i) => (slide.title || `第 ${firstTitle + i + 1} 页`).slice(0, 240)),
    slide_text: (currentSlide?.elements || []).filter(el => el.type === "text" && !el.originalLocked).map(el => el.text).join("\n").slice(0, 12000) };
  // Reserve space for the server instructions and include the newest complete turns that fit.
  const encoder = new TextEncoder();
  let remaining = 195000 - encoder.encode(JSON.stringify(context)).byteLength;
  const history = [];
  const session = getPptChat(project, chatId);
  if (!session) throw new Error("找不到当前对话，请重新选择后发送。");
  for (const turn of session.turns.slice(-20).reverse()) {
    const pair = [{ role: "user", content: turn.message }, { role: "assistant", content: turn.reply }];
    const size = encoder.encode(JSON.stringify(pair)).byteLength;
    if (size > remaining) break;
    history.unshift(...pair);
    remaining -= size;
  }
  return { ...context, history };
}

export function finishPptRequest(project, requestId, result) {
  const pending = project.pending;
  if (pending?.id !== requestId || !["succeeded", "failed"].includes(result.status)) return project;
  let deck = project.deck;
  let deckTemplate = project.deckTemplate;
  let deckFont = project.deckFont;
  let chatSessions = project.chatSessions;
  const chatId = pending.action === "chat" ? pending.chatId || initialChatId : undefined;
  if (result.status === "succeeded") {
    if (pending.action === "chat" && typeof result.reply === "string" && result.reply.trim()) {
      const session = getPptChat(project, chatId);
      if (!session) throw new Error("找不到原任务所属的对话。");
      const message = pending.body.message;
      const turn = { id: requestId, model: pending.model, message, reply: result.reply };
      const updated = { ...session, turns: [...session.turns, turn], updatedAt: Date.now(),
        draft: session.draft.trim() === message.trim() ? "" : session.draft };
      chatSessions = chatSessions.map(item => item.id === chatId ? updated : item);
    } else if (pending.action === "generate" && result.deck?.slides?.length) {
      deck = result.deck;
      deckTemplate = project.template?.file || project.template?.template || null;
      deckFont = project.template?.template?.font || null;
    } else if (pending.action === "edit" && result.slide && deck?.slides.some(slide => slide.id === pending.slideId)) {
      deck = { ...deck, slides: deck.slides.map(slide => slide.id === pending.slideId ? result.slide : slide) };
    } else {
      throw new Error("结果格式不完整，请稍后查询原任务。");
    }
  }
  return { ...project, deck, deckTemplate, deckFont, chatSessions, pending: null,
    lastTask: { id: requestId, action: pending.action, ...(chatId && { chatId }), model: pending.model,
      status: result.status, billing: result.billing, error: result.error?.message, note: result.note?.message } };
}

export const PPT_MODEL_NAMES = {
  "gpt-6.2-astra": "GPT 6.2 Astra", "gpt-6.2-sol": "GPT 6.2 Sol", "deepseek-v4.1-flash": "DeepSeek 4.1 Flash",
};

export function isPptPreflightError(error) {
  return ["INSUFFICIENT_CREDITS", "ACCOUNT_FROZEN", "EMAIL_UNVERIFIED", "PPT_INPUT_INVALID",
    "PPT_PENDING_LIMIT", "PPT_MODEL_UNAVAILABLE"].includes(error.code) || Boolean(error.code && error.status === 401);
}

function pptError(data, status) {
  const error = new Error(data?.error?.message || data?.message || "PPT 服务暂时无法连接，请稍后重试。");
  error.status = status;
  error.code = data?.error?.code || data?.code;
  return error;
}

async function readPptEvents(response, onFrame) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : lines.pop();
      if (buffer.length > 1024 * 1024) throw new Error("生成进度响应过大。");
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "result" && event.data) return event.data;
        if (event.type === "error") throw pptError(event, event.status || 503);
        if (event.type === "progress" || event.type === "element") onFrame(event);
      }
      if (done) throw new Error("生成进度连接已结束，正在确认结果。");
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function requestPpt(path, headers, body, onFrame, signal) {
  const outbound = new Headers(headers);
  if (body) outbound.set("Content-Type", "application/json");
  if (onFrame && typeof ReadableStream !== "undefined") outbound.set("Accept", "application/x-ndjson");
  const response = await fetch("/api/ppt/" + path, {
    method: body ? "POST" : "GET",
    headers: outbound, signal,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (response.ok && onFrame && response.headers.get("Content-Type")?.split(";")[0].trim() === "application/x-ndjson") {
    return readPptEvents(response, onFrame);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw pptError(data, response.status);
  return data;
}
