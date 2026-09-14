export const PRESET_CATEGORIES = [
  "全部",
  "宣传海报",
  "摄影",
  "插画",
  "3D渲染",
  "像素艺术",
  "Logo设计",
  "产品展示",
  "线稿上色",
];

export const BUILTIN_PRESETS = [];
export const DEFAULT_PRESET = null;
const DB_NAME = "posterflow-ai-presets";
const STORE_NAME = "custom-presets";

function openPresetDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function listCustomPresets() {
  try {
    const database = await openPresetDatabase();
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

export async function saveCustomPreset(preset) {
  const database = await openPresetDatabase();
  return await new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(preset);
    request.onsuccess = () => resolve(preset);
    request.onerror = () => reject(request.error);
  });
}

export async function removeCustomPreset(id) {
  const database = await openPresetDatabase();
  return await new Promise((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
