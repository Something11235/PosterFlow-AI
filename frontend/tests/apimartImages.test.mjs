import assert from "node:assert/strict";
import test from "node:test";
import { imageGenerationFetch, readImageTask } from "../src/lib/apimartImages.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const requestId = "11111111-1111-4111-8111-111111111111";

test('recognized gateway timeout preserves its Chinese reason and never repeats a paid submission', async t => {
  const calls=[];
  install(t,async(url,init)=>{calls.push(init?.method || 'GET');return json(calls.length===1?{job:{status:'submitted'}}:{job:{status:'failed',error_code:'IMAGE_PROVIDER_TIMEOUT',failure_reason:'图片生成服务响应超时',recovery:['至少等待 2 分钟，再查询原任务。']}});});
  const response=await imageGenerationFetch('/api/generate',{method:'POST',headers:{'X-Billing-Mode':'platform'},body:JSON.stringify({platform_model:'grok-imagine-2.0-ext',request_id:requestId,prompt:'fixture'})},{pollInterval:0});
  const data=await response.json();assert.equal(data.code,'IMAGE_PROVIDER_TIMEOUT');assert.equal(data.error,'图片生成服务响应超时');assert.match(data.recovery[0],/2 分钟/);assert.deepEqual(calls,['POST','GET']);
});
function install(t, fetch) {
  const oldFetch = global.fetch, oldWindow = global.window;
  global.fetch = fetch;
  global.window = new EventTarget();
  t.after(() => { global.fetch = oldFetch; global.window = oldWindow; });
}
test("existing image models retain their original endpoint and body", async t => {
  const init = { method: "POST", headers: { "X-Billing-Mode": "platform" }, body: JSON.stringify({ platform_model: "gpt-image-2.5-flare", request_id: requestId, prompt: "猫" }) };
  let called;
  install(t, async (...args) => { called = args; return json({ images: [] }); });
  await imageGenerationFetch("/api/modify", init);
  assert.deepEqual(called, ["/api/modify", init]);
});
test("new models submit once then query until actual saved images are returned", async t => {
  const calls = [];
  install(t, async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    if (calls.length === 1) return json({ job: { status: "submitted" } }, 202);
    if (calls.length === 2) return json({ job: { status: "processing" } });
    return json({ job: { status: "completed" }, images: [{ filename: "stored.png" }], credit_balance: 9 });
  });
  const response = await imageGenerationFetch("/api/generate", { method: "POST", headers: { "X-Billing-Mode": "platform" }, body: JSON.stringify({ platform_model: "gemini-nano-banana-2.1", request_id: requestId, prompt: "猫" }) }, { pollInterval: 0 });
  assert.equal((await response.json()).images[0].filename, "stored.png");
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
  assert.equal(calls[0].url, "/api/apimart-images/generations");
  assert.ok(calls.slice(1).every(call => call.url.endsWith(requestId)));
});
test("uncertain submit and query failure never trigger another paid POST", async t => {
  let count = 0;
  install(t, async () => { count++; return json({ error: "提交结果待确认", code: "UNCERTAIN" }, 503); });
  const init = { method: "POST", headers: { "X-Provider-Model": "grok-imagine-2.0-ext" }, body: JSON.stringify({ request_id: requestId, prompt: "猫" }) };
  const response = await imageGenerationFetch("/api/generate", init);
  assert.equal(response.status, 503);
  assert.equal(count, 1);
});
test("long running tasks remain resumable rather than being regenerated", async t => {
  let count = 0;
  install(t, async () => { count++; return json({ job: { status: "processing" } }, 202); });
  const response = await imageGenerationFetch("/api/generate", { method: "POST", headers: { "X-Billing-Mode": "platform" }, body: JSON.stringify({ platform_model: "gemini-nano-banana-2.1", request_id: requestId, prompt: "猫" }) }, { maxWait: 0 });
  assert.equal((await response.json()).code, "IMAGE_TASK_PENDING");
  assert.equal(count, 1);
});
test("manual task recovery uses GET without resubmitting generation", async t => {
  install(t, async (url, init) => {
    assert.equal(url, "/api/apimart-images/tasks/" + requestId);
    assert.equal(init.method, undefined);
    assert.equal(init.cache, "no-store");
    return json({ job: { status: "completed" }, images: [{ filename: "recovered.png" }] });
  });
  assert.equal((await readImageTask(requestId, {})).images[0].filename, "recovered.png");
});

test("Grok region editing prepares the asset before exactly one paid POST", async t => {
  const calls=[];
  install(t,async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body)});
    if(url.endsWith('/segments'))return json({status:'pending',receipt:'synthetic-task-proof'});
    if(url.endsWith('/segments/status'))return json({status:'completed',segment_receipt:'synthetic-asset-proof'});
    return json({job:{status:'completed'},images:[{filename:'region.png'}]});
  });
  const response=await imageGenerationFetch('/api/modify',{method:'POST',headers:{'X-Billing-Mode':'platform'},body:JSON.stringify({platform_model:'grok-imagine-2.0-ext',request_id:requestId,prompt:'fixture',operation:'region_edit',reference_storage_paths:['main'],selection_regions:[{outer:{points:[0,0,1,0,1,1]}}]})},{pollInterval:0});
  assert.equal((await response.json()).images[0].filename,'region.png');
  assert.deepEqual(calls.map(call=>call.url),['/api/apimart-images/segments','/api/apimart-images/segments/status','/api/apimart-images/generations']);
  assert.equal(calls[2].body.segment_receipt,'synthetic-asset-proof');
  assert.equal(calls[2].body.reference_storage_paths,undefined);
});

test("failed or unknown free preparation never sends a paid edit", async t => {
  let calls=0;
  install(t,async()=>{calls++;throw new Error('synthetic network failure');});
  const response=await imageGenerationFetch('/api/modify',{method:'POST',headers:{'X-Provider-Model':'grok-imagine-2.0-ext'},body:JSON.stringify({request_id:requestId,prompt:'fixture',operation:'region_edit'})},{pollInterval:0});
  assert.equal((await response.json()).generation_submitted,false);
  assert.equal(calls,1);
});
