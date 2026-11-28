import { MAX_REFERENCE_IMAGES } from "./provider.js";
import { MAX_REFERENCE_FILE_BYTES, prepareReferenceImage, REFERENCE_UPLOAD_TYPES } from "./referenceImage.js";
export { MAX_REFERENCE_FILE_BYTES, REFERENCE_FILE_ACCEPT } from "./referenceImage.js";
const SUPPORTED_TYPES = new Set(REFERENCE_UPLOAD_TYPES);
const sourceKeys = new WeakMap();

// File objects change when the same local file is selected again. Metadata
// identifies repeat selections without reading every image into memory.
export function referenceFileKey(file) {
  return sourceKeys.get(file) ?? JSON.stringify([file.name, file.size, file.lastModified ?? 0, file.type]);
}

export async function prepareReferenceBatch(current, incoming, limit, signal) {
  const keys = new Set(current.map(referenceFileKey));
  const batch = { files: [], duplicates: 0, oversized: 0, unsupported: 0, unreadable: 0, overflow: 0 };
  // Decode serially so multiple camera photos don't occupy memory together.
  for (const file of incoming) {
    if (signal?.aborted) break;
    const key = referenceFileKey(file);
    if (keys.has(key)) { batch.duplicates++; continue; }
    if (current.length + batch.files.length >= limit) { batch.overflow++; continue; }
    try {
      const normalized = await prepareReferenceImage(file, { signal });
      sourceKeys.set(normalized, key);
      batch.files.push(normalized);
      keys.add(key);
    } catch (error) {
      if (error.code === "REFERENCE_IMAGE_TOO_LARGE") batch.oversized++;
      else if (error.code === "REFERENCE_IMAGE_UNSUPPORTED") batch.unsupported++;
      else batch.unreadable++;
    }
  }
  return batch;
}

export function appendReferenceFiles(current, incoming, limit = MAX_REFERENCE_IMAGES) {
  const files = [...current], keys = new Set(current.map(referenceFileKey));
  const result = { files, added: 0, duplicates: 0, oversized: 0, unsupported: 0, overflow: 0 };
  for (const file of incoming) {
    if (!SUPPORTED_TYPES.has(String(file.type || "").toLowerCase())) { result.unsupported++; continue; }
    if (file.size > MAX_REFERENCE_FILE_BYTES) { result.oversized++; continue; }
    const key = referenceFileKey(file);
    if (keys.has(key)) { result.duplicates++; continue; }
    if (files.length >= limit) { result.overflow++; continue; }
    files.push(file); keys.add(key); result.added++;
  }
  return result;
}

// Only explicit, valid @图N references are affected. Ordinary prose and
// out-of-range references remain untouched. A null index clears all references.
export function removeReferenceMentions(prompt, removedIndex, previousCount) {
  return prompt.replace(/@图([1-9]\d*)/g, (mention, digits) => {
    const number = Number(digits);
    if (number > previousCount) return mention;
    if (removedIndex === null || number === removedIndex + 1) return "";
    return number > removedIndex + 1 ? `@图${number - 1}` : mention;
  });
}
