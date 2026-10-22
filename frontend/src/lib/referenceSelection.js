import { MAX_REFERENCE_IMAGES } from "./provider.js";

export const MAX_REFERENCE_FILE_BYTES = 16 * 1024 * 1024;
export const REFERENCE_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const SUPPORTED_TYPES = new Set(REFERENCE_FILE_ACCEPT.split(","));

// File objects change when the same local file is selected again. Metadata
// identifies repeat selections without reading every image into memory.
export function referenceFileKey(file) {
  return JSON.stringify([file.name, file.size, file.lastModified ?? 0, file.type]);
}

export function appendReferenceFiles(current, incoming) {
  const files = [...current], keys = new Set(current.map(referenceFileKey));
  const result = { files, added: 0, duplicates: 0, oversized: 0, unsupported: 0, overflow: 0 };
  for (const file of incoming) {
    if (!SUPPORTED_TYPES.has(String(file.type || "").toLowerCase())) { result.unsupported++; continue; }
    if (file.size > MAX_REFERENCE_FILE_BYTES) { result.oversized++; continue; }
    const key = referenceFileKey(file);
    if (keys.has(key)) { result.duplicates++; continue; }
    if (files.length >= MAX_REFERENCE_IMAGES) { result.overflow++; continue; }
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
