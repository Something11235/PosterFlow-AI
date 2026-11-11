import assert from "node:assert/strict";
import test from "node:test";
import { createImageTaskStore, referenceCapability } from "../src/lib/imageTasks.js";
import { APIMART_IMAGE_MODELS, IMAGE_MODEL_OPTIONS } from "../src/lib/provider.js";

test("concurrent image results retain each request even when completion is reversed", () => {
  const store = createImageTaskStore();
  for (const id of ["a", "b", "c"]) assert.equal(store.start(id, { prompt: id, model: "one", billingMode: "platform", key: "not-public" }), true);
  assert.equal(store.start("d", {}), false);
  store.finish("c", { images: [{ filename: "c.png" }] });
  assert.equal(store.start("d", { prompt: "d" }), true);
  store.finish("b", { images: [{ filename: "b.png" }] });
  store.finish("a", { images: [{ filename: "a.png" }] });
  assert.deepEqual(store.getSnapshot().find(t => t.id === "a").images, [{ filename: "a.png" }]);
  assert.deepEqual(store.getSnapshot().find(t => t.id === "c").images, [{ filename: "c.png" }]);
  assert.ok(!JSON.stringify(store.getSnapshot()).includes("not-public"));
});
test("pending recovery queries the original intent, releases slots and never repeats a terminal result", async () => {
  const store = createImageTaskStore(); let queries = 0;
  store.start("a", { prompt: "first" });
  store.registerRecovery("a", () => { queries++; store.finish("a", { images: [{ filename: "recovered.png" }] }); });
  store.finish("a", { error: { code: "QUERY_FAILED" }, pending: true });
  assert.equal(store.getSnapshot()[0].active, false);
  await store.recover("a");
  store.finish("a", { error: { code: "LATE_ERROR" } });
  assert.equal(store.getSnapshot()[0].status, "completed"); assert.equal(queries, 1);
});
test("identity stores and duplicate request IDs cannot overwrite each other", () => {
  const first = createImageTaskStore(3, "first"), second = createImageTaskStore(3, "second");
  first.start("a", { prompt: "first" });
  assert.equal(first.start("a", { prompt: "changed" }), false);
  first.finish("a", { images: [{ filename: "private.png" }] });
  assert.deepEqual(second.getSnapshot(), []);
});
test("model choices omit retired Nano Banana Pro and reference inputs follow actual UI capabilities", () => {
  assert.equal(IMAGE_MODEL_OPTIONS.length, 11);
  for (const id of ["nano-banana-pro"]) assert.ok(!IMAGE_MODEL_OPTIONS.some(m => m.value === id));
  for (const model of APIMART_IMAGE_MODELS) {
    assert.equal(referenceCapability(model).limit, model.maxReferences);
    assert.equal(referenceCapability(model).disabled, model.maxReferences === 0);
  }
  assert.deepEqual(referenceCapability(null), { limit: 8, disabled: false });
});

const memoryStorage=()=>{const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),data};};
test('refresh retains original intent and result filenames without credentials or running slots',()=>{
  const storage=memoryStorage(),store=createImageTaskStore(3,'owner',{storage});
  store.start('pending',{prompt:'original',model:'gpt-image-2.6-flare',billingMode:'platform',route:'buytoken',apiKey:'never-store',backgroundName:'海湾'});
  store.start('done',{prompt:'completed',model:'gpt-image-2.6-flare',billingMode:'platform',route:'buytoken'});
  store.finish('done',{images:[{filename:'result.png',url:'https://secret.invalid/?token=secret'}]});
  const raw=storage.getItem('posterflow.image-tasks.v2:owner');
  assert.ok(!/never-store|secret|https:/.test(raw));
  const restored=createImageTaskStore(3,'owner',{storage}).getSnapshot();
  assert.equal(restored.find(x=>x.id==='pending').status,'pending');
  assert.equal(restored.find(x=>x.id==='pending').active,false);
  assert.equal(restored.find(x=>x.id==='pending').backgroundName,'海湾');
  assert.deepEqual(restored.find(x=>x.id==='done').images,[{filename:'result.png'}]);
  assert.deepEqual(createImageTaskStore(3,'other',{storage}).getSnapshot(),[]);
});
test('owned remote completed results recover pending tasks, preserve prompts and ignore late failures',()=>{
  const store=createImageTaskStore(3,'owner',{storage:memoryStorage()});
  store.start('original',{prompt:'my prompt',model:'model',billingMode:'platform',route:'buytoken'});
  store.finish('original',{error:{code:'IMAGE_SUBMISSION_UNKNOWN'},pending:true});
  const remote={id:'original',model:'model',createdAt:Date.now(),status:'completed',images:[{filename:'restored.png'}],route:'buytoken'};
  store.importJobs([remote]);
  store.finish('original',{error:{code:'LATE_ERROR'}});
  store.importJobs([{...remote,status:'pending',images:[]}]);
  assert.equal(store.getSnapshot()[0].status,'completed');
  assert.equal(store.getSnapshot()[0].prompt,'my prompt');
  assert.deepEqual(store.getSnapshot()[0].images,[{filename:'restored.png'}]);
});
test('expired, malformed and oversized archives cannot leak arbitrary fields or break task creation',()=>{
  const storage=memoryStorage(),key='posterflow.image-tasks.v2:owner';
  storage.setItem(key,JSON.stringify([{id:'old',createdAt:Date.now()-8*86400000},{id:'../foreign',createdAt:Date.now()}]));
  assert.deepEqual(createImageTaskStore(3,'owner',{storage}).getSnapshot(),[]);
  storage.setItem(key,'not JSON');
  const store=createImageTaskStore(3,'owner',{storage});
  for(let i=0;i<60;i++)store.importJobs([{id:'task'+i,createdAt:Date.now(),status:'completed',images:[{filename:'../../foreign.png'}],apiKey:'secret'}]);
  assert.equal(store.getSnapshot().length,50);
  assert.ok(store.getSnapshot().every(x=>x.images.length===0));
  assert.ok(!storage.getItem(key).includes('secret'));
  assert.doesNotThrow(()=>createImageTaskStore(3,'owner',{storage:{getItem(){throw Error();},setItem(){throw Error();}}}).start('safe',{prompt:'safe'}));
});
