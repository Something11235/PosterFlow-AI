import decoderUrl from "libheif-js/libheif-wasm/libheif-bundle.js?url";

async function decodeInWorker(blob, signal) {
  // Transfer actual bytes. Some WebKit builds cannot read a cloned File/Blob
  // from a worker even when the main document can read it.
  const bytes = await blob.arrayBuffer();
  const worker = new Worker(new URL("./heifDecode.worker.js", import.meta.url));
  let timer, onAbort;
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener("abort", onAbort, { once: true });
      // On a cold mobile connection the codec download can take longer than
      // decoding the photo. Give decoding its own budget once the script loads.
      timer = setTimeout(() => reject(new Error("HEIF decoder download timed out")), 180_000);
      worker.onerror = reject;
      worker.onmessageerror = reject;
      worker.onmessage = ({ data }) => {
        if (data.phase === "decoding") {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error("HEIF decoding timed out")), 60_000);
        } else if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      worker.postMessage({ bytes, decoderUrl: new URL(decoderUrl, location.href).href }, [bytes]);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    worker.terminate();
  }
}

export async function heifToJpeg(blob, maxBytes, signal) {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    // Safari can use the device's image decoder. Other browsers load the
    // self-hosted software decoder only when they actually receive HEIC.
    const native = await new Promise(resolve => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
    if (signal?.aborted) throw signal.reason;
    const pixels = native ? null : await decodeInWorker(blob, signal);
    const width = pixels?.width ?? image.naturalWidth, height = pixels?.height ?? image.naturalHeight;
    if (!width || !height) throw new Error("Unsupported image dimensions");
    // Large iPhone photos can exceed WebKit's canvas pixel budget. Only the
    // converted copy is scaled; ordinary 12 MP photos retain their resolution.
    const scale = Math.min(1, Math.sqrt(16_000_000 / (width * height)));
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    const context = canvas.getContext("2d");
    if (native) context.drawImage(image, 0, 0, canvas.width, canvas.height);
    else {
      const data = new ImageData(pixels.data, width, height);
      if (scale === 1) context.putImageData(data, 0, 0);
      else {
        const bitmap = await createImageBitmap(data, { resizeWidth: canvas.width, resizeHeight: canvas.height });
        try { context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); }
        finally { bitmap.close(); }
      }
    }
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    let jpeg;
    for (const quality of [0.92, 0.8, 0.65]) {
      jpeg = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!jpeg?.size || jpeg.type !== "image/jpeg") throw new Error("JPEG encoding failed");
      if (jpeg.size <= maxBytes) break;
    }
    return jpeg;
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}
