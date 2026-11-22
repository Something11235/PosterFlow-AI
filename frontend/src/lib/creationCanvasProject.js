import { readGuestCanvasLogin, forgetGuestCanvasLogin } from "./creationCanvasLogin.js";

const DB_NAME = "posterflow-creation-canvas";
const PROJECTS = "projects";
const ASSETS = "assets";
const LAST = "lastProject";

function validateOwner(owner) {
  if (typeof owner !== "string" || !owner.trim()) throw new Error("账户尚未就绪，请稍后再打开画布。");
}

function request(query) {
  return new Promise((resolve, reject) => {
    query.onsuccess = () => resolve(query.result);
    query.onerror = () => reject(query.error);
  });
}

async function openDb() {
  if (!globalThis.indexedDB) throw new Error("请允许浏览器保存网站数据后再打开创作画布。");
  const query = indexedDB.open(DB_NAME, 1);
  query.onupgradeneeded = () => {
    const projects = query.result.createObjectStore(PROJECTS, { keyPath: ["owner", "id"] });
    projects.createIndex("owner", "owner");
    const assets = query.result.createObjectStore(ASSETS, { keyPath: ["owner", "projectId", "id"] });
    assets.createIndex("project", ["owner", "projectId"]);
    query.result.createObjectStore(LAST);
  };
  return request(query);
}

// A write is durable before this promise resolves. In particular the generator
// must not dispatch a paid request until the claim's transaction has committed.
async function access(owner, stores, mode, callback) {
  validateOwner(owner);
  const db = await openDb();
  try {
    const tx = db.transaction(stores, mode);
    const finished = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("本地保存未完成，请重试。"));
    });
    finished.catch(() => {});
    try {
      const value = await callback(tx);
      await finished;
      return value;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction already finished. */ }
      if (error?.name === "QuotaExceededError") throw new Error("浏览器存储空间不足，请清理空间后再保存项目。");
      throw error;
    }
  } finally { db.close(); }
}

function projectKey(owner, id) {
  if (!id) throw new Error("请选择画布项目。");
  return [owner, id];
}

function assertProject(project) {
  if (!project) throw new Error("当前账户下没有找到这个画布项目。");
  return project;
}

function makeProject(owner, initial) {
  const time = Date.now();
  return {
    nodes: [], edges: [], ...initial,
    name: initial.name?.trim() || "未命名项目",
    owner, id: crypto.randomUUID(), createdAt: time, updatedAt: time, revision: 0,
  };
}

async function insertProject(tx, owner, initial) {
  const project = makeProject(owner, initial);
  await request(tx.objectStore(PROJECTS).add(project));
  await request(tx.objectStore(LAST).put(project.id, owner));
  return project;
}

export function createCanvasProject(owner, initial = {}) {
  return access(owner, [PROJECTS, LAST], "readwrite", tx => insertProject(tx, owner, initial));
}

export function loadCanvasProject(owner, id) {
  return access(owner, PROJECTS, "readonly", async tx =>
    (await request(tx.objectStore(PROJECTS).get(projectKey(owner, id)))) ?? null);
}

async function readLast(tx, owner) {
  const id = await request(tx.objectStore(LAST).get(owner));
  return id ? (await request(tx.objectStore(PROJECTS).get([owner, id]))) ?? null : null;
}

export function loadLastCanvasProject(owner) {
  return access(owner, [PROJECTS, LAST], "readonly", tx => readLast(tx, owner));
}

// Two freshly opened tabs (or React StrictMode) must agree on the first project.
export function openOrCreateCanvasProject(owner, initial = {}) {
  return access(owner, [PROJECTS, LAST], "readwrite", async tx =>
    (await readLast(tx, owner)) || insertProject(tx, owner, initial));
}

export function setLastCanvasProject(owner, id) {
  return access(owner, [PROJECTS, LAST], "readwrite", async tx => {
    const project = assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, id))));
    await request(tx.objectStore(LAST).put(id, owner));
    return project;
  });
}

