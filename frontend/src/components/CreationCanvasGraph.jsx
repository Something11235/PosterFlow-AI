import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, CircleHelp, GitBranch, Hand, List, Maximize, Minus, MousePointer2, Plus, Workflow, X } from "lucide-react";
import CreationCanvasCard from "./CreationCanvasCard";
import CreationCanvasNodeMenu from "./CreationCanvasNodeMenu";
import { CANVAS_ICONS } from "./creationCanvasIcons";
import { CANVAS_NODE_TYPES, NODE_HEIGHT, NODE_WIDTH, PORT_Y, connectionPath, incomingNodes, needsFrameUpdate, newCanvasNode } from "./creationCanvasLayout";
import "./creationCanvasDrag.css";

const scaleInRange = number => Math.max(0.32, Math.min(1.8, number));
const interactive = "button,textarea,input,video,a,label,select,summary,[contenteditable=true],[role=dialog],.cc-menu";
const arrowDirections = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function frameView(nodes, width, height) {
  if (!nodes.length) return { x: 64, y: 72, k: 1 };
  const left = Math.min(...nodes.map(n => n.x)), top = Math.min(...nodes.map(n => n.y));
  const w = Math.max(...nodes.map(n => n.x + NODE_WIDTH)) - left;
  const h = Math.max(...nodes.map(n => n.y + (["image", "video"].includes(n.type) ? 218 : NODE_HEIGHT))) - top;
  const k = scaleInRange(Math.min((width - 96) / w, (height - 125) / h, 1.15));
  return { x: (width - w * k) / 2 - left * k, y: (height - h * k) / 2 - top * k - 8, k };
}

