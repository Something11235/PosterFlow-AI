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

const COVER = "/assets/demo-poster.png";

export const BUILTIN_PRESETS = [
  {
    id: "builtin-campaign-poster",
    category: "宣传海报",
    name: "国际化品牌主视觉",
    prompt:
      "一张面向国际市场的品牌宣传主视觉，主体突出，构图有明确视觉焦点和可放置标题的留白区域。使用现代商业设计语言、克制的几何结构、真实材质和清晰层次，画面适合官网、展会和社交媒体传播。避免卡通元素、乱码文字、复杂水印和过度装饰。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-film-photo",
    category: "摄影",
    name: "胶片感生活摄影",
    prompt:
      "一张自然、真实、有叙事感的生活方式摄影作品。35mm 胶片质感，柔和自然光，细腻颗粒，真实皮肤和材质，轻微的色彩偏移与自然阴影。主体处于日常环境中，构图松弛但有秩序，避免棚拍塑料感、过度磨皮、乱码文字和水印。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-editorial-illustration",
    category: "插画",
    name: "编辑感叙事插画",
    prompt:
      "一幅适合杂志和品牌内容的编辑感叙事插画，围绕一个明确主题组织主体、前景和背景。平面构成结合细腻手绘纹理，造型简洁但有辨识度，配色克制高级，画面保留可读的留白。避免幼稚卡通感、无关人物、乱码文字和水印。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-product-3d",
    category: "3D渲染",
    name: "极简产品 3D 渲染",
    prompt:
      "一张高级产品 3D 渲染图，单一主体置于干净的建筑感场景中。使用真实的硬表面材质、精确边缘、柔和工作室光线、清晰接触阴影和可控反射。构图平衡，主体轮廓完整，适合品牌官网和产品发布页。避免多余道具、文字、水印、畸形结构和廉价塑料质感。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-pixel-art",
    category: "像素艺术",
    name: "复古像素场景",
    prompt:
      "一幅高完成度复古像素艺术场景，使用统一像素网格、有限但有层次的调色板、清晰的前中后景和有节奏的光影。主体轮廓易识别，细节服务于场景叙事，适合作品集或游戏概念展示。避免平滑矢量边缘、随机噪点、乱码文字和水印。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-logo",
    category: "Logo设计",
    name: "企业品牌标志探索",
    prompt:
      "一组专业企业品牌标志方向探索，围绕一个清晰的品牌关键词设计简洁、有辨识度、可缩放的图形符号。使用几何比例、负形关系和稳健的字标排版，展示在干净的中性背景上。避免复杂细节、仿冒现有品牌、乱码字母、水印和不可复现的摄影效果。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-product-photo",
    category: "产品展示",
    name: "电商产品目录摄影",
    prompt:
      "一张用于产品目录的高端商业摄影，完整展示产品形体、材质和关键细节。使用干净背景、柔和但有方向性的棚拍光线、真实阴影和准确色彩，主体位于画面中心并保留安全边距。避免变形、重复产品、乱码标签、品牌臆造和水印。",
    cover: COVER,
    source: "builtin",
  },
  {
    id: "builtin-line-color",
    category: "线稿上色",
    name: "建筑线稿专业上色",
    prompt:
      "将建筑线稿转化为完整的专业概念效果图，严格保留原始线稿的结构、透视和主要轮廓。加入自然光、真实材质、植被与环境层次，色彩统一且克制，适合建筑提案展示。避免改变建筑结构、增加无关物体、乱码文字和水印。",
    cover: COVER,
    source: "builtin",
  },
];

export const DEFAULT_PRESET = BUILTIN_PRESETS[0];

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