export function listCanvasProjects(owner) {
  return access(owner, PROJECTS, "readonly", async tx => {
    const all = await request(tx.objectStore(PROJECTS).index("owner").getAll(owner));
    return all.map(({ id, name, updatedAt }) => ({ id, name, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}

async function writeProject(tx, project, next = project) {
  const row = { ...next, owner: project.owner, id: project.id, createdAt: project.createdAt,
    updatedAt: Date.now(), revision: (project.revision ?? 0) + 1 };
  await request(tx.objectStore(PROJECTS).put(row));
  return row;
}

function projectAssetIds(project) {
  const ids = new Set();
  for (const node of project.nodes) {
    for (const id of [node.assetId, node.run?.assetId, node.run?.lastFrameAssetId]) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function releaseRemovedAssets(tx, owner, before, saved) {
  const retained = projectAssetIds(saved);
  for (const id of before) {
    if (!retained.has(id)) await request(tx.objectStore(ASSETS).delete([owner, saved.id, id]));
  }
}

export function updateCanvasProject(owner, id, change) {
  return access(owner, [PROJECTS, ASSETS], "readwrite", async tx => {
    const current = assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, id))));
    const before = projectAssetIds(current);
    const runs = new Map(current.nodes.filter(node => node.run).map(node => [node.id, node.run]));
    const next = change(current) ?? current;
    if (typeof next.then === "function") throw new Error("项目修改应在本地事务内同步完成。");
    const kept = new Set(next.nodes.map(n => n.id));
    for (const [nodeId, run] of runs) {
      if (run.status === "pending" && !kept.has(nodeId)) {
        throw new Error("这个节点还有任务待确认，请先查询任务结果。");
      }
    }
    // Moving a node in another tab must never overwrite a newer request ID
    // or its result, even when the view has not received that change yet.
    const nodes = next.nodes.map(node => {
      const run = runs.get(node.id);
      if (!run) return node;
      // A video element may only learn the real duration after its result was
      // saved. Associate this observation with exactly that completed run.
      const observed = node.run;
      const sameVideo = node.type === "video" && run.status === "completed" && observed?.requestId === run.requestId;
      const retainedRun = sameVideo && !run.duration_ms && Number.isSafeInteger(observed.duration_ms) && observed.duration_ms > 0
        ? { ...run, duration_ms: observed.duration_ms } : run;
      return { ...node, run: retainedRun, ...(run.assetId ? { assetId: run.assetId } : {}) };
    });
    const saved = await writeProject(tx, current, { ...next, nodes });
    await releaseRemovedAssets(tx, owner, before, saved);
    return saved;
  });
}

async function storeBlob(tx, owner, projectId, blob) {
  const id = crypto.randomUUID();
  await request(tx.objectStore(ASSETS).add({ id, owner, projectId, blob }));
  return id;
}

export function putCanvasAsset(owner, projectId, blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("素材内容为空，请重新选择。");
  return access(owner, [PROJECTS, ASSETS], "readwrite", async tx => {
    assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, projectId))));
    return storeBlob(tx, owner, projectId, blob);
  });
}

export function getCanvasAsset(owner, projectId, id) {
  return access(owner, ASSETS, "readonly", async tx => {
    if (!id) return null;
    const asset = await request(tx.objectStore(ASSETS).get([owner, projectId, id]));
    return asset?.blob ?? null;
  });
}

export function copyGuestCanvasProject(owner, guestProjectId) {
  if (owner === "guest") throw new Error("请使用已登录账户接续游客项目。");
  return access(owner, [PROJECTS, ASSETS, LAST], "readwrite", async tx => {
    const projects = tx.objectStore(PROJECTS), last = tx.objectStore(LAST), assets = tx.objectStore(ASSETS);
    const source = assertProject(await request(projects.get(projectKey("guest", guestProjectId))));
    const key = [owner, "guest-copy", guestProjectId, source.revision ?? source.updatedAt];
    const existingId = await request(last.get(key));
    if (existingId) {
      const existing = await request(projects.get([owner, existingId]));
      if (existing) {
        await request(last.put(existing.id, owner));
        return existing;
      }
    }
    const initial = { ...source, nodes: source.nodes.map(node => {
      if (node.run?.status === "pending") {
        // User-scoped remote work stays with the original guest project.
        const copied = { ...node }; delete copied.run; return copied;
      }
      return node;
    }) };
    const copy = await insertProject(tx, owner, initial);
    for (const id of projectAssetIds(copy)) {
      const original = await request(assets.get(["guest", source.id, id]));
      if (!original?.blob) throw new Error("游客项目的本地素材读取失败，请在原项目中重新选择素材。");
      await request(assets.add({ owner, projectId: copy.id, id, blob: original.blob }));
    }
    await request(last.put(copy.id, key));
    return copy;
  });
}

export async function resumeGuestCanvasAfterLogin(owner) {
  const intent = readGuestCanvasLogin();
  if (!intent || !owner || owner === "guest" || owner !== intent.owner) return null;
  const project = await copyGuestCanvasProject(owner, intent.projectId);
  forgetGuestCanvasLogin(intent.token);
  return project;
}

