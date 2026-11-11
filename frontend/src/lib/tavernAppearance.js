export const DEFAULT_TAVERN_APPEARANCE = Object.freeze({ preset: 'none', surface: 'solid', dim: 35, image: '' });
export const TAVERN_BACKGROUND_LIMIT = 20;
export const TAVERN_BACKGROUND_FITS = Object.freeze([
  { id:'classic', name:'经典', note:'保持比例铺满，从左上方开始显示。', size:'cover', position:'left top' },
  { id:'cover', name:'填充', note:'保持比例居中铺满，边缘可能被裁切。', size:'cover', position:'center' },
  { id:'contain', name:'不变换', note:'保持比例完整显示整张图片，周围可能留空。', size:'contain', position:'center' },
  { id:'stretch', name:'拉伸', note:'铺满宽高，图片比例可能发生变化。', size:'100% 100%', position:'center' },
  { id:'center', name:'居中', note:'按背景库保存的图片尺寸居中，不缩放。', size:'auto', position:'center' },
].map(item=>Object.freeze(item)));
const localImage = image => typeof image === 'string' && image.length <= 2 * 1024 * 1024 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image);
const presets = {
  none: 'linear-gradient(#080d14,#080d14)',
  ocean: 'radial-gradient(ellipse at 80% 15%,#25445f 0%,transparent 55%),linear-gradient(160deg,#172d42,#071520 65%,#132f35)',
  stars: 'radial-gradient(1px 1px at 20% 30%,#daeaff 90%,transparent),radial-gradient(2px 2px at 70% 18%,#8db3ec 90%,transparent),radial-gradient(1px 1px at 55% 65%,#daeaff 90%,transparent),linear-gradient(145deg,#172039,#080e20)',
  warm: 'radial-gradient(ellipse at 80% 10%,#7c5237,transparent 65%),linear-gradient(160deg,#302d35,#151c29)',
};
export function normalizeTavernAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('聊天外观格式无效。');
  const { preset = 'none', surface = 'solid', dim = 35, image = '', backgroundId, fit } = value;
  if (![...Object.keys(presets), 'image', 'library'].includes(preset) || !['glass', 'solid', 'none'].includes(surface)
      || !Number.isInteger(dim) || dim < 0 || dim > 80 || typeof image !== 'string' || image.length > 2 * 1024 * 1024
      || image && !localImage(image) || preset === 'image' && !image
      || preset === 'library' && (typeof backgroundId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(backgroundId))
      || fit !== undefined && !TAVERN_BACKGROUND_FITS.some(item=>item.id===fit)) throw new Error('请选择有效背景、显示方式、文字托底样式与0–80的压暗程度。');
  return { preset, surface, dim, image: preset === 'image' ? image : '', ...(preset === 'library' ? { backgroundId } : {}), ...(fit===undefined?{}:{fit}) };
}
export function normalizeTavernBackgrounds(items) {
  if (!Array.isArray(items) || items.length > TAVERN_BACKGROUND_LIMIT) throw new Error('背景库最多保存20张图片，请先删除部分背景。');
  const result = items.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || Array.from(item.name).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || !localImage(item.image) || !['local','generated'].includes(item.source)
      || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0
      || item.sourceFilename !== undefined && (typeof item.sourceFilename !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(item.sourceFilename))) throw new Error('背景库图片格式无效，请重新导入。');
    return { id: item.id, name: item.name.trim(), image: item.image, source: item.source, createdAt: item.createdAt,
      ...(item.source === 'generated' && item.sourceFilename ? { sourceFilename: item.sourceFilename } : {}) };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('背景编号重复。');
  return result;
}
export function addTavernBackground(state, item) {
  const backgrounds = normalizeTavernBackgrounds(state.backgrounds || []);
  const [candidate] = normalizeTavernBackgrounds([item]);
  const existing = backgrounds.find(entry => candidate.sourceFilename && entry.sourceFilename === candidate.sourceFilename || entry.image === candidate.image);
  if (existing) return { state, background: existing };
  return { state: { ...state, backgrounds: normalizeTavernBackgrounds([candidate, ...backgrounds]) }, background: candidate };
}
export function removeTavernBackground(state, id) {
  const appearance = state.appearance?.preset === 'library' && state.appearance.backgroundId === id
    ? { ...DEFAULT_TAVERN_APPEARANCE, surface: state.appearance.surface, dim: state.appearance.dim, ...(state.appearance.fit ? {fit:state.appearance.fit} : {}) } : state.appearance;
  return { ...state, backgrounds: (state.backgrounds || []).filter(item => item.id !== id), ...(appearance ? { appearance } : {}) };
}
export function tavernBackgroundStyle(value = DEFAULT_TAVERN_APPEARANCE, backgrounds = []) {
  const a = normalizeTavernAppearance(value);
  const image = a.preset === 'library' ? backgrounds.find(item => item.id === a.backgroundId)?.image : a.image;
  const hasImage=['image','library'].includes(a.preset) && localImage(image);
  // Existing archives retain their centered cover behavior until a fit is chosen.
  const fit=TAVERN_BACKGROUND_FITS.find(item=>item.id===(a.fit || 'cover'));
  return { backgroundImage: `linear-gradient(rgb(0 0 0 / ${a.dim / 100}),rgb(0 0 0 / ${a.dim / 100})),${hasImage ? `url("${image}")` : presets[a.preset] || presets.none}`,
    backgroundSize:hasImage?`100% 100%, ${fit.size}`:'cover', backgroundPosition:hasImage?`center, ${fit.position}`:'center',backgroundRepeat:'no-repeat',backgroundColor:'#080d14' };
}
export async function prepareTavernBackground(file, maxEdge = 1600) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 12 * 1024 * 1024) throw new Error('请选择12MB以内的PNG、JPG或WebP图片。');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error('背景图片尺寸过大，请缩小后再选择。');
    const ratio = Math.min(1, Math.min(1600, Math.max(1,maxEdge)) / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法处理背景图片。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.82);
    if (!image.startsWith('data:image/jpeg;base64,') || image.length > 2 * 1024 * 1024) throw new Error('背景处理后仍过大，请换一张较小的图片。');
    return image;
  } finally { bitmap.close(); }
}
