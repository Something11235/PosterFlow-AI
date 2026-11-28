import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import "./creationCanvasTour.css";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function viewBounds() {
  const view = window.visualViewport;
  const left = view?.offsetLeft ?? 0, top = view?.offsetTop ?? 0;
  return {
    left, top, right: left + (view?.width ?? document.documentElement.clientWidth),
    bottom: top + (view?.height ?? window.innerHeight),
  };
}

function positionStep(anchor, highlight, card) {
  const view = viewBounds();
  const rect = anchor.getBoundingClientRect();
  const left = clamp(rect.left - 5, view.left + 2, view.right - 2);
  const top = clamp(rect.top - 5, view.top + 2, view.bottom - 2);
  const right = clamp(rect.right + 5, left, view.right - 2);
  const bottom = clamp(rect.bottom + 5, top, view.bottom - 2);
  const visible = right > left && bottom > top && rect.bottom > view.top && rect.right > view.left;
  highlight.hidden = !visible;
  Object.assign(highlight.style, {
    left: left + "px", top: top + "px", width: (right - left) + "px", height: (bottom - top) + "px",
  });
  const inset = 10, gap = 14;
  card.style.width = Math.min(336, view.right - view.left - inset * 2) + "px";
  card.style.maxHeight = (view.bottom - view.top - inset * 2) + "px";
  const { offsetWidth: width, offsetHeight: height } = card;
  const midX = (left + right - width) / 2, midY = (top + bottom - height) / 2;
  const candidates = [
    [midX, bottom + gap], [midX, top - gap - height], [right + gap, midY], [left - gap - width, midY],
  ];
  let leastOverlap = Infinity;
  for (const [x, y] of candidates) {
    const cardX = clamp(x, view.left + inset, view.right - inset - width);
    const cardY = clamp(y, view.top + inset, view.bottom - inset - height);
    const overlap = Math.max(0, Math.min(right + gap, cardX + width) - Math.max(left - gap, cardX)) *
      Math.max(0, Math.min(bottom + gap, cardY + height) - Math.max(top - gap, cardY));
    if (overlap < leastOverlap) {
      leastOverlap = overlap;
      card.style.left = cardX + "px";
      card.style.top = cardY + "px";
      if (!overlap) break;
    }
  }
}

function findTargets(steps, workspace) {
  return steps.flatMap(step => {
    const anchor = Array.from(workspace.querySelectorAll(step.target)).find(element =>
      element.getClientRects().length && getComputedStyle(element).visibility === "visible");
    return anchor ? [{ step, anchor }] : [];
  });
}

export default function CreationCanvasTour({ steps, onDismiss, label = "画布新手指引", scope = ".cc-workspace" }) {
  const dialog = useRef(null), card = useRef(null), highlight = useRef(null);
  const [targets, setTargets] = useState([]);
  const [page, setPage] = useState(0);
  const titleId = useId(), bodyId = useId();
  const index = Math.min(page, targets.length - 1);
  const current = targets[index];
  const last = index >= targets.length - 1;

  useLayoutEffect(() => {
    const el = dialog.current;
    el.showModal();
    el.querySelector("h2").focus({ preventScroll: true });
    return () => el.close();
  }, []);

  useLayoutEffect(() => {
    const workspace = document.querySelector(scope);
    if (!workspace) return;
    const refresh = () => {
      const found = findTargets(steps, workspace);
      setTargets(previous => previous.length === found.length && previous.every((item, i) =>
        item.anchor === found[i].anchor && item.step === found[i].step) ? previous : found);
    };
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(workspace, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "class"] });
    window.addEventListener("resize", refresh);
    return () => { observer.disconnect(); window.removeEventListener("resize", refresh); };
  }, [steps, scope]);

  useLayoutEffect(() => {
    if (!current) return;
    const { anchor } = current;
    anchor.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const view = window.visualViewport;
    const place = () => positionStep(anchor, highlight.current, card.current);
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    observer.observe(card.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    view?.addEventListener("scroll", place);
    view?.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      view?.removeEventListener("scroll", place);
      view?.removeEventListener("resize", place);
    };
  }, [current]);

  return createPortal(<dialog ref={dialog} className="cc-tour" aria-labelledby={titleId} aria-describedby={bodyId}
    onCancel={event => { event.preventDefault(); onDismiss(); }} onKeyDown={event => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault(); event.stopPropagation();
        setPage(clamp(index + (event.key === "ArrowLeft" ? -1 : 1), 0, targets.length - 1));
      }
    }}>
    <div ref={highlight} hidden={!current} className="cc-tour-highlight" aria-hidden="true" />
    <section className="cc-tour-card" ref={card}>
      <header><span>{label} {current && <b>{index + 1} / {targets.length}</b>}</span>
        <button className="cc-tour-skip" onClick={onDismiss} type="button">跳过</button></header>
      <div aria-live="polite" aria-atomic="true">
        <h2 id={titleId} tabIndex={-1}>{current?.step.title ?? "新手指引"}</h2>
        <p id={bodyId}>{current?.step.description ?? "当前视图暂无可展示的步骤。"}</p>
      </div>
      <footer>
        {index > 0 && <button type="button" className="cc-tour-prev" onClick={() => setPage(index - 1)}><ArrowLeft size={14} aria-hidden="true"/>上一步</button>}
        <button type="button" className="cc-tour-next" onClick={() => last ? onDismiss() : setPage(index + 1)}>
          {last ? "朕已知晓" : "下一步"}{last ? <Check size={15} aria-hidden="true"/> : <ArrowRight size={15} aria-hidden="true"/>}
        </button>
      </footer>
    </section>
  </dialog>, document.body);
}
