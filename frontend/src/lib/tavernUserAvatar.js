import { prepareTavernBackground } from './tavernAppearance.js';

export function normalizeTavernUserAvatar(value) {
  if (typeof value !== 'string' || value.length > 512*1024 || value && !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('用户头像格式无效，请重新上传本地图片。');
  return value;
}
export async function prepareTavernUserAvatar(file) {
  if (!file || file.size > 2*1024*1024) throw new Error('用户头像请使用2MB以内的PNG、JPG或WebP图片。');
  return normalizeTavernUserAvatar(await prepareTavernBackground(file,256));
}
