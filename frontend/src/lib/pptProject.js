const storeName = "projects";
let connection;

export function newPptProject() {
  return {
    revision: 0, topic: "", model: "gpt-6.2-astra", pageCount: 6, references: [],
    template: null, deck: null, deckTemplate: null, deckFont: null, pending: null, lastTask: null,
  };
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
      const current = read.result || newPptProject();
      try {
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

export function finishPptRequest(project, requestId, result) {
  const pending = project.pending;
  if (pending?.id !== requestId || !["succeeded", "failed"].includes(result.status)) return project;
  let deck = project.deck;
  let deckTemplate = project.deckTemplate;
  let deckFont = project.deckFont;
  if (result.status === "succeeded") {
    if (pending.action === "generate" && result.deck?.slides?.length) {
      deck = result.deck;
      deckTemplate = project.template?.file || null;
      deckFont = project.template?.template?.font || null;
    } else if (pending.action === "edit" && result.slide && deck?.slides.some(slide => slide.id === pending.slideId)) {
      deck = { ...deck, slides: deck.slides.map(slide => slide.id === pending.slideId ? result.slide : slide) };
    } else {
      throw new Error("结果格式不完整，请稍后查询原任务。");
    }
  }
  return { ...project, deck, deckTemplate, deckFont, pending: null,
    lastTask: { id: requestId, action: pending.action, model: pending.model, status: result.status, billing: result.billing, error: result.error?.message, note: result.note?.message } };
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
