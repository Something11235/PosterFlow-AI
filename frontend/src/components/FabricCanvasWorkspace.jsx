import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActiveSelection,
  Canvas,
  FabricImage,
  FabricObject,
  Group,
  Line,
  Point,
  Rect,
  Textbox,
  Triangle,
} from "fabric";
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  Eye,
  FileImage,
  Focus,
  Hand,
  HardDrive,
  Images,
  Loader2,
  MousePointer2,
  Redo2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { apiAssetUrl } from "../lib/client";
import CanvasAiPanel from "./CanvasAiPanel";

const CANVAS_DB_NAME = "posterflow-ai-fabric-canvas";
const CANVAS_DB_STORE = "scenes";
const CANVAS_DB_KEY = "main-v1";
const CANVAS_AI_DRAFT_KEY = "posterflow-ai.canvas-ai-drafts.v1";
const IMPORT_DISPLAY_MAX_WIDTH = 1090;
const IMPORT_DISPLAY_MAX_HEIGHT = 1000;
const REFERENCE_EXPORT_MAX_EDGE = 1600;
const CLEAN_REFERENCE_MAX_BYTES = 1.35 * 1024 * 1024;
const ANNOTATED_REFERENCE_MAX_BYTES = 1.05 * 1024 * 1024;
const CANVAS_AI_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
const ANNOTATION_COLOR = "#ef4444";
const ANNOTATION_TYPES = new Set(["annotation-arrow", "annotation-text", "annotation-shape"]);

const CANVAS_FRAME_RATIOS = {
  square: { label: "1:1", width: 1024, height: 1024, displayWidth: 560, displayHeight: 560 },
  landscape_3_2: { label: "3:2", width: 1536, height: 1024, displayWidth: 720, displayHeight: 480 },
  portrait_2_3: { label: "2:3", width: 1024, height: 1536, displayWidth: 480, displayHeight: 720 },
  landscape_4_3: { label: "4:3", width: 1360, height: 1024, displayWidth: 680, displayHeight: 510 },
  portrait_3_4: { label: "3:4", width: 1024, height: 1360, displayWidth: 510, displayHeight: 680 },
  landscape_16_9: { label: "16:9", width: 1792, height: 1008, displayWidth: 800, displayHeight: 450 },
  portrait_9_16: { label: "9:16", width: 1008, height: 1792, displayWidth: 450, displayHeight: 800 },
};

FabricObject.customProperties = ["posterflowId", "posterflowType", "posterflowMeta"];

function uid(prefix = "object") {
  return prefix + "-" + (crypto.randomUUID?.() || Date.now() + "-" + Math.random().toString(36).slice(2));
}

function openCanvasDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CANVAS_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CANVAS_DB_STORE)) {
        request.result.createObjectStore(CANVAS_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredScene() {
  const db = await openCanvasDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(CANVAS_DB_STORE, "readonly").objectStore(CANVAS_DB_STORE).get(CANVAS_DB_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeStoredScene(scene) {
  const db = await openCanvasDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(CANVAS_DB_STORE, "readwrite");
      transaction.objectStore(CANVAS_DB_STORE).put(scene, CANVAS_DB_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

function markObject(object, type, meta = {}) {
  object.posterflowId = object.posterflowId || uid(type);
  object.posterflowType = type;
  object.posterflowMeta = { ...(object.posterflowMeta || {}), ...meta };
  return object;
}

function objectBounds(object) {
  const bounds = object.getBoundingRect();
  return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
}

function unionBounds(objects) {
  const bounds = objects.filter(Boolean).map(objectBounds);
  if (!bounds.length) return null;
  const minX = Math.min(...bounds.map((box) => box.x));
  const minY = Math.min(...bounds.map((box) => box.y));
  const maxX = Math.max(...bounds.map((box) => box.x + box.w));
  const maxY = Math.max(...bounds.map((box) => box.y + box.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function boxesOverlap(a, b, gap = 12) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

function canvasCenter(canvas) {
  const transform = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const zoom = transform[0] || 1;
  return {
    x: (canvas.getWidth() / 2 - transform[4]) / zoom,
    y: (canvas.getHeight() / 2 - transform[5]) / zoom,
  };
}

function fitObjects(canvas, objects, padding = 90) {
  const bounds = unionBounds(objects);
  if (!bounds) return;
  const width = Math.max(1, canvas.getWidth());
  const height = Math.max(1, canvas.getHeight());
  const zoom = Math.max(0.08, Math.min(2.5, width / (bounds.w + padding * 2), height / (bounds.h + padding * 2)));
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  canvas.setViewportTransform([zoom, 0, 0, zoom, width / 2 - centerX * zoom, height / 2 - centerY * zoom]);
  canvas.requestRenderAll();
}

function loadCanvasDrafts() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CANVAS_AI_DRAFT_KEY));
    return { frame: String(saved?.frame || ""), redraw: String(saved?.redraw || "") };
  } catch {
    return { frame: "", redraw: "" };
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function dataUrlToBlob(dataUrl) {
  const [header, encoded] = dataUrl.split(",", 2);
  const type = /data:([^;]+)/.exec(header)?.[1] || "image/png";
  const bytes = atob(encoded);
  const output = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) output[index] = bytes.charCodeAt(index);
  return new Blob([output], { type });
}

async function createImageObject(file, meta = {}) {
  const dataUrl = await fileToDataUrl(file);
  const image = await FabricImage.fromURL(dataUrl);
  if (!image.width || !image.height) throw new Error("无法解析图片尺寸：" + file.name);
  const scale = Math.min(1, IMPORT_DISPLAY_MAX_WIDTH / image.width, IMPORT_DISPLAY_MAX_HEIGHT / image.height);
  image.set({
    scaleX: scale,
    scaleY: scale,
    originX: "left",
    originY: "top",
    cornerColor: "#4f8cff",
    cornerStrokeColor: "#ffffff",
    borderColor: "#4f8cff",
    transparentCorners: false,
    cornerSize: 12,
  });
  return markObject(image, "image", { filename: file.name, mimeType: file.type || "image/png", ...meta });
}

function setObjectBounds(object, bounds) {
  const baseWidth = Math.max(1, Number(object.width) || 1);
  const baseHeight = Math.max(1, Number(object.height) || 1);
  object.set({ left: bounds.x, top: bounds.y, angle: bounds.angle || 0, scaleX: bounds.w / baseWidth, scaleY: bounds.h / baseHeight });
  object.setCoords();
}

function createArrow(start, end) {
  const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI + 90;
  const line = new Line([start.x, start.y, end.x, end.y], {
    stroke: ANNOTATION_COLOR,
    strokeWidth: 8,
    strokeLineCap: "round",
    selectable: false,
    evented: false,
  });
  const head = new Triangle({
    left: end.x,
    top: end.y,
    width: 28,
    height: 34,
    fill: ANNOTATION_COLOR,
    angle,
    originX: "center",
    originY: "center",
    selectable: false,
    evented: false,
  });
  const group = new Group([line, head], {
    subTargetCheck: false,
    objectCaching: false,
    cornerColor: ANNOTATION_COLOR,
    borderColor: ANNOTATION_COLOR,
    transparentCorners: false,
    cornerSize: 12,
  });
  return markObject(group, "annotation-arrow");
}

function createAnnotationText(point) {
  const text = new Textbox("修改说明", {
    left: point.x,
    top: point.y,
    width: 320,
    minWidth: 180,
    fontSize: 38,
    lineHeight: 1.25,
    fontWeight: 700,
    fontFamily: "Microsoft YaHei, Noto Sans SC, sans-serif",
    fill: ANNOTATION_COLOR,
    stroke: "rgba(255,255,255,0.92)",
    strokeWidth: 0.8,
    paintFirst: "stroke",
    backgroundColor: "rgba(255,255,255,0.88)",
    padding: 10,
    cornerColor: ANNOTATION_COLOR,
    borderColor: ANNOTATION_COLOR,
    transparentCorners: false,
    cornerSize: 12,
  });
  return markObject(text, "annotation-text");
}

function wrapObject(object) {
  if (!object) return null;
  const bounds = objectBounds(object);
  return {
    id: object.posterflowId,
    raw: object,
    meta: object.posterflowMeta || {},
    props: { w: bounds.w, h: bounds.h },
  };
}

function annotationText(object) {
  return object.posterflowType === "annotation-text" ? String(object.text || "").trim() : "";
}

function selectionSnapshot(canvas) {
  const selected = canvas?.getActiveObjects?.() || [];
  const holders = selected.filter((object) => object.posterflowType === "ai-frame");
  const images = selected.filter((object) => object.posterflowType === "image" || object.type === "image");
  const image = images.length === 1 ? images[0] : null;
  let annotations = image ? selected.filter((object) => object !== image && ANNOTATION_TYPES.has(object.posterflowType)) : [];
  let annotationSource = annotations.length ? "selected" : "none";
  if (image && !annotations.length) {
    const imageBounds = objectBounds(image);
    const margin = Math.max(90, Math.min(260, Math.min(imageBounds.w, imageBounds.h) * 0.2));
    const nearby = {
      x: imageBounds.x - margin,
      y: imageBounds.y - margin,
      w: imageBounds.w + margin * 2,
      h: imageBounds.h + margin * 2,
    };
    annotations = canvas
      .getObjects()
      .filter((object) => object !== image && ANNOTATION_TYPES.has(object.posterflowType))
      .filter((object) => boxesOverlap(nearby, objectBounds(object), 0));
    if (annotations.length) annotationSource = "nearby";
  }
  return {
    holder: holders.length === 1 ? wrapObject(holders[0]) : null,
    image: image ? wrapObject(image) : null,
    imageCount: images.length,
    annotationCount: annotations.length,
    annotationTexts: annotations.map(annotationText).filter(Boolean),
    annotationSource,
    objects: image ? [image, ...annotations] : selected,
  };
}

function normalizedImageSize(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const ratio = safeWidth / safeHeight;
  if (ratio >= 1) {
    const targetHeight = 1024;
    return { width: Math.min(2048, Math.max(256, Math.round((targetHeight * ratio) / 8) * 8)), height: targetHeight };
  }
  const targetWidth = 1024;
  return { width: targetWidth, height: Math.min(2048, Math.max(256, Math.round((targetWidth / ratio) / 8) * 8)) };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function compressReferenceBlob(blob, maxBytes) {
  if (blob.size <= maxBytes) return blob;
  const bitmap = await createImageBitmap(blob);
  let scale = 1;
  let quality = 0.9;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("浏览器无法创建参考图压缩画布。");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const compressed = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("参考图压缩失败。"))),
          "image/jpeg",
          quality,
        );
      });
      if (compressed.size <= maxBytes) return compressed;
      if (quality > 0.65) quality -= 0.1;
      else {
        scale *= 0.8;
        quality = 0.82;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("参考图压缩后仍然过大，请缩小画布选区后重试。");
}

async function exportObjects(canvas, objects, padding = 0, maxEdge = null, maxBytes = CLEAN_REFERENCE_MAX_BYTES) {
  const targets = objects.filter((object) => object && canvas.getObjects().includes(object));
  const bounds = unionBounds(targets);
  if (!bounds) throw new Error("没有可导出的画布内容");
  const previousTransform = [...canvas.viewportTransform];
  const previousBackground = canvas.backgroundColor;
  const previousSelection = canvas.getActiveObjects();
  const visibility = new Map(canvas.getObjects().map((object) => [object, object.visible]));
  const longestEdge = Math.max(1, bounds.w + padding * 2, bounds.h + padding * 2);
  const multiplier = maxEdge ? Math.min(2, maxEdge / longestEdge) : 2;
  try {
    canvas.discardActiveObject();
    canvas.getObjects().forEach((object) => object.set("visible", targets.includes(object)));
    canvas.backgroundColor = "#ffffff";
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.requestRenderAll();
    const dataUrl = canvas.toDataURL({
      format: "png",
      left: bounds.x - padding,
      top: bounds.y - padding,
      width: bounds.w + padding * 2,
      height: bounds.h + padding * 2,
      multiplier,
    });
    const blob = dataUrlToBlob(dataUrl);
    return maxEdge ? compressReferenceBlob(blob, maxBytes) : blob;
  } finally {
    visibility.forEach((visible, object) => object.set("visible", visible));
    canvas.backgroundColor = previousBackground;
    canvas.setViewportTransform(previousTransform);
    if (previousSelection.length === 1) canvas.setActiveObject(previousSelection[0]);
    else if (previousSelection.length > 1) canvas.setActiveObject(new ActiveSelection(previousSelection, { canvas }));
    canvas.requestRenderAll();
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function imageFilename(filename, contentType) {
  if (/\.[a-z0-9]+$/i.test(filename)) return filename;
  if (contentType === "image/jpeg") return filename + ".jpg";
  if (contentType === "image/webp") return filename + ".webp";
  return filename + ".png";
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function apiError(data, fallback) {
  return {
    message: String(data?.error || data?.message || fallback),
    detail: String(data?.detail || "请检查图片服务、提示词与参考图后重试。"),
  };
}


async function readApiResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const requestTooLarge = response.status === 413 || /request (entity|body) too large/i.test(text);
    return {
      error: requestTooLarge ? "重绘参考图超过在线传输限制" : "图片服务返回了无法识别的响应",
      code: requestTooLarge ? "REQUEST_TOO_LARGE" : "INVALID_RESPONSE",
      detail: requestTooLarge
        ? "参考图经过编码后仍超过 Vercel 请求体限制，请重新检查参考图后再生成。"
        : "接口返回的不是 JSON 数据。HTTP " + response.status + "。",
    };
  }
}
function ReferencePreview({ preview, closeButtonRef, onClose }) {
  return (
    <div
      className="absolute inset-0 z-[650] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-border-default bg-bg-secondary shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="redraw-reference-preview-title"
      >
        <div className="flex min-h-16 items-center justify-between border-b border-border-subtle px-4 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-accent/35 bg-accent/12 text-accent">
              <Eye size={17} />
            </div>
            <div className="min-w-0">
              <h2 id="redraw-reference-preview-title" className="text-sm font-semibold text-text-primary">
                生成前检查
              </h2>
              <p className="truncate text-xs text-text-muted">
                {preview.annotationCount
                  ? (preview.annotationSource === "nearby" ? "自动关联 " : "已选择 ") +
                    preview.annotationCount +
                    " 个标注"
                  : "未检测到标注"}
              </p>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-muted transition hover:bg-bg-elevated hover:text-text-primary"
            aria-label="关闭生成前检查"
            title="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <figure className="min-w-0">
              <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-primary">
                <img
                  src={preview.cleanUrl}
                  alt="提交给模型的干净原图"
                  className="max-h-[52vh] w-full object-contain"
                />
              </div>
              <figcaption className="mt-2 flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-text-secondary">图 1 · 干净原图</span>
                <span className="tabular-nums text-text-muted">{formatBytes(preview.cleanBytes)}</span>
              </figcaption>
            </figure>
            <figure className="min-w-0">
              <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-primary">
                {preview.annotationUrl ? (
                  <img
                    src={preview.annotationUrl}
                    alt="提交给模型的箭头文字标注图"
                    className="max-h-[52vh] w-full object-contain"
                  />
                ) : (
                  <div className="px-6 text-center">
                    <TriangleAlert size={24} className="mx-auto text-gold" />
                    <p className="mt-3 text-sm font-medium text-text-secondary">没有可提交的标注</p>
                    <p className="mt-1 text-xs leading-5 text-text-muted">在原图内或附近添加箭头和文字后重新检查。</p>
                  </div>
                )}
              </div>
              <figcaption className="mt-2 flex items-center justify-between gap-3 text-xs">
                <span className="font-medium text-text-secondary">图 2 · 标注说明图</span>
                <span className="tabular-nums text-text-muted">
                  {preview.annotationUrl ? formatBytes(preview.annotationBytes) : "未生成"}
                </span>
              </figcaption>
            </figure>
          </div>
          {preview.annotationTexts.length > 0 && (
            <div className="mt-5 border-t border-border-subtle pt-4">
              <p className="text-xs font-medium text-mint">模型将同时收到以下文字要求</p>
              <ol className="mt-2 grid gap-2 text-sm leading-6 text-text-secondary sm:grid-cols-2">
                {preview.annotationTexts.map((text, index) => (
                  <li key={index + "-" + text} className="min-w-0 break-words">
                    <span className="mr-2 tabular-nums text-text-muted">{index + 1}.</span>
                    {text}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function FabricCanvasWorkspace({
  galleryImages,
  pendingImport,
  onImportHandled,
  onNotice,
  providerConfigured,
  providerName,
  providerHeaders,
  onOpenProvider,
  onCanvasGenerated,
}) {
  const [canvas, setCanvas] = useState(null);
  const [canvasReady, setCanvasReady] = useState(false);
  const [status, setStatus] = useState({ type: "saved", message: "正在读取本机画布" });
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [referencePreview, setReferencePreview] = useState(null);
  const [aiPanelOpen, setAiPanelOpen] = useState(() => window.matchMedia("(min-width: 1024px)").matches);
  const [workflow, setWorkflow] = useState("frame");
  const [ratioKey, setRatioKey] = useState("landscape_16_9");
  const [drafts, setDrafts] = useState(loadCanvasDrafts);
  const [strength, setStrength] = useState(0.65);
  const [quality, setQuality] = useState("high");
  const [aiError, setAiError] = useState(null);
  const [selection, setSelection] = useState(() => selectionSnapshot(null));
  const [tool, setTool] = useState("select");
  const [zoom, setZoom] = useState(100);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const canvasElementRef = useRef(null);
  const canvasHostRef = useRef(null);
  const fileInputRef = useRef(null);
  const handledImportsRef = useRef(new Set());
  const previewCloseButtonRef = useRef(null);
  const previewReturnFocusRef = useRef(null);
  const toolRef = useRef("select");
  const batchRef = useRef(false);
  const restoringRef = useRef(false);
  const commitRef = useRef(() => {});
  const persistRef = useRef(() => {});
  const undoRef = useRef(() => {});
  const redoRef = useRef(() => {});
  const isBusy = busy || aiBusy || previewBusy;

  useEffect(() => {
    window.localStorage.setItem(CANVAS_AI_DRAFT_KEY, JSON.stringify(drafts));
  }, [drafts]);

  useEffect(() => {
    if (!referencePreview) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setReferencePreview(null);
      if (event.key === "Tab") {
        event.preventDefault();
        previewCloseButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    previewCloseButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      if (referencePreview.cleanUrl) URL.revokeObjectURL(referencePreview.cleanUrl);
      if (referencePreview.annotationUrl) URL.revokeObjectURL(referencePreview.annotationUrl);
      previewReturnFocusRef.current?.focus();
    };
  }, [referencePreview]);

  useEffect(() => {
    if (!canvasElementRef.current || !canvasHostRef.current) return undefined;
    const host = canvasHostRef.current;
    const editor = new Canvas(canvasElementRef.current, {
      width: Math.max(320, host.clientWidth),
      height: Math.max(420, host.clientHeight),
      backgroundColor: "#111821",
      preserveObjectStacking: true,
      selection: true,
      stopContextMenu: true,
      fireRightClick: true,
    });
    const history = [];
    let historyIndex = -1;
    let commitTimer = 0;
    let persistTimer = 0;
    let panState = null;
    let arrowState = null;

    const snapshot = () => ({
      canvas: editor.toJSON(["posterflowId", "posterflowType", "posterflowMeta"]),
      viewportTransform: [...editor.viewportTransform],
      updatedAt: Date.now(),
    });
    const updateHistoryState = () => {
      setCanUndo(historyIndex > 0);
      setCanRedo(historyIndex >= 0 && historyIndex < history.length - 1);
    };
    const persist = (scene = snapshot()) => {
      window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(() => {
        writeStoredScene(scene)
          .then(() =>
            setStatus((current) =>
              current.type === "loading" ? current : { type: "saved", message: "已保存到当前浏览器" },
            ),
          )
          .catch((error) => {
            console.error("Failed to persist Fabric canvas", error);
            setStatus({ type: "error", message: "本机画布保存失败" });
          });
      }, 250);
    };
    const commit = () => {
      if (restoringRef.current || batchRef.current) return;
      window.clearTimeout(commitTimer);
      commitTimer = window.setTimeout(() => {
        const scene = snapshot();
        const serialized = JSON.stringify(scene.canvas);
        const previous = history[historyIndex];
        if (previous?.serialized === serialized) {
          persist(scene);
          return;
        }
        history.splice(historyIndex + 1);
        history.push({ scene, serialized });
        if (history.length > 50) history.shift();
        historyIndex = history.length - 1;
        updateHistoryState();
        persist(scene);
      }, 180);
    };
    const restoreScene = async (entry) => {
      if (!entry) return;
      restoringRef.current = true;
      editor.discardActiveObject();
      await editor.loadFromJSON(entry.scene.canvas);
      if (entry.scene.viewportTransform?.length === 6) {
        editor.setViewportTransform(entry.scene.viewportTransform);
      }
      editor.requestRenderAll();
      restoringRef.current = false;
      setSelection(selectionSnapshot(editor));
      setZoom(Math.round(editor.getZoom() * 100));
      persist(entry.scene);
    };

    commitRef.current = () => {
      window.clearTimeout(commitTimer);
      const scene = snapshot();
      const serialized = JSON.stringify(scene.canvas);
      history.splice(historyIndex + 1);
      history.push({ scene, serialized });
      if (history.length > 50) history.shift();
      historyIndex = history.length - 1;
      updateHistoryState();
      persist(scene);
    };
    persistRef.current = () => persist(snapshot());
    undoRef.current = async () => {
      if (historyIndex <= 0) return;
      historyIndex -= 1;
      await restoreScene(history[historyIndex]);
      updateHistoryState();
      setStatus({ type: "saved", message: "已撤销" });
    };
    redoRef.current = async () => {
      if (historyIndex >= history.length - 1) return;
      historyIndex += 1;
      await restoreScene(history[historyIndex]);
      updateHistoryState();
      setStatus({ type: "saved", message: "已重做" });
    };

    const syncSelection = () => setSelection(selectionSnapshot(editor));
    const syncZoom = () => setZoom(Math.round(editor.getZoom() * 100));
    const commitObjectChange = () => {
      syncSelection();
      commit();
    };
    const handleSelectionChange = () => syncSelection();
    const handleMouseWheel = (options) => {
      const event = options.e;
      event.preventDefault();
      event.stopPropagation();
      let nextZoom = editor.getZoom() * Math.pow(0.999, event.deltaY);
      nextZoom = Math.max(0.08, Math.min(4, nextZoom));
      editor.zoomToPoint(new Point(event.offsetX, event.offsetY), nextZoom);
      syncZoom();
      persist();
    };
    const handleMouseDown = (options) => {
      const event = options.e;
      const panRequested = toolRef.current === "hand" || event.button === 1 || event.altKey;
      if (panRequested) {
        panState = {
          x: event.clientX,
          y: event.clientY,
          transform: [...editor.viewportTransform],
        };
        editor.selection = false;
        editor.defaultCursor = "grabbing";
        editor.setCursor("grabbing");
        return;
      }
      if (toolRef.current === "arrow" && event.button === 0) {
        const point = editor.getScenePoint(event);
        const preview = new Line([point.x, point.y, point.x, point.y], {
          stroke: ANNOTATION_COLOR,
          strokeWidth: 8,
          strokeLineCap: "round",
          selectable: false,
          evented: false,
          excludeFromExport: true,
        });
        arrowState = { start: point, preview };
        batchRef.current = true;
        editor.add(preview);
        editor.requestRenderAll();
        return;
      }
      if (toolRef.current === "text" && event.button === 0) {
        const point = editor.getScenePoint(event);
        const textObject = createAnnotationText(point);
        batchRef.current = true;
        editor.add(textObject);
        batchRef.current = false;
        editor.setActiveObject(textObject);
        textObject.enterEditing();
        textObject.selectAll();
        editor.requestRenderAll();
        setTool("select");
        toolRef.current = "select";
        editor.selection = true;
        editor.skipTargetFind = false;
        editor.defaultCursor = "default";
        commitRef.current();
      }
    };
    const handleMouseMove = (options) => {
      const event = options.e;
      if (panState) {
        const transform = [...panState.transform];
        transform[4] += event.clientX - panState.x;
        transform[5] += event.clientY - panState.y;
        editor.setViewportTransform(transform);
        editor.requestRenderAll();
        return;
      }
      if (arrowState) {
        const point = editor.getScenePoint(event);
        arrowState.preview.set({ x2: point.x, y2: point.y });
        arrowState.preview.setCoords();
        editor.requestRenderAll();
      }
    };
    const handleMouseUp = (options) => {
      if (panState) {
        panState = null;
        editor.selection = toolRef.current === "select";
        editor.defaultCursor =
          toolRef.current === "hand" ? "grab" : toolRef.current === "arrow" ? "crosshair" : "default";
        editor.setCursor(editor.defaultCursor);
        persist();
        return;
      }
      if (!arrowState) return;
      const point = editor.getScenePoint(options.e);
      const { start, preview } = arrowState;
      arrowState = null;
      editor.remove(preview);
      const distance = Math.hypot(point.x - start.x, point.y - start.y);
      if (distance >= 12) {
        const arrow = createArrow(start, point);
        editor.add(arrow);
        editor.setActiveObject(arrow);
      }
      batchRef.current = false;
      setTool("select");
      toolRef.current = "select";
      editor.selection = true;
      editor.skipTargetFind = false;
      editor.defaultCursor = "default";
      editor.requestRenderAll();
      commitRef.current();
    };
    const handleKeyDown = (event) => {
      const target = event.target;
      const isEditing =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && !isEditing && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redoRef.current();
        else undoRef.current();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !isEditing && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redoRef.current();
        return;
      }
      if (event.key === "Escape") {
        editor.discardActiveObject();
        setTool("select");
        toolRef.current = "select";
        editor.selection = true;
        editor.skipTargetFind = false;
        editor.defaultCursor = "default";
        editor.requestRenderAll();
      }
      if (!isEditing && (event.key === "Delete" || event.key === "Backspace")) {
        const active = editor.getActiveObjects();
        if (!active.length) return;
        event.preventDefault();
        editor.discardActiveObject();
        editor.remove(...active);
        editor.requestRenderAll();
        commitRef.current();
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(320, host.clientWidth);
      const height = Math.max(420, host.clientHeight);
      if (width === editor.getWidth() && height === editor.getHeight()) return;
      editor.setDimensions({ width, height });
      editor.requestRenderAll();
    });

    editor.on("selection:created", handleSelectionChange);
    editor.on("selection:updated", handleSelectionChange);
    editor.on("selection:cleared", handleSelectionChange);
    editor.on("object:added", commitObjectChange);
    editor.on("object:modified", commitObjectChange);
    editor.on("object:removed", commitObjectChange);
    editor.on("text:changed", commitObjectChange);
    editor.on("mouse:wheel", handleMouseWheel);
    editor.on("mouse:down", handleMouseDown);
    editor.on("mouse:move", handleMouseMove);
    editor.on("mouse:up", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);
    resizeObserver.observe(host);
    setCanvas(editor);

    readStoredScene()
      .then(async (stored) => {
        if (stored?.canvas) {
          restoringRef.current = true;
          await editor.loadFromJSON(stored.canvas);
          if (stored.viewportTransform?.length === 6) editor.setViewportTransform(stored.viewportTransform);
          restoringRef.current = false;
          editor.requestRenderAll();
        }
        const scene = snapshot();
        history.push({ scene, serialized: JSON.stringify(scene.canvas) });
        historyIndex = 0;
        updateHistoryState();
        syncSelection();
        syncZoom();
        setCanvasReady(true);
        setStatus({ type: "saved", message: "已保存到当前浏览器" });
      })
      .catch((error) => {
        console.error("Failed to restore Fabric canvas", error);
        restoringRef.current = false;
        const scene = snapshot();
        history.push({ scene, serialized: JSON.stringify(scene.canvas) });
        historyIndex = 0;
        updateHistoryState();
        setCanvasReady(true);
        setStatus({ type: "error", message: "旧画布读取失败，已创建新画布" });
      });

    return () => {
      window.clearTimeout(commitTimer);
      window.clearTimeout(persistTimer);
      resizeObserver.disconnect();
      window.removeEventListener("keydown", handleKeyDown);
      editor.dispose();
    };
  }, []);

  const activateTool = useCallback(
    (nextTool) => {
      if (!canvas || isBusy) return;
      toolRef.current = nextTool;
      setTool(nextTool);
      canvas.discardActiveObject();
      canvas.selection = nextTool === "select";
      canvas.skipTargetFind = nextTool !== "select";
      canvas.defaultCursor =
        nextTool === "hand" ? "grab" : nextTool === "arrow" || nextTool === "text" ? "crosshair" : "default";
      canvas.setCursor(canvas.defaultCursor);
      canvas.requestRenderAll();
    },
    [canvas, isBusy],
  );

  const addFiles = useCallback(
    async (files, point) => {
      if (!canvas || !files.length) return [];
      setBusy(true);
      setStatus({ type: "loading", message: "正在解析并渲染图片" });
      try {
        const objects = await Promise.all(files.map((file) => createImageObject(file, { source: "local" })));
        const center = point || canvasCenter(canvas);
        const gap = 36;
        const totalWidth = objects.reduce((sum, object) => sum + object.getScaledWidth(), 0) + gap * (objects.length - 1);
        let cursorX = center.x - totalWidth / 2;
        batchRef.current = true;
        objects.forEach((object) => {
          object.set({
            left: cursorX,
            top: center.y - object.getScaledHeight() / 2,
          });
          object.setCoords();
          cursorX += object.getScaledWidth() + gap;
        });
        canvas.add(...objects);
        batchRef.current = false;
        if (objects.length === 1) canvas.setActiveObject(objects[0]);
        else canvas.setActiveObject(new ActiveSelection(objects, { canvas }));
        canvas.requestRenderAll();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const rendered = objects.every(
          (object) =>
            object.canvas === canvas &&
            canvas.getObjects().includes(object) &&
            object.getElement()?.naturalWidth > 0 &&
            object.getElement()?.naturalHeight > 0,
        );
        if (!rendered) throw new Error("图片对象已创建，但浏览器没有完成像素渲染");
        fitObjects(canvas, objects);
        commitRef.current();
        setSelection(selectionSnapshot(canvas));
        setStatus({ type: "saved", message: "已加入 " + objects.length + " 张图片" });
        onNotice?.("已加入画布：" + objects.length + " 张图片");
        return objects;
      } catch (error) {
        batchRef.current = false;
        console.error("Failed to add Fabric canvas files", error);
        setStatus({ type: "error", message: "图片导入失败" });
        onNotice?.("图片导入失败：" + (error.message || "无法读取本地文件"));
        return [];
      } finally {
        setBusy(false);
      }
    },
    [canvas, onNotice],
  );

  const fetchGeneratedFile = useCallback(async (filename) => {
    const response = await fetch(apiAssetUrl("images", filename));
    if (!response.ok) throw new Error("图片请求失败：" + response.status);
    const blob = await response.blob();
    return new File([blob], imageFilename(filename, blob.type), { type: blob.type || "image/png" });
  }, []);

  const addGeneratedImages = useCallback(
    async (filenames) => {
      if (!canvas || !filenames.length) return [];
      setStatus({ type: "loading", message: "正在读取生成图片" });
      try {
        const files = await Promise.all(filenames.map(fetchGeneratedFile));
        return await addFiles(files);
      } catch (error) {
        console.error("Failed to import generated images", error);
        setStatus({ type: "error", message: "生成图片读取失败" });
        onNotice?.("生成图片已过期或暂时无法读取");
        return [];
      }
    },
    [addFiles, canvas, fetchGeneratedFile, onNotice],
  );

  useEffect(() => {
    if (!canvasReady || !pendingImport?.id || handledImportsRef.current.has(pendingImport.id)) return;
    handledImportsRef.current.add(pendingImport.id);
    addGeneratedImages(pendingImport.filenames).finally(() => onImportHandled?.(pendingImport.id));
  }, [addGeneratedImages, canvasReady, onImportHandled, pendingImport]);

  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await addFiles(files);
  };

  const handleExport = async () => {
    if (!canvas) return;
    const selected = canvas.getActiveObjects();
    const objects = selected.length ? selected : canvas.getObjects().filter((object) => !object.excludeFromExport);
    if (!objects.length) {
      setStatus({ type: "error", message: "画布中没有可导出的内容" });
      return;
    }
    setBusy(true);
    setStatus({ type: "loading", message: "正在导出 PNG" });
    try {
      const blob = await exportObjects(canvas, objects, 32);
      downloadBlob(blob, selected.length ? "posterflow-selection.png" : "posterflow-canvas.png");
      setStatus({ type: "saved", message: selected.length ? "选区已导出" : "画布已导出" });
    } catch (error) {
      console.error("Failed to export Fabric canvas", error);
      setStatus({ type: "error", message: "画布导出失败" });
    } finally {
      setBusy(false);
    }
  };

  const handleClear = () => {
    if (!canvas || !canvas.getObjects().length) return;
    if (!window.confirm("确定清空当前画布吗？清空后仍可立即使用撤销恢复。")) return;
    batchRef.current = true;
    canvas.discardActiveObject();
    canvas.remove(...canvas.getObjects());
    batchRef.current = false;
    canvas.requestRenderAll();
    commitRef.current();
    setSelection(selectionSnapshot(canvas));
    setStatus({ type: "saved", message: "画布已清空" });
  };

  const createAiFrame = () => {
    if (!canvas || isBusy) return;
    const ratio = CANVAS_FRAME_RATIOS[ratioKey];
    const center = canvasCenter(canvas);
    const frame = new Rect({
      left: center.x - ratio.displayWidth / 2,
      top: center.y - ratio.displayHeight / 2,
      width: ratio.displayWidth,
      height: ratio.displayHeight,
      fill: "rgba(79,140,255,0.08)",
      stroke: "#4f8cff",
      strokeWidth: 3,
      strokeDashArray: [14, 10],
      cornerColor: "#4f8cff",
      cornerStrokeColor: "#ffffff",
      borderColor: "#4f8cff",
      transparentCorners: false,
      cornerSize: 12,
    });
    markObject(frame, "ai-frame", {
      posterflowRatioKey: ratioKey,
      posterflowRatioLabel: ratio.label,
      posterflowTargetWidth: ratio.width,
      posterflowTargetHeight: ratio.height,
    });
    canvas.add(frame);
    canvas.setActiveObject(frame);
    fitObjects(canvas, [frame], 120);
    commitRef.current();
    setWorkflow("frame");
    setAiPanelOpen(true);
    setAiError(null);
    setSelection(selectionSnapshot(canvas));
    setStatus({ type: "saved", message: "已新建 " + ratio.label + " AI 图片框" });
  };

  const placeGeneratedImage = useCallback(
    async ({ filename, target, targetWorkflow, historyId }) => {
      if (!canvas) throw new Error("画布尚未就绪");
      const file = await fetchGeneratedFile(filename);
      const image = await createImageObject(file, {
        posterflowHistoryId: historyId,
        generated: true,
      });
      const source = target.raw;
      if (!source || !canvas.getObjects().includes(source)) throw new Error("目标对象已不在画布中");
      const sourceBounds = objectBounds(source);
      batchRef.current = true;
      if (targetWorkflow === "frame") {
        setObjectBounds(image, sourceBounds);
        image.posterflowMeta = {
          ...image.posterflowMeta,
          posterflowGeneratedForAiImageHolder: target.id,
        };
        canvas.add(image);
        canvas.remove(source);
      } else {
        let x = sourceBounds.x + sourceBounds.w + 40;
        const occupied = canvas
          .getObjects()
          .filter((object) => object !== source)
          .map(objectBounds);
        let candidate = { x, y: sourceBounds.y, w: sourceBounds.w, h: sourceBounds.h };
        while (occupied.some((bounds) => boxesOverlap(candidate, bounds)) && x < sourceBounds.x + sourceBounds.w * 8) {
          x += sourceBounds.w + 40;
          candidate = { ...candidate, x };
        }
        setObjectBounds(image, candidate);
        image.posterflowMeta = {
          ...image.posterflowMeta,
          posterflowGeneratedFromCanvasEdit: true,
          posterflowCanvasSourceShapeId: target.id,
        };
        canvas.add(image);
      }
      batchRef.current = false;
      canvas.setActiveObject(image);
      canvas.requestRenderAll();
      fitObjects(canvas, targetWorkflow === "frame" ? [image] : [source, image], 90);
      commitRef.current();
      setSelection(selectionSnapshot(canvas));
      return image.posterflowId;
    },
    [canvas, fetchGeneratedFile],
  );

  const handleAiGenerate = async () => {
    if (!canvas || !providerConfigured || aiBusy) return;
    const currentSelection = selectionSnapshot(canvas);
    const manualPrompt = drafts[workflow].trim();
    const hasAnnotationInstructions = currentSelection.annotationTexts.length > 0;
    const prompt = manualPrompt || (hasAnnotationInstructions ? "按照画布标注逐项修改" : "");
    if (!prompt) {
      setAiError({
        message: workflow === "frame" ? "请输入生成提示词" : "缺少有效修改要求",
        detail: workflow === "frame" ? "请描述需要生成的完整画面。" : "请输入修改要求，或同时选择带文字的画布标注。",
      });
      return;
    }
    const target = workflow === "frame" ? currentSelection.holder : currentSelection.image;
    if (!target) {
      setAiError({
        message: workflow === "frame" ? "请选择一个 AI 图片框" : "请选择一张画布图片",
        detail: workflow === "frame" ? "可以先新建图框，再输入提示词生成。" : "重绘时一次只能选择一张原图。",
      });
      return;
    }

    setAiBusy(true);
    setAiError(null);
    setStatus({ type: "loading", message: workflow === "frame" ? "正在生成图框内容" : "正在生成重绘版本" });
    try {
      let endpoint = "/api/generate";
      let body;
      if (workflow === "frame") {
        const ratio =
          CANVAS_FRAME_RATIOS[target.meta?.posterflowRatioKey] ||
          normalizedImageSize(target.props.w, target.props.h);
        body = {
          prompt,
          size: "custom",
          custom_width: Number(target.meta?.posterflowTargetWidth) || ratio.width,
          custom_height: Number(target.meta?.posterflowTargetHeight) || ratio.height,
          quality,
          count: 1,
        };
      } else {
        endpoint = "/api/modify";
        const cleanReference = await exportObjects(
          canvas,
          [target.raw],
          0,
          REFERENCE_EXPORT_MAX_EDGE,
          CLEAN_REFERENCE_MAX_BYTES,
        );
        const annotationReference = currentSelection.annotationCount
          ? await exportObjects(
              canvas,
              currentSelection.objects,
              24,
              REFERENCE_EXPORT_MAX_EDGE,
              ANNOTATED_REFERENCE_MAX_BYTES,
            )
          : null;
        const referenceImages = [await blobToBase64(cleanReference)];
        if (annotationReference) referenceImages.push(await blobToBase64(annotationReference));
        const annotationList = currentSelection.annotationTexts
          .map((textValue, index) => String(index + 1) + ". " + textValue)
          .join("\n");
        const redrawPercent = Math.round((1 - strength) * 100);
        const size = normalizedImageSize(target.props.w, target.props.h);
        const editPrompt = [
          "执行局部图片编辑，不要重新创作一张不同风格的图片。",
          "输入图1是唯一的干净原图。严格保留它的画风、人物身份、脸部、姿势、构图、背景、光影、配色和宽高比例。",
          annotationReference
            ? "输入图2是标注说明图，只用于定位和理解红色箭头与红色文字。箭头尖端精确指向需要修改的目标，逐一建立文字、箭头与目标区域的对应关系，不要把标注痕迹画进结果。"
            : "仅根据用户要求修改必要区域，不要改变无关内容。",
          manualPrompt ? "用户补充要求：" + manualPrompt : "用户没有补充文字要求，以标注文字清单为准。",
          annotationList ? "必须逐条执行以下标注文字：\n" + annotationList : "没有可提取的标注文字，请结合标注图和用户补充要求判断修改位置。",
          "本次重绘幅度为 " + redrawPercent + "%。只允许为完成上述要求而做必要改动，未点名区域必须与输入图1保持一致。",
          "输出一张与输入图1同画风、同构图的干净成图，不要输出对比图、说明文字、箭头、边框或编辑器界面。",
        ].join("\n");
        body = {
          prompt: editPrompt,
          reference_images_b64: referenceImages,
          size: "custom",
          custom_width: size.width,
          custom_height: size.height,
          quality,
          strength,
        };
      }

      const requestBody = JSON.stringify(body);
      const requestBytes = new Blob([requestBody]).size;
      if (requestBytes > CANVAS_AI_REQUEST_MAX_BYTES) {
        setAiError({
          message: "重绘参考图超过在线传输限制",
          detail: "本次请求编码后为 " + formatBytes(requestBytes) + "，请重新检查参考图后再生成。",
        });
        setStatus({ type: "error", message: "重绘请求体积过大" });
        return;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...providerHeaders },
        body: requestBody,
      });
      const data = await readApiResponse(response);
      if (!response.ok || data.error) {
        setAiError(apiError(data, workflow === "frame" ? "图框生成失败" : "画布重绘失败"));
        setStatus({ type: "error", message: workflow === "frame" ? "图框生成失败" : "画布重绘失败" });
        return;
      }
      const result = data.images?.[0];
      if (!result?.filename) throw new Error("生成响应没有返回图片");
      await placeGeneratedImage({
        filename: result.filename,
        target,
        targetWorkflow: workflow,
        historyId: data.history_id,
      });
      onCanvasGenerated?.({ image: result, prompt: data.prompt || prompt, historyId: data.history_id });
      setStatus({ type: "saved", message: workflow === "frame" ? "图框内容已生成" : "重绘版本已放到原图右侧" });
      onNotice?.(workflow === "frame" ? "AI 图片框已替换为生成结果" : "重绘版本已生成并保留原图");
    } catch (error) {
      console.error("Fabric canvas AI generation failed", error);
      setAiError({ message: "画布 AI 生成失败", detail: error.message || "浏览器未能完成服务请求或结果插入。" });
      setStatus({ type: "error", message: "画布 AI 生成失败" });
    } finally {
      setAiBusy(false);
    }
  };

  const handlePreviewReferences = async () => {
    if (!canvas || previewBusy || aiBusy) return;
    const currentSelection = selectionSnapshot(canvas);
    if (!currentSelection.image) {
      setAiError({ message: "请选择一张画布图片", detail: "检查参考图时一次只能选择一张重绘原图。" });
      return;
    }
    setPreviewBusy(true);
    setAiError(null);
    previewReturnFocusRef.current = document.activeElement;
    setStatus({ type: "loading", message: "正在准备重绘检查" });
    try {
      const cleanBlob = await exportObjects(
        canvas,
        [currentSelection.image.raw],
        0,
        REFERENCE_EXPORT_MAX_EDGE,
        CLEAN_REFERENCE_MAX_BYTES,
      );
      const annotationBlob = currentSelection.annotationCount
        ? await exportObjects(
            canvas,
            currentSelection.objects,
            24,
            REFERENCE_EXPORT_MAX_EDGE,
            ANNOTATED_REFERENCE_MAX_BYTES,
          )
        : null;
      setReferencePreview({
        cleanUrl: URL.createObjectURL(cleanBlob),
        cleanBytes: cleanBlob.size,
        annotationUrl: annotationBlob ? URL.createObjectURL(annotationBlob) : "",
        annotationBytes: annotationBlob?.size || 0,
        annotationCount: currentSelection.annotationCount,
        annotationTexts: currentSelection.annotationTexts,
        annotationSource: currentSelection.annotationSource,
      });
      setStatus({ type: "saved", message: "重绘参考图已准备" });
    } catch (error) {
      console.error("Failed to preview Fabric redraw references", error);
      setAiError({ message: "参考图检查失败", detail: error.message || "浏览器无法导出当前画布选区。" });
      setStatus({ type: "error", message: "参考图检查失败" });
    } finally {
      setPreviewBusy(false);
    }
  };

  const statusIcon =
    status.type === "loading" ? (
      <Loader2 size={14} className="animate-spin-soft text-accent" />
    ) : status.type === "error" ? (
      <TriangleAlert size={14} className="text-error" />
    ) : (
      <CheckCircle2 size={14} className="text-mint" />
    );

  const toolButtons = [
    { id: "select", label: "选择", icon: MousePointer2 },
    { id: "hand", label: "平移", icon: Hand },
    { id: "arrow", label: "红色箭头", icon: ArrowUpRight },
    { id: "text", label: "红色文字", icon: Type },
  ];

  return (
    <section className="flex h-[680px] min-w-0 flex-col bg-bg-primary lg:h-full lg:min-h-0" aria-label="PosterFlow 无限画布">
      <div className="flex min-h-16 flex-shrink-0 items-center gap-3 overflow-x-auto border-b border-border-subtle bg-bg-secondary px-3 py-2 lg:px-4">
        <div className="hidden min-w-0 items-center gap-2 pr-2 sm:flex">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-accent/30 bg-accent/12 text-accent">
            <Images size={17} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-text-primary">默认画布</p>
            <div className="flex items-center gap-1.5 text-xs text-text-muted">
              <HardDrive size={12} />
              本机项目
            </div>
          </div>
        </div>

        <div className="ml-auto flex flex-shrink-0 items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => setAiPanelOpen((open) => !open)}
            disabled={!canvasReady}
            aria-pressed={aiPanelOpen}
            className={
              "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 " +
              (aiPanelOpen
                ? "border-accent/45 bg-accent/12 text-accent"
                : "border-border-subtle bg-bg-tertiary text-text-secondary hover:border-border-default hover:bg-bg-elevated hover:text-text-primary")
            }
            title="画布 AI"
          >
            <Sparkles size={16} />
            <span className="hidden sm:inline">画布 AI</span>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canvasReady || isBusy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-subtle bg-bg-tertiary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            title="导入本地图片"
          >
            <FileImage size={16} />
            <span className="hidden md:inline">本地图片</span>
          </button>
          <button
            type="button"
            onClick={() => addGeneratedImages((galleryImages || []).map((image) => image.filename))}
            disabled={!canvasReady || isBusy || !galleryImages?.length}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-subtle bg-bg-tertiary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            title="把当前生成结果加入画布"
          >
            <Images size={16} />
            <span className="hidden md:inline">当前结果</span>
            {!!galleryImages?.length && <span className="text-xs text-text-muted">{galleryImages.length}</span>}
          </button>
          <button
            type="button"
            onClick={() => canvas && fitObjects(canvas, canvas.getObjects())}
            disabled={!canvasReady || isBusy || !canvas?.getObjects().length}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-subtle bg-bg-tertiary text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="适应画布内容"
            title="适应画布内容"
          >
            <Focus size={16} />
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!canvasReady || isBusy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
            title="导出选区或整页 PNG"
          >
            <Download size={16} />
            <span className="hidden sm:inline">导出 PNG</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={!canvasReady || isBusy}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-subtle bg-bg-tertiary text-text-muted transition hover:border-error/35 hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="清空画布"
            title="清空画布"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#111821]">
        <div ref={canvasHostRef} className="absolute inset-0 overflow-hidden">
          <canvas ref={canvasElementRef} aria-label="可编辑无限画布" />
        </div>

        <div className="absolute left-3 top-3 z-20 flex flex-col gap-1 rounded-md border border-border-default bg-bg-secondary/95 p-1.5 shadow-xl backdrop-blur">
          {toolButtons.map((item) => {
            const Icon = item.icon;
            const active = tool === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => activateTool(item.id)}
                disabled={!canvasReady || isBusy}
                aria-label={item.label}
                aria-pressed={active}
                title={item.label}
                className={
                  "flex h-11 w-11 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-45 " +
                  (active ? "bg-accent text-white" : "text-text-secondary hover:bg-bg-elevated hover:text-text-primary")
                }
              >
                <Icon size={19} />
              </button>
            );
          })}
          <div className="my-1 h-px bg-border-subtle" />
          <button
            type="button"
            onClick={() => undoRef.current()}
            disabled={!canvasReady || isBusy || !canUndo}
            aria-label="撤销"
            title="撤销"
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Undo2 size={19} />
          </button>
          <button
            type="button"
            onClick={() => redoRef.current()}
            disabled={!canvasReady || isBusy || !canRedo}
            aria-label="重做"
            title="重做"
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Redo2 size={19} />
          </button>
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3 z-20 rounded-md border border-border-subtle bg-bg-secondary/92 px-3 py-2 text-xs tabular-nums text-text-muted shadow-lg backdrop-blur">
          {zoom}%
        </div>

        {!canvasReady && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-primary/80 backdrop-blur-sm">
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <Loader2 size={18} className="animate-spin-soft text-accent" />
              正在恢复本机画布
            </div>
          </div>
        )}

        {aiPanelOpen && (
          <CanvasAiPanel
            workflow={workflow}
            onWorkflowChange={(nextWorkflow) => {
              setWorkflow(nextWorkflow);
              setAiError(null);
            }}
            onClose={() => setAiPanelOpen(false)}
            ratios={CANVAS_FRAME_RATIOS}
            ratioKey={ratioKey}
            onRatioChange={setRatioKey}
            onCreateFrame={createAiFrame}
            selection={selection}
            prompt={drafts[workflow]}
            onPromptChange={(value) => setDrafts((current) => ({ ...current, [workflow]: value }))}
            strength={strength}
            onStrengthChange={setStrength}
            quality={quality}
            onQualityChange={setQuality}
            onPreviewReferences={handlePreviewReferences}
            previewBusy={previewBusy}
            onGenerate={handleAiGenerate}
            busy={aiBusy}
            error={aiError}
            providerConfigured={providerConfigured}
            providerName={providerName}
            onOpenProvider={onOpenProvider}
          />
        )}

        {referencePreview && (
          <ReferencePreview
            preview={referencePreview}
            closeButtonRef={previewCloseButtonRef}
            onClose={() => setReferencePreview(null)}
          />
        )}

        <div className="pointer-events-none absolute bottom-3 right-3 z-20 flex min-h-9 items-center gap-2 rounded-md border border-border-subtle bg-bg-secondary/92 px-3 text-xs text-text-muted shadow-lg backdrop-blur">
          {statusIcon}
          <span>{status.message}</span>
        </div>
      </div>
    </section>
  );
}
