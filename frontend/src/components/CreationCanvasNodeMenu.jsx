import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Trash2, Unlink, X } from "lucide-react";
import { canvasNodeDownloads } from "../lib/creationCanvasDownloads";
import { CanvasDownloadAction } from "./CreationCanvasExport";

export default function CreationCanvasNodeMenu({ node, project, downloadScope, anchor, board, view, onClose, onDisconnect, onRemove }) {
  const panel = useRef(null);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!anchor || !board || !el) return;
    const viewport = window.visualViewport;
    function place() {
      const trigger = anchor.getBoundingClientRect();
      const boardBounds = board.getBoundingClientRect();
      const left = (viewport?.offsetLeft ?? 0) + 8, top = (viewport?.offsetTop ?? 0) + 8;
      const right = left + (viewport?.width ?? document.documentElement.clientWidth) - 16;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
      if (!anchor.isConnected || trigger.right < Math.max(boardBounds.left, left) || trigger.left > Math.min(boardBounds.right, right)
          || trigger.bottom < Math.max(boardBounds.top, top) || trigger.top > Math.min(boardBounds.bottom, bottom)) { onClose(); return; }
      el.style.maxWidth = `${Math.min(255, right - left)}px`;
      const below = bottom - trigger.bottom - 5, above = trigger.top - top - 5;
      const placeAbove = below < el.scrollHeight + 2 && above > below;
      el.style.maxHeight = `${Math.max(40, placeAbove ? above : below)}px`;
      el.style.left = `${Math.max(left, Math.min(trigger.right - el.offsetWidth, right - el.offsetWidth))}px`;
      el.style.top = `${placeAbove ? Math.max(top, trigger.top - 5 - el.offsetHeight) : trigger.bottom + 5}px`;
    }
    const outside = event => {
      if (!el.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    place();
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    const observer = new ResizeObserver(place);
    for (const item of [anchor, board, el]) observer.observe(item);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
      observer.disconnect();
    };
  }, [anchor, board, node.x, node.y, view, onClose]);

  useLayoutEffect(() => {
    panel.current?.querySelector("button")?.focus({ preventScroll: true });
  }, []);

  function closeAndReturn() {
    onClose();
    anchor?.focus({ preventScroll: true });
  }
  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      closeAndReturn();
      return;
    }
    const buttons = [...panel.current.querySelectorAll("button:enabled, a[href]")];
    const i = buttons.indexOf(document.activeElement);
    const destinations = { ArrowDown: (i + 1) % buttons.length, ArrowUp: (i - 1 + buttons.length) % buttons.length, Home: 0, End: buttons.length - 1 };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    buttons[destinations[event.key]].focus();
  }
  return createPortal(<div ref={panel} className="cc-menu cc-node-menu" role="group" aria-label={`${node.title}节点操作`}
    onKeyDown={onKeyDown} onBlur={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget) && e.relatedTarget !== anchor) onClose(); }}>
    <div className="cc-menu-heading"><b>{node.title}</b><button aria-label="关闭节点操作" onClick={closeAndReturn}><X size={15}/></button></div>
    {canvasNodeDownloads(project, node).map(item => <CanvasDownloadAction key={[item.id, item.assetId, item.key, item.url, node.run?.requestId].join("|")} item={item} scope={downloadScope}/>)}
    {project.edges.filter(e => e.to === node.id || e.from === node.id).map(edge => <button key={edge.id} onClick={() => {
      onDisconnect(edge.id); closeAndReturn();
    }}><Unlink size={13}/><span>断开与{project.nodes.find(n => n.id === (edge.from === node.id ? edge.to : edge.from))?.title}的连接</span></button>)}
    <button className="cc-danger" disabled={node.run?.status === "pending"} onClick={() => onRemove(node)}><Trash2 size={14}/>移除节点</button>
  </div>, document.body);
}
