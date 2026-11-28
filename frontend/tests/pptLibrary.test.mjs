import assert from "node:assert/strict";
import test from "node:test";
import { accessPptProject, createPptPresentation, deletePptPresentation, finishPptRequest,
  LEGACY_PPT_PROJECT_ID, openPptLibrary, selectPptPresentation } from "../src/lib/pptProject.js";

// One object store with serialized read/write transactions. Use structuredClone
// to exercise the same snapshot and array-key semantics as browser IndexedDB.
function installStore(t, seeds = []) {
  const data = new Map(seeds.map(([key, value]) => [JSON.stringify(key), value]));
  let last = Promise.resolve();
  const db = { transaction() {
    let unlock, finished = false, draft, commit;
    const start = last.then(() => { draft = new Map(data); });
    last = new Promise(resolve => { unlock = resolve; });
    function end(abort) {
      if (finished) return;
      finished = true;
      clearImmediate(commit);
      if (!abort) { data.clear(); for (const [key, value] of draft) data.set(key, value); }
      (abort ? tx.onabort : tx.oncomplete)?.();
      unlock();
    }
    function request(action) {
      const req = {};
      start.then(() => {
        if (finished) return;
        req.result = action();
        req.onsuccess?.();
        clearImmediate(commit);
        commit = setImmediate(() => end(false));
      });
      return req;
    }
    const store = {
      get: key => request(() => structuredClone(draft.get(JSON.stringify(key)))),
      put: (value, key) => request(() => draft.set(JSON.stringify(key), structuredClone(value))),
      add: (value, key) => request(() => { assert.ok(!draft.has(JSON.stringify(key))); draft.set(JSON.stringify(key), structuredClone(value)); }),
      delete: key => request(() => draft.delete(JSON.stringify(key))),
    };
    const tx = { objectStore: () => store, abort: () => end(true) };
    return tx;
  }};
  const controls = { handles: [], startError: null };
  const original = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: { open() {
    const handle = { closed: false, close() { this.closed = true; }, transaction() {
      if (this.closed) throw new DOMException("Database closed", "InvalidStateError");
      if (controls.startError) throw controls.startError;
      return db.transaction();
    }};
    controls.handles.push(handle);
    const req = { result: handle };
    queueMicrotask(() => req.onsuccess());
    return req;
  }} });
  t.after(() => { if (original) Object.defineProperty(globalThis, "indexedDB", original); else delete globalThis.indexedDB; });
  return controls;
}

test("PPT storage recovers a closed connection before starting a transaction without replaying work", async t => {
  const { accessPptProject: access, openPptLibrary: open } = await import("../src/lib/pptProject.js?recovery");
  const owner = "alice";
  const pending = { id: "preserved-id", action: "page" };
  const controls = installStore(t, [[owner, { revision: 5, topic: "原稿", pending }]]);
  await open(owner);
  const [first] = controls.handles;
  first.close(); // A real explicit close sends no event.
  const [left, right] = await Promise.all([access(owner), access(owner)]);
  assert.equal(controls.handles.length, 2, "concurrent calls share one replacement");
  assert.deepEqual(left.pending, pending);
  assert.equal(right.topic, "原稿");

  first.onclose(); // A delayed event from the old handle cannot evict the new handle.
  await access(owner);
  assert.equal(controls.handles.length, 2);
  controls.handles[1].onversionchange();
  assert.ok(controls.handles[1].closed);
  await access(owner);
  controls.handles[2].close();
  controls.handles[2].onclose();
  const edit = await access(owner, project => ({ ...project, name: "改名" }));
  assert.equal(edit.revision, 6);
  assert.equal(controls.handles.length, 4);

  controls.startError = new DOMException("Unavailable", "InvalidStateError");
  await assert.rejects(access(owner), { name: "InvalidStateError" });
  assert.equal(controls.handles.length, 5, "one automatic reopen per operation");
  controls.startError = null;
  assert.equal((await access(owner)).name, "改名");

  let calls = 0;
  const opens = controls.handles.length;
  await assert.rejects(access(owner, () => { calls++; throw new DOMException("Quota", "QuotaExceededError"); }),
    { name: "QuotaExceededError" });
  assert.equal(calls, 1);
  assert.equal(controls.handles.length, opens);
  assert.deepEqual((await access(owner)).pending, pending);
});

