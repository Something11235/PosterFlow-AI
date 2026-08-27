import React, { useCallback, useEffect, useRef, useState } from "react";
import { getAssetUrlsByMetaUrl } from "@tldraw/assets/urls";
import {
  CheckCircle2,
  Download,
  Eye,
  FileImage,
  Focus,
  HardDrive,
  Images,
  Loader2,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  createShapeId,
  DefaultColorStyle,
  DefaultSizeStyle,
  ImageShapeUtil,
  renderPlaintextFromRichText,
  Tldraw,
} from "tldraw";
import "tldraw/tldraw.css";
import { apiAssetUrl } from "../lib/client";
import CanvasAiPanel from "./CanvasAiPanel";

const CANVAS_PERSISTENCE_KEY = "posterflow-ai.canvas.main.v1";
const CANVAS_AI_DRAFT_KEY = "posterflow-ai.canvas.drafts.v1";
const TLDRAW_LICENSE_KEY = import.meta.env.VITE_TLDRAW_LICENSE_KEY?.trim();
const TLDRAW_ASSET_URLS = getAssetUrlsByMetaUrl();

const CANVAS_FRAME_RATIOS = {
  square: { label: "1:1", displayWidth: 420, displayHeight: 420, width: 1024, height: 1024 },
  landscape_3_2: { label: "3:2", displayWidth: 540, displayHeight: 360, width: 1536, height: 1024 },
  portrait_2_3: { label: "2:3", displayWidth: 360, displayHeight: 540, width: 1024, height: 1536 },
  landscape_4_3: { label: "4:3", displayWidth: 520, displayHeight: 390, width: 1360, height: 1024 },
  portrait_3_4: { label: "3:4", displayWidth: 390, displayHeight: 520, width: 1024, height: 1360 },
  landscape_16_9: { label: "16:9", displayWidth: 560, displayHeight: 315, width: 1792, height: 1008 },
  portrait_9_16: { label: "9:16", displayWidth: 315, displayHeight: 560, width: 1008, height: 1792 },
};

class AnnotationImageShapeUtil extends ImageShapeUtil {
  static type = "image";

  canBind() {
    return false;
  }
}

const CANVAS_SHAPE_UTILS = [AnnotationImageShapeUtil];
const LARGE_ANNOTATION_TYPES = new Set(["arrow", "draw", "geo", "highlight", "line", "note", "text"]);
const ANNOTATION_MIN_SCALES = {
  arrow: 1.5,
  draw: 1.5,
  geo: 1.25,
  highlight: 1.5,
  line: 1.5,
  note: 1.5,
  text: 2.5,
};
const IMPORT_DISPLAY_MAX_WIDTH = 1400;
const IMPORT_DISPLAY_MAX_HEIGHT = 1000;
const REFERENCE_EXPORT_MAX_EDGE = 2048;
const REFERENCE_EXPORT_MAX_BYTES = 1_350_000;

function annotationPlainText(editor, shape) {
  if (!shape?.props?.richText) return "";
  try {
    return renderPlaintextFromRichText(editor, shape.props.richText).trim();
  } catch {
    return "";
  }
}

function enlargeCanvasAnnotations(editor) {
  const updates = editor
    .getCurrentPageShapes()
    .filter((shape) => {
      if (!LARGE_ANNOTATION_TYPES.has(shape.type)) return false;
      const needsLargerSize = Object.hasOwn(shape.props, "size") && shape.props.size !== "xl";
      const minimumScale = ANNOTATION_MIN_SCALES[shape.type] || 1;
      const needsLargerScale = Object.hasOwn(shape.props, "scale") && Number(shape.props.scale) < minimumScale;
      return needsLargerSize || needsLargerScale;
    })
    .map((shape) => ({
      id: shape.id,
      type: shape.type,
      props: {
        ...shape.props,
        ...(Object.hasOwn(shape.props, "size") ? { size: "xl" } : {}),
        ...(Object.hasOwn(shape.props, "scale")
          ? { scale: Math.max(Number(shape.props.scale) || 1, ANNOTATION_MIN_SCALES[shape.type] || 1) }
          : {}),
      },
    }));
  if (updates.length) editor.updateShapes(updates);
}