// expectedRequestId is the last run the user actually saw when pressing
// Generate. It also prevents a delayed second click starting another job when
// the first tab has already finished its own run.
export function claimCanvasRun(owner, projectId, nodeId, expectedRequestId = null, metadata = {}, expectedNodeModel, expectedNodeParams, expectedRevision) {
  return access(owner, [PROJECTS, ASSETS], "readwrite", async tx => {
    const project = assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, projectId))));
    const node = project.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error("画布节点已被移除。");
    if (node.run?.status === "pending" || (node.run?.requestId ?? null) !== expectedRequestId) {
      return { acquired: false, requestId: node.run?.requestId, project };
    }
    const params = node.params ?? {};
    const paramsChanged = expectedNodeParams !== undefined && (
      Object.keys(params).length !== Object.keys(expectedNodeParams).length
      || Object.keys(params).some(key => !Object.hasOwn(expectedNodeParams,key) || params[key] !== expectedNodeParams[key])
    );
    if (paramsChanged || expectedRevision !== undefined && project.revision !== expectedRevision
      || expectedNodeModel !== undefined && expectedNodeModel !== (node.model ?? null)) {
      return { acquired: false, modelChanged: true, project };
    }
    const before = projectAssetIds(project);
    const requestId = crypto.randomUUID();
    node.run = { ...metadata, requestId, status: "pending", phase: "preparing", startedAt: Date.now() };
    const saved = await writeProject(tx, project);
    await releaseRemovedAssets(tx, owner, before, saved);
    return { acquired: true, requestId, project: saved };
  });
}

// The generation adapter awaits this exclusive fence immediately before its
// only paid POST. Upload/prepare may be cancelled safely by another tab.
export function markCanvasRunDispatched(owner, id, nodeId, requestId) {
  return access(owner, PROJECTS, "readwrite", async tx => {
    const project = assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, id))));
    const run = project.nodes.find(node => node.id === nodeId)?.run;
    if (run?.requestId !== requestId || run?.status !== "pending" || run.phase !== "preparing") {
      throw new Error("准备状态已更改，本次提交已停止。");
    }
    run.phase = "dispatched";
    return writeProject(tx, project);
  });
}

export function cancelPreparingCanvasRun(owner, id, nodeId, requestId) {
  return access(owner, PROJECTS, "readwrite", async tx => {
    const project = assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, id))));
    const run = project.nodes.find(node => node.id === nodeId)?.run;
    if (run?.requestId !== requestId || run?.status !== "pending" || run.phase !== "preparing") return project;
    run.status = "failed";
    run.message = "已取消准备，可以再次生成。";
    return writeProject(tx, project);
  });
}

export function finishCanvasRun(owner, projectId, nodeId, requestId, patch) {
  return access(owner, [PROJECTS, ASSETS], "readwrite", async tx => {
    const project = assertProject(await request(tx.objectStore(PROJECTS).get(projectKey(owner, projectId))));
    const node = project.nodes.find(n => n.id === nodeId);
    if (!node?.run || node.run.requestId !== requestId || node.run.status !== "pending") return project;
    if (patch.status && !["pending", "completed", "failed"].includes(patch.status)) throw new Error("画布任务状态无效。");
    const before = projectAssetIds(project);
    const { blob, lastFrameBlob, ...fields } = patch;
    if (blob?.size) fields.assetId = await storeBlob(tx, owner, projectId, blob);
    if (lastFrameBlob?.size) fields.lastFrameAssetId = await storeBlob(tx, owner, projectId, lastFrameBlob);
    node.run = { ...node.run, ...fields, requestId };
    if (node.run.status === "completed") node.assetId = node.run.assetId || null;
    const saved = await writeProject(tx, project);
    await releaseRemovedAssets(tx, owner, before, saved);
    return saved;
  });
}

const allowedInputs = {
  image: ["prompt", "reference", "image", "frame"],
  video: ["prompt", "reference", "image", "frame", "video"],
  frame: ["video"],
};

export function connectCanvasNodes(project, fromId, toId) {
  const source = project.nodes.find(node => node.id === fromId);
  const target = project.nodes.find(node => node.id === toId);
  if (!source || !target) throw new Error("请选择画布上的两个节点。");
  if (fromId === toId) throw new Error("请连接到另一个节点。");
  if (!allowedInputs[target.type]?.includes(source.type)) throw new Error("这两个节点的素材类型不匹配。");
  if (target.type === "image" && source.type === "reference" && source.assetKind && source.assetKind !== "image") throw new Error("生图节点仅支持图片参考素材。");
  if (project.edges.some(edge => edge.from === fromId && edge.to === toId)) throw new Error("这两个节点已经连接。");
  if (target.type === "frame" && project.edges.some(edge => edge.to === toId)) {
    throw new Error("尾帧节点只能连接一段视频，请先移除原连接。");
  }
  const pending = [toId], visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === fromId) throw new Error("这条连接会让素材流回源节点，请换一个下游节点。");
    if (visited.has(id)) continue;
    visited.add(id);
    for (const edge of project.edges) if (edge.from === id) pending.push(edge.to);
  }
  return { ...project, edges: [...project.edges, { id: crypto.randomUUID(), from: fromId, to: toId }] };
}

export { extractCanvasTailFrame } from "./creationCanvasTailFrame.js";
export { rememberGuestCanvasForLogin, confirmGuestCanvasLogin, forgetGuestCanvasLogin, CANVAS_LOGIN_READY } from "./creationCanvasLogin.js";