test("opening a long PPTX and signing in keeps both existing projects and resumes a single copy", async t => {
  installStore(t);
  const { accessPptProject: read, createPptPresentation: create, continueGuestOriginal: resume,
    openPptLibrary: open, pptChatContext } = await import("../src/lib/pptProject.js?original");
  const old = (await open("alice")).activeId;
  await read("alice", p => ({ ...p, topic: "已有稿件" }), old);
  const deck = { title: "论文组会", slides: Array.from({length: 32}, (_, i) => ({
    id: "s"+i, title: "幻灯片"+i, elements: [{type:"text", id:"t0", originalText:"A", text:"修改后的文字"}],
  })) };
  const originalFile = { name: "论文组会.pptx", bytes: new TextEncoder().encode("OOXML source") };
  const guest = await create("guest", deck.title, { deck, originalFile });
  await read("guest", p => ({...p, references:[{name:"论文",text:"摘要"}]}), guest.activeId);
  const [a,b] = await Promise.all([resume("alice",guest.activeId), resume("alice",guest.activeId)]);
  assert.equal(a.activeId,b.activeId);
  assert.equal(b.projects.length,2);
  const current = await read("alice");
  assert.deepEqual(current.originalPptx, originalFile);
  assert.equal(current.references[0].text,"摘要");
  assert.equal(current.deck.slides.length,32);
  assert.equal((await read("alice",undefined,old)).topic,"已有稿件");
  assert.equal(pptChatContext(current,"","解释当前页","s31").slide_titles.at(-1),"幻灯片31");
  assert.equal(pptChatContext(current,"","解释当前页","s31").slide_titles.length,16);
  assert.equal((await open("guest")).projects.length,2);
});

test("presentation storage migrates old drafts, binds requests to a stable presentation and isolates owners", async t => {
  const owner = "alice";
  const original = LEGACY_PPT_PROJECT_ID;
  installStore(t, [[owner, { revision: 4, topic: "旧主题", template: { source: "旧模板" },
    chatTurns: [{ message: "旧提问", reply: "原答复" }], chatDraft: "未发送",
    pending: { id: "req-1", model: "m", action: "chat", body: { message: "第二个问题" } } }]]);

  const lib = await openPptLibrary(owner);
  assert.equal(lib.activeId, original);
  assert.deepEqual(lib.projects.map(p => [p.title, p.pending]), [["旧主题", true]]);
  assert.equal((await accessPptProject(owner)).chatSessions[0].draft, "未发送");

  const [second, third] = await Promise.all([createPptPresentation(owner), createPptPresentation(owner)]);
  assert.equal(second.projects[0].title, "未命名演示稿 2");
  assert.equal(third.projects[0].title, "未命名演示稿 3");
  await assert.rejects(deletePptPresentation(owner, original), /进行中的任务/);
  await assert.rejects(accessPptProject("guest", undefined, second.activeId), { code: "PPT_PROJECT_NOT_FOUND" });
  assert.equal((await accessPptProject(owner)).topic, "");
  const other = await accessPptProject(owner, p => ({ ...p, topic: "另一份稿" }), second.activeId);
  assert.deepEqual(other.chatSessions[0].turns, []);
  const done = await accessPptProject(owner, p => finishPptRequest(p, "req-1", { status: "succeeded", reply: "新答复" }), original);
  assert.equal(done.chatSessions[0].turns.length, 2);
  assert.equal(done.revision, 5);
  assert.equal(done.template.source, "旧模板");
  assert.equal((await openPptLibrary(owner)).activeId, third.activeId);
  assert.equal((await selectPptPresentation(owner, second.activeId)).projects.find(p => p.id === second.activeId).title, "另一份稿");
  await accessPptProject(owner, p => ({ ...p, deck: { title: "已生成的标题", slides: [{ id: "p1" }] } }), second.activeId);
  assert.equal((await openPptLibrary(owner)).projects[0].pageCount, 1);
  assert.equal((await openPptLibrary(owner)).projects[0].title, "已生成的标题");

  const inactive = await deletePptPresentation(owner, original);
  assert.equal(inactive.activeId, second.activeId);
  await assert.rejects(accessPptProject(owner, p => ({ ...p, topic: "过期保存" }), original), { code: "PPT_PROJECT_NOT_FOUND" });
  const next = await deletePptPresentation(owner, second.activeId);
  assert.equal(next.activeId, third.activeId);
  const empty = await deletePptPresentation(owner, third.activeId);
  assert.equal(empty.projects.length, 1);
  assert.equal(empty.projects[0].title, "未命名演示稿 4");
  assert.notEqual(empty.activeId, original);
  await assert.rejects(selectPptPresentation(owner, original), { code: "PPT_PROJECT_NOT_FOUND" });
  assert.deepEqual((await accessPptProject(owner)).chatSessions[0].turns, []);
  assert.equal((await openPptLibrary("guest")).projects.length, 1);
});
