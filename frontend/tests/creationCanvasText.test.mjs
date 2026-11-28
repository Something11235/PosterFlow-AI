import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasTextPayload, canvasTextReceipt, canvasTextRouteLabel, fetchCanvasText, finishCanvasText } from "../src/lib/creationCanvasText.js";

test("recovery reads the original request and keeps the suggestion separate from edited nodes", async t => {
  const task = { id: "original", input: { action: "polish", nodeId: "n", text: "夜雨", kind: "image" } };
  const project = { nodes: [{ id: "n", text: "雨停了" }], textRequest: task };
  const payload = { request_id: "original", status: "succeeded", prompt: "夜雨中的街道", requested_model: "gpt-6.2-astra",
    model: "deepseek-v4.1-flash", billing: { status: "settled", charged_credits: "0.0135", reserved_credits: "1.2000" } };
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/canvas-ai/requests/original");
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    return Response.json(payload);
  });
  const next = finishCanvasText(project, task, await fetchCanvasText({}, task));
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(next.nodes[0].text, "雨停了");
  assert.equal(next.textProposal.text, payload.prompt);
  assert.equal(next.textProposal.input.nodeId, "n");
  const recovered = structuredClone(next).textProposal;
  assert.equal(recovered.model, "deepseek-v4.1-flash");
  assert.equal(canvasTextReceipt(recovered), "回复模型 DeepSeek 4.1 Flash（由 GPT 6.2 Astra 自动切换） · 实扣 0.0135 积分");
  assert.equal(next.textRequest, null);
  assert.equal(finishCanvasText(next, task, payload), next);
});

test("storyboard submission leaves time for backend failover, recovery only queries and preserves the final receipt", async t => {
  const task = { id: "split", input: { action: "split", script: "春天到来" } };
  const payload = { request_id: task.id, status: "succeeded", shots: [{ title: "融雪" }], model: "gpt-6.2-sol",
    billing: { status: "settled", charged_credits: "0.0050" } };
  const timeout = t.mock.method(AbortSignal, "timeout", () => new AbortController().signal);
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const submitted = await fetchCanvasText({}, task, true);
  const recovered = await fetchCanvasText({}, task);
  assert.deepEqual(fetch.mock.calls.map(call => [call.arguments[0], call.arguments[1].method]), [
    ["/api/canvas-ai/storyboard", "POST"], ["/api/canvas-ai/requests/split", "GET"],
  ]);
  assert.ok(timeout.mock.calls[0].arguments[0] > 300000);
  assert.ok(timeout.mock.calls[1].arguments[0] <= 30000);
  for (const response of [submitted, recovered]) {
    const proposal = finishCanvasText({ textRequest: task }, task, response).textProposal;
    assert.deepEqual(proposal.shots, payload.shots);
    assert.equal(canvasTextReceipt(proposal), "回复模型 GPT 6.2 Sol · 实扣 0.005 积分");
  }
});

test("model routing follows the public configuration, independent of receipt data", () => {
  const model = "gpt-6.2-astra";
  assert.equal(canvasTextRouteLabel(null), "");
  assert.equal(canvasTextRouteLabel({ configured: false, model }), "");
  assert.equal(canvasTextRouteLabel({ configured: true, model }), "文本模型 GPT 6.2 Astra");
  assert.equal(canvasTextRouteLabel({ configured: true, model, fallback_models: [model, "gpt-6.2-sol", "deepseek-v4.1-flash"] }),
    "优先 GPT 6.2 Astra，故障时依次切换至 GPT 6.2 Sol → DeepSeek 4.1 Flash");
  assert.equal(canvasTextRouteLabel({ configured: true, model, models: [{ id: model }, { id: "gpt-6.2-sol" }] }),
    "优先 GPT 6.2 Astra，故障时依次切换至 GPT 6.2 Sol");
  assert.equal(canvasTextReceipt({ input: { target_model: "video-model" } }), "");
  assert.equal(canvasTextReceipt({ billing: { charged_credits: "0.0000" } }), "实扣 0 积分");
  assert.equal(canvasTextReceipt({ billing: { status: "refunded", charged_credits: "0.0000" } }), "预留积分已退回");
});

test("script and prompt actions send only the intended text to their endpoint", () => {
  const input = { action: "split", shot_count: 2, script: "A → B", nodeId: "local" };
  assert.deepEqual(canvasTextPayload(input, "id"), { request_id: "id", script: "A → B", shot_count: 2 });
  const prompt = canvasTextPayload({ ...input, action: "complete", text: "雨", kind: "video", context: "街道", target_model: "video-model" }, "id");
  assert.deepEqual(prompt, { request_id: "id", mode: "complete", target: "video", text: "雨", context: "街道", target_model: "video-model" });
});

test("another task's response or a processing response cannot replace a pending request", () => {
  const task = { id: "task", input: { action: "split" } };
  const project = { textRequest: task };
  assert.equal(finishCanvasText(project, task, { request_id: "other", status: "failed" }), project);
  assert.equal(finishCanvasText(project, task, { request_id: "task", status: "processing" }), project);
  assert.equal(finishCanvasText(project, task, { request_id: "task", status: "failed", error: {message:"已退还"} }).textError, "已退还");
});