function normalizeImportedImages(editor, shapes) {
  const updates = shapes.flatMap((shape) => {
    const width = Number(shape.props.w) || 1;
    const height = Number(shape.props.h) || 1;
    const scale = Math.min(1, IMPORT_DISPLAY_MAX_WIDTH / width, IMPORT_DISPLAY_MAX_HEIGHT / height);
    if (scale >= 1) return [];
    const nextWidth = Math.round(width * scale);
    const nextHeight = Math.round(height * scale);
    return [
      {
        id: shape.id,
        type: "image",
        x: shape.x + (width - nextWidth) / 2,
        y: shape.y + (height - nextHeight) / 2,
        props: { ...shape.props, w: nextWidth, h: nextHeight },
      },
    ];
  });
  if (updates.length) editor.updateShapes(updates);
  return shapes.map((shape) => editor.getShape(shape.id)).filter(Boolean);
}

function loadCanvasDrafts() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(CANVAS_AI_DRAFT_KEY));
    return { frame: String(saved?.frame || ""), redraw: String(saved?.redraw || "") };
  } catch {
    return { frame: "", redraw: "" };
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
  if (contentType === "image/jpeg") return `${filename}.jpg`;
  if (contentType === "image/webp") return `${filename}.webp`;
  return `${filename}.png`;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function normalizedImageSize(width, height) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const ratio = safeWidth / safeHeight;
  let targetWidth;
  let targetHeight;
  if (ratio >= 1) {
    targetHeight = 1024;
    targetWidth = Math.min(2048, Math.round((targetHeight * ratio) / 8) * 8);
  } else {
    targetWidth = 1024;
    targetHeight = Math.min(2048, Math.round((targetWidth / ratio) / 8) * 8);
  }
  return { width: Math.max(256, targetWidth), height: Math.max(256, targetHeight) };
}

function apiError(data, fallback) {
  return {
    message: String(data?.error || data?.message || fallback),
    detail: String(data?.detail || "请检查图片服务、提示词与参考图后重试。"),
  };
}

function boxesOverlap(a, b, gap = 12) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

