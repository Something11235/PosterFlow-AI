self.onmessage = async ({ data: { bytes, decoderUrl } }) => {
  try {
    // Keep the unmodified, replaceable decoder bundle separate from site code.
    self.importScripts(decoderUrl);
    self.postMessage({ phase: "decoding" });
    const lib = self.libheif();
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(new Uint8Array(bytes));
    const image = images.find(frame => frame.is_primary()) || images[0];
    if (!image) throw new Error("Missing HEIF image");
    const width = image.get_width(), height = image.get_height();
    // Accommodate 48 MP phone photos while bounding the RGBA allocation.
    if (width <= 0 || height <= 0 || width * height > 64_000_000) throw new Error("Unsupported image dimensions");
    const pixels = await new Promise((resolve, reject) => {
      image.display({ width, height, data: new Uint8ClampedArray(width * height * 4) }, decoded => {
        if (decoded) resolve(decoded.data);
        else reject(new Error("HEIF decode failed"));
      });
    });
    self.postMessage({ width, height, data: pixels }, [pixels.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message || "HEIF decode failed" });
  }
  // The caller terminates this single-use worker, freeing the entire WASM heap.
};
