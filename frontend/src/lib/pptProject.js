const storeName = "projects";
const initialChatId = "initial";
let connection;

export function newPptChatSession(id = crypto.randomUUID()) {
  return { id, turns: [], draft: "", updatedAt: Date.now() };
}

export function newPptProject() {
  return {
    revision: 0, topic: "", model: "gpt-6.2-astra", pageCount: 6, autoPageCount: false, references: [],
    template: null, deck: null, deckTemplate: null, deckFont: null, pending: null, lastTask: null,
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
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open("posterflow-ppt-projects", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(error => { connection = null; throw error; });
  return connection;
}

// Reserve a request and save its id in one transaction, including across tabs.
export async function accessPptProject(owner, update) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, update ? "readwrite" : "readonly");
    const store = tx.objectStore(storeName);
    let next;
    let cause;
    const read = store.get(owner);
    read.onsuccess = () => {
      try {
        const current = restorePptProject(read.result);
        next = update ? update(current) : current;
        if (update && next !== current) {
          next = { ...next, revision: current.revision + 1 };
          store.put(next, owner);
        }
      } catch (error) {
        cause = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(cause || tx.error || new Error("保存演示稿失败，请检查浏览器存储空间。"));
    tx.onerror = () => reject(tx.error);
  });
}

export function pptChatContext(project, topic, message, slideId, chatId = project.activeChatId) {
  const slides = project.deck?.slides || [];
  const currentSlide = slides.find(slide => slide.id === slideId);
  const context = { topic: topic.trim(), message: message.trim(), references: project.references,
    deck_title: project.deck?.title || "", slide_titles: slides.map(slide => slide.title),
    slide_text: (currentSlide?.elements || []).filter(el => el.type === "text").map(el => el.text).join("\n").slice(0, 12000) };
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
      deckTemplate = project.template?.file || null;
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

export async function requestPpt(path, headers, body) {
  const response = await fetch("/api/ppt/" + path, {
    method: body ? "POST" : "GET",
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error?.message || data?.message || "PPT 服务暂时无法连接，请稍后重试。");
    error.status = response.status;
    error.code = data?.error?.code || data?.code;
    throw error;
  }
  return data;
}
