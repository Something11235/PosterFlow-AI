import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_MODEL_OPTIONS } from "../src/lib/provider.js";
import { canvasGenerationQuoteDetails, canvasModelCapabilities } from "../src/lib/creationCanvasGeneration.js";
import {
  addStoryboardShots, canvasNodePrompt, getShotNodes, getShotQuote, getStoryboard, moveStoryboardShot,
  removeStoryboardShot, repairStoryboardShot, setShotModel, setShotParam, setShotPrompt, setShotReference,
  setStoryboardScript, storyboardItemSignature, storyboardPlan, updateStoryboardShot,
} from "../src/lib/creationCanvasStoryboard.js";

const legacy = { id: "project", nodes: [{ type: "reference", id: "ref", title: "角色", x: 0, y: 0, assetKind: "image", assetId: "asset" }], edges: [] };
const rows = [{ title: "入场", description: "雨巷", camera: "推近", imagePrompt: "蓝灰色", videoPrompt: "角色转头", duration: 6 }, { title: "离开", description: "夜景" }];
const withShots = () => addStoryboardShots(legacy, rows, {}, "split-accepted");
const withNode = (project, id, changes) => ({ ...project, nodes: project.nodes.map(node => node.id === id ? { ...node, ...changes } : node) });

test("old projects gain shots only on acceptance; repeated acceptance or reordering never creates jobs or extra nodes", () => {
  assert.deepEqual(getStoryboard(legacy), { script: "", shots: [] });
  const board = setStoryboardScript(legacy, "雨天的街道");
  const project = addStoryboardShots(board, rows, {}, "split");
  const [first, second] = getStoryboard(project).shots;
  assert.equal(first.suggestedDuration, 6);
  assert.equal(second.suggestedDuration, undefined);
  assert.equal(project.nodes.length, legacy.nodes.length + 8);
  assert.equal(project.nodes.some(node => node.run), false);
  assert.equal(project.edges.length, 4);
  assert.equal(project.storyboard.script, "雨天的街道");
  assert.equal(addStoryboardShots(project, rows, {}, "split"), project);
  assert.equal(project.nodes[0], legacy.nodes[0]);
  const moved = moveStoryboardShot(project, second.id, -1);
  assert.deepEqual(moved.storyboard.shots.map(s => s.id), [second.id, first.id]);
  assert.equal(moved.nodes, project.nodes);
  assert.equal(removeStoryboardShot(moved, first.id).edges, project.edges);
  assert.equal(getStoryboard(legacy).shots.length, 0);
});

test("graph and storyboard edit the same prompts, models and params; both paths apply the shot description and motion", () => {
  const original = withShots();
  let project = original;
  const [shot] = project.storyboard.shots;
  project = setShotPrompt(project, shot.id, "video", "停下脚步");
  project = updateStoryboardShot(project, shot.id, { camera: "拉远", description: "晨雾" });
  assert.equal(canvasNodePrompt(project, shot.imageNodeId), "蓝灰色\n画面：晨雾");
  assert.equal(canvasNodePrompt(project, shot.videoNodeId), "停下脚步\n画面：晨雾\n运镜：拉远");
  project = withNode(project, shot.videoPromptNodeId, { text: "画布上修改" });
  assert.equal(getShotNodes(project, shot).videoPrompt.text, "画布上修改");
  project = setShotModel(project, shot.id, "video", "seedance-2-5-flash");
  project = setShotParam(project, shot.id, "video", "duration", 10);
  assert.equal(getShotNodes(project, shot).video.params.duration, 10);
  assert.throws(() => setShotParam(project, shot.id, "video", "duration", 99), /时长/);
  const quote = getShotQuote(project, shot, "video");
  assert.equal(quote.credits, canvasGenerationQuoteDetails({ kind: "video", model: quote.model, params: quote.params }).credits);
  assert.equal(getShotNodes(original, shot).videoPrompt.text, "角色转头");
});

test("free selection changes the quoted references; text-only shots work without first generating images", () => {
  let project = withShots();
  const [shot] = project.storyboard.shots;
  assert.equal(storyboardPlan(project, [shot.id], "video").items[0].error, "");
  project = setShotReference(project, shot.id, "video", shot.imageNodeId, true);
  assert.match(storyboardPlan(project, [shot.id], "video").items[0].error, /请先/);
  const result = withNode(project, shot.imageNodeId, { run: { status: "completed", requestId: "result", assetId: "img" } });
  assert.equal(storyboardPlan(result, [shot.id], "video").items[0].error, "");
  assert.equal(setShotReference(result, shot.id, "video", shot.imageNodeId, true), result);
  const textOnly = IMAGE_MODEL_OPTIONS.find(option => canvasModelCapabilities("image", option.value).maxImages === 0);
  assert.ok(textOnly);
  project = setShotModel(project, shot.id, "image", textOnly.value);
  assert.throws(() => setShotReference(project, shot.id, "image", "ref", true), /仅支持/);
});

test("same-cost prompt or source changes invalidate the reviewed quote and a running task cannot be submitted again", () => {
  const initial = withShots(), [shot] = initial.storyboard.shots;
  const project = setShotReference(initial, shot.id, "image", "ref", true);
  const plan = p => storyboardPlan(p, [shot.id, shot.id], "image");
  const checked = plan(project);
  assert.equal(checked.items.length, 1);
  assert.equal(checked.items[0].error, "");
  assert.equal(checked.items[0].quote.inputSignature, storyboardItemSignature(project, shot.imageNodeId));
  const replaced = plan(withNode(project, "ref", { assetId: "other-portrait" }));
  assert.equal(checked.credits, replaced.credits);
  assert.notEqual(replaced.signature, checked.signature);
  assert.notEqual(plan(setShotPrompt(project, shot.id, "image", "另一个场景")).signature, checked.signature);
  const running = withNode(project, shot.imageNodeId, { run: { requestId: "in-flight", status: "pending" } });
  assert.match(plan(running).items[0].error, /原任务/);
  assert.throws(() => setShotModel(running, shot.id, "image", checked.items[0].quote.model), /原任务/);
  const completed = withNode(project, shot.imageNodeId, { run: { requestId: "done", status: "completed", assetId: "a" } });
  assert.notEqual(plan(completed).signature, checked.signature);
  assert.equal(plan(completed).items[0].requestId, "done");
});

test("restoring a deleted prompt or disconnected link preserves existing results and unrelated graph edits", () => {
  const initial = withShots(), [shot] = initial.storyboard.shots;
  const done = withNode(initial, shot.imageNodeId, { run: { status: "completed", requestId: "saved", assetId: "result" } });
  const changed = { ...done, nodes: done.nodes.filter(n => n.id !== shot.videoPromptNodeId),
    edges: done.edges.filter(e => e.from !== shot.videoPromptNodeId && e.from !== shot.imagePromptNodeId) };
  assert.match(storyboardPlan(changed, [shot.id], "image").items[0].error, /连接/);
  const fixed = repairStoryboardShot(changed, shot.id);
  assert.equal(getShotNodes(fixed, shot).image.run.requestId, "saved");
  assert.ok(getShotNodes(fixed, shot).videoPrompt);
  assert.equal(fixed.edges.length, initial.edges.length);
  assert.equal(repairStoryboardShot(fixed, shot.id).nodes.length, fixed.nodes.length);
  assert.match(storyboardPlan(fixed, ["removed"], "video").items[0].error, /已移除/);
});
