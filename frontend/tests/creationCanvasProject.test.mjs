import assert from "node:assert/strict";
import test from "node:test";
import { connectCanvasNodes } from "../src/lib/creationCanvasProject.js";
import { moveCanvasNode } from "../src/components/creationCanvasLayout.js";
import {
  CANVAS_LOGIN_READY, confirmGuestCanvasLogin, forgetGuestCanvasLogin,
  readGuestCanvasLogin, rememberGuestCanvasForLogin,
} from "../src/lib/creationCanvasLogin.js";

function scene() {
  return {
    nodes: [
      { id: "text", type: "prompt" }, { id: "ref", type: "reference" }, { id: "image", type: "image" },
      { id: "video", type: "video" }, { id: "tail", type: "frame" }, { id: "next", type: "video" },
    ],
    edges: [],
  };
}

test("node displacement composes with other edits and preserves connections and generation results", () => {
  const project = {
    nodes: [{ id: "image", x: 0, y: 0, run: { requestId: "kept" } }, { id: "video", x: 30, y: 40 }],
    edges: [{ from: "image", to: "video" }],
  };
  const firstViewport = { x: 17, y: 24, k: 0.8 };
  const firstDrag = moveCanvasNode(project, "image", -70, 51, firstViewport);
  const moved = moveCanvasNode(firstDrag, "image", 8, -8, { x: 0, y: 0, k: 1 });
  assert.deepEqual(moved.nodes[0], { id: "image", x: -62, y: 43, run: { requestId: "kept" } });
  assert.equal(moved.nodes[1], project.nodes[1]);
  assert.equal(moved.edges, project.edges);
  assert.equal(moved.viewport, firstViewport);
  assert.equal(project.nodes[0].x, 0);
  assert.equal(moveCanvasNode(project, "image", 0, 0), project);
});

test("reference and prompt reach an image, its video, and a subsequent shot through the tail frame", () => {
  const empty = scene();
  const pairs = [["ref", "image"], ["text", "image"], ["image", "video"], ["video", "tail"], ["tail", "next"]];
  const result = pairs.reduce((p, [from, to]) => connectCanvasNodes(p, from, to), empty);
  assert.deepEqual(result.edges.map(edge => [edge.from, edge.to]), pairs);
  assert.equal(empty.edges.length, 0);
  assert.equal(new Set(result.edges.map(edge => edge.id)).size, pairs.length);
  assert.equal(result.nodes.some(node => node.run), false);
  assert.throws(() => connectCanvasNodes(result, "tail", "image"), /流回/);
  assert.throws(() => connectCanvasNodes(result, "ref", "image"), /已经连接/);
});

test("validates input types, one source per tail, missing nodes and self-links", () => {
  const empty = scene();
  assert.throws(() => connectCanvasNodes(empty, "text", "tail"), /类型不匹配/);
  assert.throws(() => connectCanvasNodes(empty, "image", "image"), /另一个/);
  assert.throws(() => connectCanvasNodes(empty, "gone", "image"), /节点/);
  const connected = connectCanvasNodes(empty, "video", "tail");
  assert.throws(() => connectCanvasNodes(connected, "next", "tail"), /一段视频/);
  const branch = connectCanvasNodes(connectCanvasNodes(empty, "image", "video"), "image", "next");
  assert.deepEqual(branch.edges.map(e => e.from), ["image", "image"]);
  const videoChain = connectCanvasNodes(empty, "video", "next");
  assert.throws(() => connectCanvasNodes(videoChain, "next", "video"), /流回/);
  for (const assetKind of ["video","audio","document"]) {
    const reference = {id:"other",type:"reference",assetKind};
    const media = {...empty,nodes:[...empty.nodes,reference]};
    assert.throws(() => connectCanvasNodes(media,"other","image"), /仅支持图片/);
    assert.equal(connectCanvasNodes(media,"other","video").edges[0].from,"other");
  }
});

test("a guest handoff can only bind the account explicitly confirmed in this tab", t => {
  const rows = new Map();
  const storage = {
    getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: key => rows.delete(key),
  };
  for (const [name, value] of Object.entries({ sessionStorage: storage, window: new EventTarget() })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  let ready = 0;
  window.addEventListener(CANVAS_LOGIN_READY, () => ready++);
  confirmGuestCanvasLogin("other-tab-user");
  assert.equal(ready, 0);
  rememberGuestCanvasForLogin("draft-one");
  assert.equal(readGuestCanvasLogin().owner, null);
  confirmGuestCanvasLogin("user-one");
  confirmGuestCanvasLogin("user-two");
  assert.equal(ready, 1);
  assert.equal(readGuestCanvasLogin().owner, "user-one");
  const first = readGuestCanvasLogin().token;
  rememberGuestCanvasForLogin("draft-two");
  forgetGuestCanvasLogin(first);
  assert.equal(readGuestCanvasLogin().projectId, "draft-two");
  forgetGuestCanvasLogin();
  confirmGuestCanvasLogin("user-two");
  assert.equal(readGuestCanvasLogin(), null);
});
