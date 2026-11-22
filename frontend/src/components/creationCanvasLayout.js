export const CANVAS_NODE_TYPES = {
  reference: { label: "参考图", color: "#73d9b7" },
  prompt: { label: "提示词", color: "#c2aaec" },
  image: { label: "生图", color: "#7daaff" },
  video: { label: "视频", color: "#f3b57b" },
  frame: { label: "尾帧", color: "#71ced2" },
};

export const NODE_WIDTH = 226;
export const NODE_HEIGHT = 177;
export const PORT_Y = 86;

export function moveCanvasNode(project, id, dx, dy, viewport) {
  if ((!dx && !dy) || !Number.isFinite(dx) || !Number.isFinite(dy)) return project;
  return {
    ...project,
    ...(!project.viewport && viewport ? { viewport } : {}),
    nodes: project.nodes.map(node => node.id === id ? { ...node, x: node.x + dx, y: node.y + dy } : node),
  };
}

export function newCanvasNode(type, x, y, title = CANVAS_NODE_TYPES[type].label) {
  return { id: crypto.randomUUID(), type, title, x, y, text: "" };
}

export function initialCanvasFields(name = "我的分镜项目") {
  const reference = newCanvasNode("reference", 0, 0);
  const prompt = newCanvasNode("prompt", 0, 214);
  const image = newCanvasNode("image", 298, 107, "生成分镜图");
  const video = newCanvasNode("video", 596, 107, "生成视频镜头");
  const frame = newCanvasNode("frame", 894, 107, "提取尾帧");
  const edges = [[reference, image], [prompt, image], [image, video], [video, frame]]
    .map(([from, to]) => ({ id: crypto.randomUUID(), from: from.id, to: to.id }));
  return { name, nodes: [reference, prompt, image, video, frame], edges };
}

export function incomingNodes(project, nodeId) {
  return project.edges.filter(edge => edge.to === nodeId)
    .map(edge => project.nodes.find(node => node.id === edge.from)).filter(Boolean);
}

export function connectionPath(start, end) {
  const bend = Math.max(37, Math.min(150, Math.abs(end.x - start.x) * 0.52));
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

export function needsFrameUpdate(project, node) {
  if (node.type !== "frame" || (!node.assetId && !node.url)) return false;
  const source = incomingNodes(project, node.id).find(n => n.type === "video");
  return !source || source.run?.status !== "completed" || source.run.requestId !== node.sourceRequestId
    || Boolean(node.sourceNodeId && source.id !== node.sourceNodeId);
}