export default function CreationCanvasGraph({ project, owner, quote, onRun, onCancel, onUpload, onExtract, onNextShot, onText, onMove, onEdit, onConnect, onError, onModelChange, onParamChange }) {
  const board = useRef(null);
  const stage = useRef(null);
  const viewRef = useRef({ x: 50, y: 85, k: 1 });
  const [view, setView] = useState(viewRef.current);
  const [list, setList] = useState(false);
  const [panMode, setPanMode] = useState(false);
  const [menu, setMenu] = useState("");
  const menuAnchor = useRef(null);
  const [selected, setSelected] = useState(null);
  const [source, setSource] = useState(null);
  const [floating, setFloating] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [help, setHelp] = useState(false);
  const gesture = useRef(null);
  const touchMovedCanvas = useRef(false);
  const pickerTap = useRef(null);
  const firstView = useRef(false);
  const projectRef = useRef(project);
  projectRef.current = project;
  const updateView = useCallback(v => { viewRef.current = v; setView(v); }, []);
  const closeNodeMenu = useCallback(() => setMenu(""), []);
  function toggleNodeMenu(id) {
    menuAnchor.current = board.current?.querySelector(`[data-node-id="${CSS.escape(id)}"] .cc-more`);
    setSelected(id);
    setMenu(current => current === id ? "" : id);
    setHelp(false);
  }

  function fit(save = true) {
    const el = board.current;
    if (!el || gesture.current) return;
    const v = frameView(projectRef.current.nodes, el.clientWidth, el.clientHeight);
    updateView(v);
    if (save) void onEdit(p => ({ ...p, viewport: v }));
  }

  useLayoutEffect(() => {
    if (list || !board.current) return;
    const el = board.current;
    const apply = () => {
      if (!el.clientWidth || !el.clientHeight || firstView.current) return;
      firstView.current = true;
      const saved = projectRef.current.viewport;
      if (saved && [saved.x, saved.y, saved.k].every(Number.isFinite)) {
        updateView({ ...saved, k: scaleInRange(saved.k) });
        return;
      }
      const nodes = projectRef.current.nodes, first = nodes[0];
      if (first && el.clientWidth < 550) {
        const k = Math.min(1, (el.clientWidth - 36) / NODE_WIDTH);
        updateView({ x: 18 - first.x * k, y: 22 - first.y * k, k });
      } else updateView(frameView(nodes, el.clientWidth, el.clientHeight));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [list, updateView]);

  function zoom(multiplier, origin) {
    const el = board.current;
    if (!el || gesture.current) return;
    const v = viewRef.current, k = scaleInRange(v.k * multiplier);
    const center = origin || { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const next = { x: center.x - (center.x - v.x) * k / v.k, y: center.y - (center.y - v.y) * k / v.k, k };
    updateView(next);
    void onEdit(p => ({ ...p, viewport: next }));
  }

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const el = board.current;
    if (list || !el) return;
    const wheel = e => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const xy = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1.08 : 1 / 1.08, { x: e.clientX - xy.left, y: e.clientY - xy.top });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [list]);

  function closeMenus() { setMenu(""); setHelp(false); }
  const cancelGesture = useRef(null);
  cancelGesture.current = () => {
    const active = gesture.current;
    if (active && board.current) {
      const pointerId = active.kind === "pinch" ? active.points.keys().next().value : active.pointerId;
      finishDrag({ pointerId, currentTarget: board.current }, true);
    }
  };
  useEffect(() => {
    const handle = e => {
      if (e.key === "Escape") { cancelGesture.current(); setMenu(""); setSource(null); setFloating(null); setHelp(false); }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  function getPoint(e) {
    const rect = board.current.getBoundingClientRect(), v = viewRef.current;
    return { x: (e.clientX - rect.left - v.x) / v.k, y: (e.clientY - rect.top - v.y) / v.k };
  }
  function onDown(e) {
    if (list || e.button !== 0) return;
    const target = e.target;
    if (!board.current.contains(target)) return;
    pickerTap.current = null;
    if (touchMovedCanvas.current && e.pointerType === "touch" && e.isPrimary && target.matches("select:enabled")) {
      pickerTap.current = { select: target, x: e.clientX, y: e.clientY };
    }
    touchMovedCanvas.current = false;
    const active = gesture.current;
    if (active) {
      if (active.pointerType !== "touch" || e.pointerType !== "touch" || e.pointerId === active.pointerId ||
          !["node", "pan"].includes(active.kind) || target.closest(interactive)) return;
      const a = { x: active.lastX ?? active.clientX, y: active.lastY ?? active.clientY };
      const b = { x: e.clientX, y: e.clientY };
      const rect = board.current.getBoundingClientRect();
      const v = viewRef.current;
      gesture.current = {
        kind: "pinch", points: new Map([[active.pointerId, a], [e.pointerId, b]]), start: v,
        distance: Math.max(1, Math.hypot(a.x-b.x, a.y-b.y)),
        anchorX: ((a.x+b.x)/2 - rect.left - v.x)/v.k, anchorY: ((a.y+b.y)/2 - rect.top - v.y)/v.k,
      };
      setDragging(null);
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (!e.isPrimary) return;
    const output = target.closest("[data-output-port]");
    const card = target.closest("[data-node-id]");
    let next;
    if (output) {
      const id = output.dataset.outputPort;
      next = { kind: "line", id, was: source };
      setSource(id); setMenu("");
    } else if (target.closest(interactive)) return;
    else if (!panMode && card) {
      const node = project.nodes.find(n => n.id === card.dataset.nodeId);
      next = { kind: "node", id: node.id, x: node.x, y: node.y, scale: viewRef.current.k };
      if (e.pointerType !== "touch") card.querySelector("[data-node-handle]")?.focus({ preventScroll: true });
      closeMenus(); setSelected(node.id);
    } else {
      const v = viewRef.current;
      next = { kind: "pan", x: v.x, y: v.y }; closeMenus();
    }
    gesture.current = { ...next, pointerType: e.pointerType, pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
    if (next.kind === "line") output.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.pointerType !== "touch") e.preventDefault();
  }
  function onDrag(e) {
    const tap = pickerTap.current;
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) pickerTap.current = null;
    const drag = gesture.current;
    if (drag?.kind === "pinch" && drag.points.has(e.pointerId)) {
      drag.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = drag.points.values();
      const k = scaleInRange(drag.start.k * Math.hypot(a.x-b.x, a.y-b.y) / drag.distance);
      const rect = board.current.getBoundingClientRect();
      updateView({ x: (a.x+b.x)/2 - rect.left - drag.anchorX*k, y: (a.y+b.y)/2 - rect.top - drag.anchorY*k, k });
      return;
    }
    if (!drag || drag.pointerId !== e.pointerId) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    const dx = e.clientX - drag.clientX, dy = e.clientY - drag.clientY;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !drag.moved) return;
    drag.moved = true;
    if (drag.kind === "line") { setFloating(getPoint(e)); return; }
    if (drag.kind === "pan") { updateView({ ...viewRef.current, x: drag.x + dx, y: drag.y + dy }); return; }
    setDragging({ id: drag.id, x: drag.x + dx / drag.scale, y: drag.y + dy / drag.scale });
  }
  function finishDrag(e, cancelled = false) {
    const drag = gesture.current;
    if (drag?.kind === "pinch" && drag.points.has(e.pointerId)) {
      gesture.current = null;
      touchMovedCanvas.current = !cancelled;
      if (cancelled) updateView(drag.start);
      else { const v = viewRef.current; void onEdit(p => ({ ...p, viewport: v })); }
      for (const pointer of drag.points.keys()) {
        if (e.currentTarget.hasPointerCapture(pointer)) e.currentTarget.releasePointerCapture(pointer);
      }
      return;
    }
    if (!drag || drag.pointerId !== e.pointerId) return;
    gesture.current = null;
    touchMovedCanvas.current = !cancelled && drag.pointerType === "touch" && drag.moved && drag.kind !== "line";
    if (drag.kind === "line") {
      const destination = !cancelled && drag.moved ? document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-input-port]") : null;
      if (destination) { onConnect(drag.id, destination.dataset.inputPort); setSource(null); }
      else if (cancelled || (!drag.moved && drag.was === drag.id)) setSource(null);
      setFloating(null);
    } else if (drag.kind === "node") {
      if (!cancelled && drag.moved) {
        const dx = Math.round((e.clientX - drag.clientX) / drag.scale);
        const dy = Math.round((e.clientY - drag.clientY) / drag.scale);
        const last = { id: drag.id, x: drag.x + dx, y: drag.y + dy };
        setDragging(last);
        void onMove(drag.id, dx, dy, viewRef.current).finally(() => setDragging(current => current === last ? null : current));
      } else setDragging(null);
    } else if (cancelled) updateView({ ...viewRef.current, x: drag.x, y: drag.y });
    else if (drag.moved) { const v = viewRef.current; void onEdit(p => ({ ...p, viewport: v })); }
    else { setSelected(null); setSource(null); }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  function onTouchEnd(e) {
    const tap = pickerTap.current;
    pickerTap.current = null;
    // Chromium can suppress the compatibility click immediately following a drag.
    // Open the native select for that single tap, leaving all other gestures to the browser.
    if (!tap || e.touches.length || e.target !== tap.select || typeof tap.select.showPicker !== "function") return;
    try {
      tap.select.focus({ preventScroll: true });
      tap.select.showPicker();
      e.preventDefault();
    } catch { /* Browsers without a native picker implementation use their normal click. */ }
  }
  function onBoardKey(e) {
    if (e.key === "ArrowDown" && e.target.matches(".cc-more")) {
      e.preventDefault();
      toggleNodeMenu(e.target.closest("[data-node-id]").dataset.nodeId);
      return;
    }
    if (list || gesture.current || e.altKey || e.metaKey || e.ctrlKey || !e.target.matches("[data-node-handle]")) return;
    const direction = arrowDirections[e.key];
    if (!direction) return;
    e.preventDefault();
    const id = e.target.dataset.nodeHandle, step = e.shiftKey ? 40 : 8;
    setSelected(id);
    void onMove(id, direction[0] * step, direction[1] * step, viewRef.current);
  }
  function endConnection(id) {
    if (!source) { onError("先点源节点右侧的输出端口，再选目标节点的输入。"); return; }
    onConnect(source, id); setSource(null); setFloating(null);
  }
  function add(type) {
    const el = board.current;
    const v = viewRef.current;
    let x = el ? (el.clientWidth / 2 - v.x) / v.k - NODE_WIDTH / 2 : 0;
    let y = el ? (el.clientHeight / 2 - v.y) / v.k - NODE_HEIGHT / 2 : 0;
    while (project.nodes.some(n => Math.abs(n.x - x) < 40 && Math.abs(n.y - y) < 40)) { x += 48; y += 38; }
    const node = newCanvasNode(type, Math.round(x), Math.round(y));
    void onEdit(p => ({ ...p, nodes: [...p.nodes, node] }));
    setSelected(node.id); setMenu(""); setHelp(false);
  }
  function removeNode(node) {
    void onEdit(p => ({ ...p, nodes: p.nodes.filter(n => n.id !== node.id), edges: p.edges.filter(e => e.from !== node.id && e.to !== node.id) }));
    if (source === node.id) setSource(null);
    setMenu(""); setSelected(null);
  }
  const position = n => dragging?.id === n.id ? dragging : n;
  const ports = new Map(project.nodes.map(n => [n.id, position(n)]));
  const from = id => { const n = ports.get(id); return n && { x: n.x + NODE_WIDTH, y: n.y + PORT_Y }; };
  const to = id => { const n = ports.get(id); return n && { x: n.x, y: n.y + PORT_Y }; };
  const currentMenuNode = project.nodes.find(n => n.id === menu);
  const cards = project.nodes.map(node => <CreationCanvasCard key={node.id} node={node} owner={owner} projectId={project.id}
    position={position(node)} selected={selected === node.id} connectSource={source} list={list} staleFrame={needsFrameUpdate(project,node)}
    inputs={incomingNodes(project, node.id)} outgoing={project.edges.filter(e => e.from === node.id).length}
    quote={["image","video"].includes(node.type) ? quote(node) : null}
    onSelect={setSelected} onMenu={toggleNodeMenu} menuOpen={menu === node.id} onParamChange={onParamChange}
    onConnectStart={id => setSource(s => s === id ? null : id)} onConnectEnd={endConnection}
    onRun={onRun} onCancel={onCancel} onUpload={onUpload} onExtract={onExtract} onNextShot={onNextShot} onText={onText} onModelChange={onModelChange} />);
  return <div className="cc-graph">
    <div className="cc-toolbar">
      <div className="cc-toolbar-set"><button className="cc-add" aria-expanded={menu === "add"} onClick={() => { setMenu(menu === "add" ? "" : "add"); setHelp(false); }}><Plus size={16} />添加节点<ChevronDown size={13} /></button>
        <span className="cc-count">{project.nodes.length} 个节点<span> / </span>{project.edges.length} 条连接</span></div>
      <div className="cc-toolbar-set cc-view-buttons"><button aria-pressed={!list} onClick={() => { setList(false); closeMenus(); }} title="画布视图"><Workflow size={15}/><span>画布</span></button>
        <button aria-pressed={list} onClick={() => { setList(true); closeMenus(); }} title="列表视图"><List size={15}/><span>列表</span></button></div>
      {menu === "add" && <div className="cc-menu cc-add-menu" role="group" aria-label="添加节点类型">{Object.entries(CANVAS_NODE_TYPES).map(([type, spec]) => {
        const Icon = CANVAS_ICONS[type];
        return <button key={type} onClick={() => add(type)}><Icon style={{ color: spec.color }} size={16} />{spec.label}</button>;
      })}</div>}
    </div>
    <div ref={board} className={`cc-board ${list ? "cc-list-view" : ""} ${panMode ? "cc-hand-mode" : ""}`} data-moving-node={dragging ? "" : undefined}
      onPointerDown={onDown} onPointerMove={onDrag} onPointerUp={e => finishDrag(e)} onPointerCancel={e => finishDrag(e, true)}
      onLostPointerCapture={e => { if (e.target === e.currentTarget) finishDrag(e, true); }}
      onTouchEnd={onTouchEnd} onTouchCancel={() => { pickerTap.current = null; }} onKeyDown={onBoardKey}>
      {list ? <div className="cc-card-list">{cards}</div> : <div className="cc-scene" ref={stage} style={{ transform: `translate(${view.x}px,${view.y}px) scale(${view.k})` }}>
        <svg className="cc-wires" aria-hidden="true"><g>{project.edges.map(edge => {
          const a = from(edge.from), b = to(edge.to);
          if (!a || !b) return null;
          const active = edge.from === selected || edge.to === selected;
          const shade = CANVAS_NODE_TYPES[project.nodes.find(n => n.id === edge.from)?.type]?.color;
          return <path key={edge.id} d={connectionPath(a,b)} stroke={shade} opacity={active ? 0.95 : 0.62} />;
        })}{source && floating && from(source) && <path d={connectionPath(from(source), floating)} stroke="#a5c5fd" strokeDasharray="5 4" />}</g></svg>
        {cards}
      </div>}
      {!project.nodes.length && <div className="cc-empty"><Workflow size={28} /><h3>画布里还没有节点</h3><button className="cc-primary" onClick={() => add("prompt")}>添加提示词</button></div>}
      {currentMenuNode && <CreationCanvasNodeMenu key={currentMenuNode.id} node={currentMenuNode} project={project}
        anchor={menuAnchor.current} board={board.current} view={view} onClose={closeNodeMenu} onRemove={removeNode}
        onDisconnect={id => void onEdit(p => ({ ...p, edges: p.edges.filter(e => e.id !== id) }))} />}
    </div>
    <div className="cc-board-bottom">
      {source ? <div className="cc-connect-hint"><GitBranch size={15}/><span>选择目标节点的输入端</span><button onClick={() => setSource(null)} aria-label="取消连线"><X size={14}/></button></div>
      : <button className="cc-help" aria-expanded={help} onClick={() => { setHelp(!help); setMenu(""); }}><CircleHelp size={15}/>操作说明</button>}
      {!list && <div className="cc-navigation"><button aria-label="选择节点" aria-pressed={!panMode} title="选择节点" onClick={() => setPanMode(false)}><MousePointer2 size={15}/></button>
        <button aria-label="平移画布" aria-pressed={panMode} title="平移画布" onClick={() => setPanMode(true)}><Hand size={15}/></button>
        <i /><button aria-label="缩小画布" onClick={() => zoom(1 / 1.2)}><Minus size={14}/></button><span>{Math.round(view.k*100)}%</span><button aria-label="放大画布" onClick={() => zoom(1.2)}><Plus size={14}/></button>
        <i /><button aria-label="适应全部节点" title="适应全部节点" onClick={() => fit()}><Maximize size={15}/></button></div>}
      {help && <div className="cc-menu cc-help-text">拖动卡片标题或空白处移动节点，拖动画布背景平移。聚焦节点标题后可用方向键微调。双指捏合或按住 Ctrl / ⌘ 滚动可缩放。点选或拖动输出端到目标节点的输入端即可连线。</div>}
    </div>
  </div>;
}
