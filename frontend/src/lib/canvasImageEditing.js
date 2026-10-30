import { apimartImageModel, IMAGE_MODEL_OPTIONS, MAX_REFERENCE_IMAGES } from "./provider.js";

export function canvasEditCapability(model) {
  if (model === "grok-imagine-2.0-ext") return { referenceLimit: 1, mask: false, kind: "region" };
  const spec = apimartImageModel(model);
  const known = IMAGE_MODEL_OPTIONS.some(option => option.value === model);
  return { referenceLimit: spec?.maxReferences ?? MAX_REFERENCE_IMAGES,
    mask: known && !spec, kind: spec?.maxReferences === 0 ? "text" : spec ? "reference" : known ? "mask" : "custom" };
}

export function canvasReferenceError(model, imageCount, annotationCount, objects = []) {
  const { referenceLimit, kind } = canvasEditCapability(model);
  if (kind === "region") {
    if (imageCount !== 1) return "选区编辑每次只支持一张原图，请仅选择主图。";
    if (objects.some(object => object.posterflowType === "annotation-brush")) return "此模型当前支持矩形与圆形选区，请移除画笔标注，或切换 GPT 图片模型。";
    if (!objects.some(object => object.posterflowType === "annotation-shape")) return "请先用矩形框或圆形框标出要修改的区域。";
    return "";
  }
  if (!referenceLimit) return "当前模型仅支持画布内文字生图，本站尚未接入它的选区编辑功能。";
  if (imageCount > referenceLimit) return `当前模型最多支持 ${referenceLimit} 张参考图，请减少所选图片。`;
  if (annotationCount && imageCount >= referenceLimit) return `标注说明图需要占用 1 个参考图名额，请将原图与素材减少到 ${referenceLimit - 1} 张，或移除标注。`;
  return "";
}

export function canvasSelectionRegions(target, annotations) {
  const bounds = target.getBoundingRect();
  const shapes = annotations.filter(object => object.posterflowType === "annotation-shape");
  if (shapes.length > 16) throw new Error("每次最多编辑 16 个选区，请减少框选数量。");
  const regions = shapes.map(object => {
    const matrix = object.calcTransformMatrix();
    const points = object.posterflowMeta?.shape === "ellipse"
      ? Array.from({length:48}, (_, index) => [Math.cos(index * Math.PI / 24) * object.width / 2, Math.sin(index * Math.PI / 24) * object.height / 2])
      : [[-object.width/2,-object.height/2],[object.width/2,-object.height/2],[object.width/2,object.height/2],[-object.width/2,object.height/2]];
    let polygon = points.map(([x,y]) => [(matrix[0]*x+matrix[2]*y+matrix[4]-bounds.left)/bounds.width, (matrix[1]*x+matrix[3]*y+matrix[5]-bounds.top)/bounds.height]);
    // Clip transformed convex rectangles/ellipses to the actual exported image.
    for (const [axis, edge, direction] of [[0,0,1],[0,1,-1],[1,0,1],[1,1,-1]]) {
      const next=[];
      for (let index=0;index<polygon.length;index++) {
        const a=polygon[index], b=polygon[(index+1)%polygon.length];
        const insideA=(a[axis]-edge)*direction>=0, insideB=(b[axis]-edge)*direction>=0;
        if (insideA) next.push(a);
        if (insideA!==insideB) { const fraction=(edge-a[axis])/(b[axis]-a[axis]); next.push(a.map((value,i)=>i===axis?edge:value+(b[i]-value)*fraction)); }
      }
      polygon=next;
    }
    polygon=polygon.filter((point,index)=>!index || Math.hypot(point[0]-polygon[index-1][0],point[1]-polygon[index-1][1])>1e-8);
    if (polygon.length>1 && Math.hypot(polygon[0][0]-polygon.at(-1)[0],polygon[0][1]-polygon.at(-1)[1])<1e-8) polygon.pop();
    const area=Math.abs(polygon.reduce((sum,p,index)=>sum+p[0]*polygon[(index+1)%polygon.length][1]-p[1]*polygon[(index+1)%polygon.length][0],0));
    return polygon.length>=3 && area>1e-8 ? {outer:{points:polygon.flat()}} : null;
  }).filter(Boolean);
  if (!regions.length) throw new Error("选区未覆盖主图，请将矩形框或圆形框移到图片内。");
  return regions;
}

export function canvasGenerationSize(model, width, height, frameRatioKey) {
  if (apimartImageModel(model)) {
    // Reference editing follows the source aspect ratio, including arbitrary
    // imported image dimensions. Never derive a ratio from rounded pixels.
    if (!frameRatioKey) return { size: "" };
    return { size: frameRatioKey === "square" ? "square_1_1" : frameRatioKey };
  }
  if (frameRatioKey) return { size: "custom", custom_width: width, custom_height: height };
  const ratio = Math.max(1, width) / Math.max(1, height);
  return { size: "custom", custom_width: ratio >= 1 ? Math.min(2048, Math.max(256, Math.round(1024 * ratio / 16) * 16)) : 1024,
    custom_height: ratio >= 1 ? 1024 : Math.min(2048, Math.max(256, Math.round(1024 / ratio / 16) * 16)) };
}

export function canvasReferencePayload(referencePaths, maskPath) {
  // Cleanup owns both kinds of upload; the image list must never contain mask.
  return { reference_storage_paths: [...referencePaths], ...(maskPath ? { mask_storage_path: maskPath } : {}) };
}

export function isMaskAnnotation(object) {
  return object?.posterflowType === "annotation-shape" || object?.posterflowType === "annotation-brush";
}

export async function exportCanvasEditMask(target, annotations, referenceBlob) {
  const selected = annotations.filter(isMaskAnnotation);
  if (!selected.length) return null;
  const bitmap = await createImageBitmap(referenceBlob);
  const mask = document.createElement("canvas");
  mask.width = bitmap.width;
  mask.height = bitmap.height;
  bitmap.close();
  const bounds = target.getBoundingRect();
  const context = mask.getContext("2d");
  if (!context) throw new Error("浏览器无法创建局部编辑蒙版。");
  context.fillStyle = "#000";
  context.fillRect(0, 0, mask.width, mask.height);
  context.globalCompositeOperation = "destination-out";
  context.scale(mask.width / bounds.width, mask.height / bounds.height);
  context.translate(-bounds.left, -bounds.top);
  for (const object of selected) {
    context.save();
    context.transform(...object.calcTransformMatrix());
    if (object.posterflowType === "annotation-brush") {
      context.translate(-object.pathOffset.x, -object.pathOffset.y);
      const path = new Path2D(object.path.map(command => command.join(" ")).join(" "));
      context.lineWidth = Number(object.strokeWidth) || 28;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke(path);
    } else if (object.posterflowMeta?.shape === "ellipse") {
      context.beginPath();
      context.ellipse(0, 0, object.width / 2, object.height / 2, 0, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillRect(-object.width / 2, -object.height / 2, object.width, object.height);
    }
    context.restore();
  }
  // Ignore shapes outside the main picture; arrows and text are instructions,
  // never implicit edit rectangles. Match the actual exported first image.
  const pixels = context.getImageData(0, 0, mask.width, mask.height).data;
  let editable = false;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 0) { editable = true; break; }
  if (!editable) return null;
  return new Promise((resolve, reject) => mask.toBlob(blob => blob ? resolve(blob) : reject(new Error("局部编辑蒙版生成失败。")), "image/png"));
}
