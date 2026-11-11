export const DEFAULT_TAVERN_APPEARANCE = Object.freeze({ preset: 'none', surface: 'solid', dim: 35, image: '' });
const presets = {
  none: 'linear-gradient(#080d14,#080d14)',
  ocean: 'radial-gradient(ellipse at 80% 15%,#25445f 0%,transparent 55%),linear-gradient(160deg,#172d42,#071520 65%,#132f35)',
  stars: 'radial-gradient(1px 1px at 20% 30%,#daeaff 90%,transparent),radial-gradient(2px 2px at 70% 18%,#8db3ec 90%,transparent),radial-gradient(1px 1px at 55% 65%,#daeaff 90%,transparent),linear-gradient(145deg,#172039,#080e20)',
  warm: 'radial-gradient(ellipse at 80% 10%,#7c5237,transparent 65%),linear-gradient(160deg,#302d35,#151c29)',
};
export function normalizeTavernAppearance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('聊天外观格式无效。');
  const { preset = 'none', surface = 'solid', dim = 35, image = '' } = value;
  if (![...Object.keys(presets), 'image'].includes(preset) || !['glass', 'solid', 'none'].includes(surface)
      || !Number.isInteger(dim) || dim < 0 || dim > 80 || typeof image !== 'string' || image.length > 2 * 1024 * 1024
      || image && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)
      || preset === 'image' && !image) throw new Error('请选择有效背景、文字托底样式与0–80的压暗程度。');
  return { preset, surface, dim, image: preset === 'image' ? image : '' };
}
export function tavernBackgroundStyle(value = DEFAULT_TAVERN_APPEARANCE) {
  const a = normalizeTavernAppearance(value);
  return { backgroundImage: `linear-gradient(rgb(0 0 0 / ${a.dim / 100}),rgb(0 0 0 / ${a.dim / 100})),${a.preset === 'image' ? `url("${a.image}")` : presets[a.preset]}` };
}
export async function prepareTavernBackground(file) {
  if (!file || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || !file.size || file.size > 12 * 1024 * 1024) throw new Error('请选择12MB以内的PNG、JPG或WebP图片。');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000) throw new Error('背景图片尺寸过大，请缩小后再选择。');
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d'); if (!context) throw new Error('浏览器无法处理背景图片。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.82);
    if (!image.startsWith('data:image/jpeg;base64,') || image.length > 2 * 1024 * 1024) throw new Error('背景处理后仍过大，请换一张较小的图片。');
    return image;
  } finally { bitmap.close(); }
}
