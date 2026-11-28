export const MAX_REFERENCE_FILE_BYTES = 16 * 1024 * 1024;
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/heif": "heif" };
export const REFERENCE_UPLOAD_TYPES = Object.keys(extensions).filter(type => type !== "image/heif");
export const REFERENCE_FILE_ACCEPT = [...REFERENCE_UPLOAD_TYPES, "image/heic", "image/heif", ".png", ".jpeg", ".jpg", ".webp", ".gif", ".heic", ".heif"].join(",");

function error(code, message) { return Object.assign(new Error(message), { code }); }

export async function referenceImageType(blob) {
  const b = new Uint8Array(await blob.slice(0, 256).arrayBuffer());
  const word = offset => String.fromCharCode(...b.subarray(offset, offset + 4));
  if ([137,80,78,71,13,10,26,10].every((n, i) => b[i] === n)) return "image/png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(String.fromCharCode(...b.subarray(0, 6)))) return "image/gif";
  if (word(0) === "RIFF" && word(8) === "WEBP") return "image/webp";
  if (word(4) === "ftyp" && b.length >= 16) {
    const size = new DataView(b.buffer).getUint32(0);
    const brands = [word(8)];
    for (let i = 16; i + 4 <= Math.min(b.length, size); i += 4) brands.push(word(i));
    // AVIF also advertises the generic HEIF brand mif1.
    if (brands.some(brand => brand === "avif" || brand === "avis")) return "";
    if (brands.some(brand => /^(hei[cxsm]|hev[cxms]|mif1|msf1)$/.test(brand))) return "image/heif";
  }
  return "";
}

export function referenceImageName(name, type) {
  const ext = extensions[type];
  if (!name) return `reference.${ext}`;
  const suffix = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  if (suffix === ext || type === "image/jpeg" && suffix === "jpeg" || type === "image/heif" && suffix === "heic") return name;
  return (name.replace(/\.[^.]+$/, "") || "reference") + "." + ext;
}

export async function prepareReferenceImage(file, { maxBytes = MAX_REFERENCE_FILE_BYTES, name = file?.name, signal } = {}) {
  if (!(file instanceof Blob) || !file.size) throw error("REFERENCE_IMAGE_INVALID", "图片为空或无法读取，请重新选择。");
  const tooLarge = () => error("REFERENCE_IMAGE_TOO_LARGE", `单张参考图不能超过 ${maxBytes / 1024 / 1024} MB。`);
  if (file.size > maxBytes) throw tooLarge();
  let type = await referenceImageType(file);
  if (!type) throw error("REFERENCE_IMAGE_UNSUPPORTED", "无法识别参考图格式，请选择 PNG、JPG、WebP、GIF 或 HEIC/HEIF 图片。");
  let blob = file;
  if (type === "image/heif") {
    try {
      const { heifToJpeg } = await import("./heifToJpeg.js");
      blob = await heifToJpeg(file.slice(0, file.size, type), maxBytes, signal);
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw error("REFERENCE_IMAGE_DECODE_FAILED", "无法读取这张 HEIC/HEIF 照片，请从相册导出为 JPG 或 PNG 后重试。");
    }
    type = "image/jpeg";
    if (blob.size > maxBytes) throw tooLarge();
  }
  const filename = referenceImageName(name, type);
  if (file === blob && file.type === type && file.name === filename) return file;
  return new File([blob], filename, { type, lastModified: file.lastModified ?? 0 });
}
