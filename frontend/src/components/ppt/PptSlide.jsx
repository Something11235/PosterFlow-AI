import React, { useRef, useState } from "react";

const selectionColor = "#3779f3";

function elementName(element) {
  if (element.type === "text") return element.text?.trim().slice(0, 36) || "文本";
  return element.type === "image" ? "图片" : "形状";
}

export default function PptSlide({ slide, selected = [], onSelect, font }) {
  const drag = useRef(null);
  const [box, setBox] = useState(null);
  const interactive = Boolean(onSelect);
  const point = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * 1280 / rect.width, y: (event.clientY - rect.top) * 720 / rect.height };
  };
  function pointerDown(event) {
    if (!interactive || !event.isPrimary || event.button !== 0) return;
    drag.current = { ...point(event), id: event.target.closest("[data-element]")?.dataset.element, additive: event.shiftKey };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function rectangle(event) {
    const a = drag.current;
    const b = point(event);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }
  function pointerMove(event) { if (drag.current) setBox(rectangle(event)); }
  function choose(id, additive) {
    if (!id) return onSelect([]);
    onSelect(additive ? selected.includes(id) ? selected.filter(item => item !== id) : [...selected, id] : [id]);
  }
  function pointerUp(event) {
    if (!drag.current) return;
    const area = rectangle(event);
    if (area.width > 5 || area.height > 5) {
      const ids = slide.elements.filter(el => el.x < area.x + area.width && el.x + el.w > area.x && el.y < area.y + area.height && el.y + el.h > area.y).map(el => el.id);
      onSelect(drag.current.additive ? [...new Set([...selected, ...ids])] : ids);
    } else choose(drag.current.id, drag.current.additive);
    drag.current = null;
    setBox(null);
  }
  return <svg className={"ppt-slide" + (interactive ? " is-interactive" : "")} viewBox="0 0 1280 720"
    role={interactive ? "group" : "img"} aria-label={slide.title || "幻灯片"} style={{ background: slide.background || "#ffffff" }}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setBox(null); }}>
    {slide.elements.map(el => {
      const bounds = { x: el.x, y: el.y, width: el.w, height: el.h };
      return <g key={el.id} data-element={el.id} role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? elementName(el) : undefined} aria-pressed={interactive ? selected.includes(el.id) : undefined}
        onKeyDown={interactive ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(el.id, event.shiftKey); } } : undefined}>
        <rect {...bounds} fill={el.fill || (el.type === "rect" ? el.color || "#3264da" : "transparent")} />
        {el.type === "text" && <foreignObject {...bounds} pointerEvents="none"><div xmlns="http://www.w3.org/1999/xhtml"
          style={{ fontFamily: font || "Arial, sans-serif", fontSize: el.fontSize || 32, fontWeight: el.bold ? 700 : 400, textAlign: el.align || "left", lineHeight: 1.18, color: el.color || "#182235", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{el.text}</div></foreignObject>}
        {el.type === "image" && /^data:image\/(?:png|jpe?g);base64,/i.test(el.src || "") && <image {...bounds} href={el.src} preserveAspectRatio="none" pointerEvents="none" />}
      </g>;
    })}
    {interactive && slide.elements.filter(el => selected.includes(el.id)).map(el => <rect key={el.id} x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke={selectionColor} strokeWidth="2" vectorEffect="non-scaling-stroke" pointerEvents="none" />)}
    {box && <rect {...box} fill="#387afa24" stroke={selectionColor} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" pointerEvents="none" />}
  </svg>;
}