function selectionSnapshot(editor) {
  const shapes = editor?.getSelectedShapes?.() || [];
  const holders = shapes.filter((shape) => shape.type === "frame" && shape.meta?.posterflowAiImageHolder === true);
  const images = shapes.filter((shape) => shape.type === "image");
  const image = images.length === 1 ? images[0] : null;
  const selectedAnnotations = image
    ? shapes.filter((shape) => shape.id !== image.id && LARGE_ANNOTATION_TYPES.has(shape.type))
    : [];
  let annotationSource = selectedAnnotations.length ? "selected" : "none";
  let annotations = selectedAnnotations;

  if (image && !selectedAnnotations.length) {
    const imageBounds = editor.getShapePageBounds(image.id);
    if (imageBounds) {
      const margin = Math.max(80, Math.min(240, Math.min(imageBounds.w, imageBounds.h) * 0.18));
      const nearbyBounds = {
        x: imageBounds.x - margin,
        y: imageBounds.y - margin,
        w: imageBounds.w + margin * 2,
        h: imageBounds.h + margin * 2,
      };
      annotations = editor
        .getCurrentPageShapes()
        .filter((shape) => shape.id !== image.id && LARGE_ANNOTATION_TYPES.has(shape.type))
        .filter((shape) => {
          const bounds = editor.getShapePageBounds(shape.id);
          return bounds && boxesOverlap(nearbyBounds, bounds, 0);
        });
      if (annotations.length) annotationSource = "nearby";
    }
  }

  const annotationTexts = annotations.map((shape) => annotationPlainText(editor, shape)).filter(Boolean);
  return {
    shapeIds: image ? [image.id, ...annotations.map((shape) => shape.id)] : shapes.map((shape) => shape.id),
    holder: holders.length === 1 ? holders[0] : null,
    image,
    imageCount: images.length,
    annotationCount: annotations.length,
    annotationTexts,
    annotationSource,
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function canvasExportPixelRatio(editor, shapeIds, padding) {
  const bounds = shapeIds.map((id) => editor.getShapePageBounds(id)).filter(Boolean);
  if (!bounds.length) return 1;
  const minX = Math.min(...bounds.map((box) => box.minX));
  const minY = Math.min(...bounds.map((box) => box.minY));
  const maxX = Math.max(...bounds.map((box) => box.maxX));
  const maxY = Math.max(...bounds.map((box) => box.maxY));
  const longestEdge = Math.max(maxX - minX + padding * 2, maxY - minY + padding * 2, 1);
  return Math.min(2, REFERENCE_EXPORT_MAX_EDGE / longestEdge);
}

async function compressReferenceBlob(blob) {
  if (blob.size <= REFERENCE_EXPORT_MAX_BYTES) return blob;

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
      if (compressed.size <= REFERENCE_EXPORT_MAX_BYTES) return compressed;
      if (quality > 0.65) {
        quality -= 0.1;
      } else {
        scale *= 0.8;
        quality = 0.82;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error("参考图压缩后仍然过大，请缩小画布选区后重试。");
}

async function exportCanvasReference(editor, shapeIds, padding = 0) {
  const result = await editor.toImage(shapeIds, {
    background: true,
    darkMode: false,
    format: "png",
    padding,
    pixelRatio: canvasExportPixelRatio(editor, shapeIds, padding),
  });
  return compressReferenceBlob(result.blob);
}

export default function CanvasWorkspace({
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
  const [editor, setEditor] = useState(null);
  const [status, setStatus] = useState({ type: "saved", message: "已保存到当前浏览器" });
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
  const fileInputRef = useRef(null);
  const handledImportsRef = useRef(new Set());
  const previewCloseButtonRef = useRef(null);
  const previewReturnFocusRef = useRef(null);
  const isBusy = busy || aiBusy || previewBusy;

  useEffect(() => {
    window.localStorage.setItem(CANVAS_AI_DRAFT_KEY, JSON.stringify(drafts));
  }, [drafts]);

  useEffect(() => {
    if (!referencePreview) return undefined;
    const handlePreviewKeyDown = (event) => {
      if (event.key === "Escape") setReferencePreview(null);
      if (event.key === "Tab") {
        event.preventDefault();
        previewCloseButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handlePreviewKeyDown);
    previewCloseButtonRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", handlePreviewKeyDown);
      if (referencePreview?.cleanUrl) URL.revokeObjectURL(referencePreview.cleanUrl);
      if (referencePreview?.annotationUrl) URL.revokeObjectURL(referencePreview.annotationUrl);
      previewReturnFocusRef.current?.focus();
    };
  }, [referencePreview]);

  useEffect(() => {
    if (!editor) return undefined;
    let animationFrame = 0;
    const syncSelection = () => {
      animationFrame = 0;
      enlargeCanvasAnnotations(editor);
      setSelection(selectionSnapshot(editor));
    };
    const scheduleSelectionSync = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(syncSelection);
    };
    syncSelection();
    const stopListening = editor.store.listen(scheduleSelectionSync, { scope: "all" });
    return () => {
      stopListening();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [editor]);

  const addFiles = useCallback(
    async (files, point) => {
      if (!editor || !files.length) return [];
      const beforeIds = new Set(editor.getCurrentPageShapeIds());
      setBusy(true);
      setStatus({ type: "loading", message: "正在加入画布" });
      try {
        await editor.putExternalContent({
          type: "files",
          files,
          point: point || editor.getViewportPageBounds().center,
        });
        const added = editor
          .getCurrentPageShapes()
          .filter((shape) => !beforeIds.has(shape.id) && shape.type === "image");
        const normalizedAdded = normalizeImportedImages(editor, added);
        editor.select(...normalizedAdded.map((shape) => shape.id));
        editor.zoomToSelection({ animation: { duration: 220 } });
        setStatus({ type: "saved", message: `已加入 ${files.length} 张图片` });
        onNotice?.(`已加入画布：${files.length} 张图片`);
        return normalizedAdded;
      } catch (error) {
        console.error("Failed to add canvas files", error);
        setStatus({ type: "error", message: "图片加入失败" });
        onNotice?.("图片加入画布失败");
        return [];
      } finally {
        setBusy(false);
      }
    },
    [editor, onNotice],
  );

  const fetchGeneratedFile = useCallback(async (filename) => {
    const response = await fetch(apiAssetUrl("images", filename));
    if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
    const blob = await response.blob();
    return new File([blob], imageFilename(filename, blob.type), { type: blob.type || "image/png" });
  }, []);

  const addGeneratedImages = useCallback(
    async (filenames) => {
      if (!editor || !filenames.length) return;
      setBusy(true);
      setStatus({ type: "loading", message: "正在读取生成图片" });
      try {
        const files = await Promise.all(filenames.map(fetchGeneratedFile));
        const beforeIds = new Set(editor.getCurrentPageShapeIds());
        await editor.putExternalContent({
          type: "files",
          files,
          point: editor.getViewportPageBounds().center,
        });
        const added = editor
          .getCurrentPageShapes()
          .filter((shape) => !beforeIds.has(shape.id) && shape.type === "image");
        const normalizedAdded = normalizeImportedImages(editor, added);
        editor.select(...normalizedAdded.map((shape) => shape.id));
        editor.zoomToSelection({ animation: { duration: 220 } });
        setStatus({ type: "saved", message: `已加入 ${files.length} 张生成图片` });
        onNotice?.(`已加入画布：${files.length} 张生成图片`);
      } catch (error) {
        console.error("Failed to import generated images", error);
        setStatus({ type: "error", message: "生成图片读取失败" });
        onNotice?.("生成图片已过期或暂时无法读取");
      } finally {
        setBusy(false);
      }
    },
    [editor, fetchGeneratedFile, onNotice],
  );

  useEffect(() => {
    if (!editor || !pendingImport?.id || handledImportsRef.current.has(pendingImport.id)) return;
    handledImportsRef.current.add(pendingImport.id);
    addGeneratedImages(pendingImport.filenames).finally(() => onImportHandled?.(pendingImport.id));
  }, [addGeneratedImages, editor, onImportHandled, pendingImport]);

  const handleFileChange = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    await addFiles(files);
  };

  const handleExport = async () => {
    if (!editor) return;
    const selectedIds = editor.getSelectedShapeIds();
    const shapeIds = selectedIds.length ? selectedIds : [...editor.getCurrentPageShapeIds()];
    if (!shapeIds.length) {
      setStatus({ type: "error", message: "画布中没有可导出的内容" });
      return;
    }

    setBusy(true);
    setStatus({ type: "loading", message: "正在导出 PNG" });
    try {
      const result = await editor.toImage(shapeIds, {
        background: true,
        darkMode: false,
        format: "png",
        padding: 32,
        pixelRatio: 2,
      });
      downloadBlob(result.blob, selectedIds.length ? "posterflow-selection.png" : "posterflow-canvas.png");
      setStatus({ type: "saved", message: selectedIds.length ? "选区已导出" : "画布已导出" });
    } catch (error) {
      console.error("Failed to export canvas", error);
      setStatus({ type: "error", message: "画布导出失败" });
    } finally {
      setBusy(false);
    }
  };

  const handleClear = () => {
    if (!editor) return;
    const shapeIds = [...editor.getCurrentPageShapeIds()];
    if (!shapeIds.length) return;
    if (!window.confirm("确定清空当前画布吗？清空后仍可立即使用撤销恢复。")) return;
    editor.deleteShapes(shapeIds);
    setStatus({ type: "saved", message: "画布已清空" });
  };

  const createAiFrame = () => {
    if (!editor || isBusy) return;
    const ratio = CANVAS_FRAME_RATIOS[ratioKey];
    const id = createShapeId();
    const center = editor.getViewportPageBounds().center;
    editor.createShape({
      id,
      type: "frame",
      x: center.x - ratio.displayWidth / 2,
      y: center.y - ratio.displayHeight / 2,
      props: {
        w: ratio.displayWidth,
        h: ratio.displayHeight,
        name: `AI 图片 · ${ratio.label}`,
      },
      meta: {
        posterflowAiImageHolder: true,
        posterflowRatioKey: ratioKey,
        posterflowRatioLabel: ratio.label,
        posterflowTargetWidth: ratio.width,
        posterflowTargetHeight: ratio.height,
      },
    });
    editor.select(id);
    editor.zoomToSelection({ animation: { duration: 220 } });
    setWorkflow("frame");
    setAiPanelOpen(true);
    setAiError(null);
    setStatus({ type: "saved", message: `已新建 ${ratio.label} AI 图片框` });
  };

  const placeGeneratedImage = useCallback(
    async ({ filename, target, targetWorkflow, historyId }) => {
      const file = await fetchGeneratedFile(filename);
      const beforeIds = new Set(editor.getCurrentPageShapeIds());
      const sourceBounds = editor.getShapePageBounds(target.id);
      const provisionalPoint =
        targetWorkflow === "frame" || !sourceBounds
          ? editor.getViewportPageBounds().center
          : { x: sourceBounds.maxX + sourceBounds.w / 2 + 40, y: sourceBounds.midY };
      await editor.putExternalContent({ type: "files", files: [file], point: provisionalPoint });
      const inserted = editor
        .getCurrentPageShapes()
        .find((shape) => !beforeIds.has(shape.id) && shape.type === "image");
      if (!inserted) throw new Error("Generated image shape was not inserted");

      if (targetWorkflow === "frame") {
        const holder = editor.getShape(target.id);
        if (!holder || holder.type !== "frame") throw new Error("AI image frame is no longer available");
        const childIds = editor.getSortedChildIdsForParent(holder.id).filter((id) => id !== inserted.id);
        if (childIds.length) editor.reparentShapes(childIds, holder.parentId);
        editor.reparentShapes([inserted.id], holder.parentId);
        editor.updateShape({
          id: inserted.id,
          type: "image",
          x: holder.x,
          y: holder.y,
          rotation: holder.rotation,
          props: { ...inserted.props, w: holder.props.w, h: holder.props.h },
          meta: {
            ...inserted.meta,
            posterflowGeneratedForAiImageHolder: holder.id,
            posterflowHistoryId: historyId,
          },
        });
        editor.deleteShapes([holder.id]);
      } else if (sourceBounds) {
        const width = sourceBounds.w;
        const height = sourceBounds.h;
        let x = sourceBounds.maxX + 40;
        const y = sourceBounds.y;
        const occupied = editor
          .getCurrentPageShapes()
          .filter((shape) => shape.id !== inserted.id)
          .map((shape) => editor.getShapePageBounds(shape))
          .filter(Boolean)
          .map((bounds) => ({ x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h }));
        let candidate = { x, y, w: width, h: height };
        while (occupied.some((bounds) => boxesOverlap(candidate, bounds)) && x < sourceBounds.maxX + width * 8) {
          x += width + 40;
          candidate = { ...candidate, x };
        }
        editor.reparentShapes([inserted.id], editor.getCurrentPageId());
        editor.updateShape({
          id: inserted.id,
          type: "image",
          x,
          y,
          rotation: 0,
          props: { ...inserted.props, w: width, h: height },
          meta: {
            ...inserted.meta,
            posterflowGeneratedFromCanvasEdit: true,
            posterflowCanvasSourceShapeId: target.id,
            posterflowHistoryId: historyId,
          },
        });
      }

      editor.select(inserted.id);
      editor.zoomToSelection({ animation: { duration: 260 } });
      return inserted.id;
    },
    [editor, fetchGeneratedFile],
  );

  const handleAiGenerate = async () => {
    if (!editor || !providerConfigured || aiBusy) return;
    const currentSelection = selectionSnapshot(editor);
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
        const ratio = CANVAS_FRAME_RATIOS[target.meta?.posterflowRatioKey] || normalizedImageSize(target.props.w, target.props.h);
        const width = Number(target.meta?.posterflowTargetWidth) || ratio.width;
        const height = Number(target.meta?.posterflowTargetHeight) || ratio.height;
        body = {
          prompt,
          size: "custom",
          custom_width: width,
          custom_height: height,
          quality,
          count: 1,
        };
      } else {
        endpoint = "/api/modify";
        const exportIds = currentSelection.shapeIds;
        const cleanReference = await exportCanvasReference(editor, [target.id]);
        const annotationReference =
          currentSelection.annotationCount > 0
            ? await exportCanvasReference(editor, exportIds, 24)
            : null;
        const referenceImages = [await blobToBase64(cleanReference)];
        if (annotationReference) referenceImages.push(await blobToBase64(annotationReference));
        const annotationList = currentSelection.annotationTexts
          .map((text, index) => String(index + 1) + ". " + text)
          .join("\n");
        const redrawPercent = Math.round((1 - strength) * 100);
        const size = normalizedImageSize(target.props.w, target.props.h);
        const editPrompt = [
          "执行局部图片编辑，不要重新创作一张不同风格的图片。",
          "输入图1是唯一的干净原图。严格保留它的画风、人物身份、脸部、姿势、构图、背景、光影、配色和宽高比例。",
          annotationReference
            ? "输入图2是标注说明图，只用于定位和理解箭头、文字、线条与色块；标注文字通常位于箭头起点附近，箭头尖端精确指向需要修改的目标；逐一建立文字、箭头与目标区域的对应关系，不要把任何标注痕迹画进结果。"
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

      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...providerHeaders },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || data.error) {
        setAiError(apiError(data, workflow === "frame" ? "图框生成失败" : "画布重绘失败"));
        setStatus({ type: "error", message: workflow === "frame" ? "图框生成失败" : "画布重绘失败" });
        return;
      }
      const result = data.images?.[0];
      if (!result?.filename) throw new Error("Generation response did not include an image");
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
      console.error("Canvas AI generation failed", error);
      setAiError({ message: "画布 AI 生成失败", detail: "浏览器未能完成参考图导出、服务请求或结果插入。" });
      setStatus({ type: "error", message: "画布 AI 生成失败" });
    } finally {
      setAiBusy(false);
    }
  };

  const handlePreviewReferences = async () => {
    if (!editor || previewBusy || aiBusy) return;
    const currentSelection = selectionSnapshot(editor);
    if (!currentSelection.image) {
      setAiError({ message: "请选择一张画布图片", detail: "检查参考图时一次只能选择一张重绘原图。" });
      return;
    }

    setPreviewBusy(true);
    setAiError(null);
    previewReturnFocusRef.current = document.activeElement;
    setStatus({ type: "loading", message: "正在准备重绘检查" });
    try {
      const cleanBlob = await exportCanvasReference(editor, [currentSelection.image.id]);
      const annotationBlob = currentSelection.annotationCount
        ? await exportCanvasReference(editor, currentSelection.shapeIds, 24)
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
      console.error("Failed to preview redraw references", error);
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
            disabled={!editor}
            aria-pressed={aiPanelOpen}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${
              aiPanelOpen
                ? "border-accent/45 bg-accent/12 text-accent"
                : "border-border-subtle bg-bg-tertiary text-text-secondary hover:border-border-default hover:bg-bg-elevated hover:text-text-primary"
            }`}
            title="画布 AI"
          >
            <Sparkles size={16} />
            <span className="hidden sm:inline">画布 AI</span>
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!editor || isBusy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-subtle bg-bg-tertiary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            title="导入本地图片"
          >
            <FileImage size={16} />
            <span className="hidden md:inline">本地图片</span>
          </button>
          <button
            type="button"
            onClick={() => addGeneratedImages(galleryImages.map((image) => image.filename))}
            disabled={!editor || isBusy || galleryImages.length === 0}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border-subtle bg-bg-tertiary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            title="把当前生成结果加入画布"
          >
            <Images size={16} />
            <span className="hidden md:inline">当前结果</span>
            {galleryImages.length > 0 && <span className="text-xs text-text-muted">{galleryImages.length}</span>}
          </button>
          <button
            type="button"
            onClick={() => editor?.zoomToFit({ animation: { duration: 220 } })}
            disabled={!editor || isBusy}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-subtle bg-bg-tertiary text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="适应画布内容"
            title="适应画布内容"
          >
            <Focus size={16} />
          </button>
          <button
            type="button"
            onClick={handleExport}
            disabled={!editor || isBusy}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-white transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-45"
            title="导出选区或整页 PNG"
          >
            <Download size={16} />
            <span className="hidden sm:inline">导出 PNG</span>
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={!editor || isBusy}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md border border-border-subtle bg-bg-tertiary text-text-muted transition hover:border-error/35 hover:bg-error/10 hover:text-error disabled:cursor-not-allowed disabled:opacity-45"
            aria-label="清空画布"
            title="清空画布"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Tldraw
          persistenceKey={CANVAS_PERSISTENCE_KEY}
          assetUrls={TLDRAW_ASSET_URLS}
          shapeUtils={CANVAS_SHAPE_UTILS}
          autoFocus
          colorScheme="dark"
          locale="zh-cn"
          licenseKey={TLDRAW_LICENSE_KEY || undefined}
          onMount={(mountedEditor) => {
            mountedEditor.setStyleForNextShapes(DefaultColorStyle, "red", { ephemeral: true });
            mountedEditor.setStyleForNextShapes(DefaultSizeStyle, "xl", { ephemeral: true });
            enlargeCanvasAnnotations(mountedEditor);
            setEditor(mountedEditor);
            setStatus({ type: "saved", message: "已保存到当前浏览器" });
          }}
        />

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
          <div
            className="absolute inset-0 z-[650] flex items-center justify-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setReferencePreview(null);
            }}
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
                      {referencePreview.annotationCount
                        ? `${referencePreview.annotationSource === "nearby" ? "自动关联" : "已选择"} ${referencePreview.annotationCount} 个标注`
                        : "未检测到标注"}
                    </p>
                  </div>
                </div>
                <button
                  ref={previewCloseButtonRef}
                  type="button"
                  onClick={() => setReferencePreview(null)}
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
                        src={referencePreview.cleanUrl}
                        alt="提交给模型的干净原图"
                        className="max-h-[52vh] w-full object-contain"
                      />
                    </div>
                    <figcaption className="mt-2 flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-text-secondary">图 1 · 干净原图</span>
                      <span className="tabular-nums text-text-muted">{formatBytes(referencePreview.cleanBytes)}</span>
                    </figcaption>
                  </figure>

                  <figure className="min-w-0">
                    <div className="flex min-h-[260px] items-center justify-center overflow-hidden rounded-md border border-border-subtle bg-bg-primary">
                      {referencePreview.annotationUrl ? (
                        <img
                          src={referencePreview.annotationUrl}
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
                        {referencePreview.annotationUrl ? formatBytes(referencePreview.annotationBytes) : "未生成"}
                      </span>
                    </figcaption>
                  </figure>
                </div>

                {referencePreview.annotationTexts.length > 0 && (
                  <div className="mt-5 border-t border-border-subtle pt-4">
                    <p className="text-xs font-medium text-mint">模型将同时收到以下文字要求</p>
                    <ol className="mt-2 grid gap-2 text-sm leading-6 text-text-secondary sm:grid-cols-2">
                      {referencePreview.annotationTexts.map((text, index) => (
                        <li key={`${index}-${text}`} className="min-w-0 break-words">
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
        )}

        <div className="pointer-events-none absolute bottom-3 right-3 z-[300] flex min-h-9 items-center gap-2 rounded-md border border-border-subtle bg-bg-secondary/92 px-3 text-xs text-text-muted shadow-lg backdrop-blur">
          {statusIcon}
          <span>{status.message}</span>
        </div>
      </div>
    </section>
  );
}
