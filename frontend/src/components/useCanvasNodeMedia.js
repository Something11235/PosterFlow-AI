import { useEffect, useState } from "react";
import { getCanvasAsset } from "../lib/creationCanvasProject";
import { prepareReferenceImage, referenceImageType } from "../lib/referenceImage";

export default function useCanvasNodeMedia(owner, projectId, node) {
  const asset = node.run ? node.run.assetId : node.assetId;
  const remote = node.run?.url || node.url || "";
  const isReferenceImage = node.type === "reference" && (node.assetKind || "image") === "image";
  const [local, setLocal] = useState(null);
  useEffect(() => {
    if (!asset) return;
    let disposed = false;
    let url;
    const controller = new AbortController();
    getCanvasAsset(owner, projectId, asset).then(async blob => {
      if (!blob || disposed) return;
      if (isReferenceImage) {
        const type = await referenceImageType(blob);
        if (disposed) return;
        // Preview incoming HEIC photos even when only the video node accepts their original size.
        if (type === "image/heif") blob = await prepareReferenceImage(blob, { maxBytes: 30 * 1024 * 1024, signal: controller.signal });
        else if (type && type !== blob.type) blob = blob.slice(0, blob.size, type);
      }
      if (disposed) return;
      url = URL.createObjectURL(blob);
      setLocal({ asset, url });
    }).catch(() => {});
    return () => { disposed = true; controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [asset, owner, projectId, isReferenceImage]);
  if (asset && local?.asset === asset) return local.url;
  return remote.startsWith("https://") ? remote : "";
}
