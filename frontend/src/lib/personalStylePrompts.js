import { preparePersonalImage } from './personalMaterials.js';

const DB = 'posterflow-ai-personal-style-prompts';
const MAX_TOTAL = 100 * 1024 * 1024;
const request = query => new Promise((resolve, reject) => {
  query.onsuccess = () => resolve(query.result);
  query.onerror = () => reject(query.error);
});

async function access(owner, mode, callback) {
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('请刷新页面后重试。');
  const query = indexedDB.open(DB, 1);
  query.onupgradeneeded = () => query.result.createObjectStore('styles', { keyPath: 'id' }).createIndex('owner', 'owner');
  const db = await request(query);
  const tx = db.transaction('styles', mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('保存没有完成，请重试。'));
    tx.onerror = () => reject(tx.error);
  });
  done.catch(() => {});
  try {
    const result = await callback(tx.objectStore('styles'));
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* Transaction already finished. */ }
    throw new Error(error?.name === 'QuotaExceededError' ? '浏览器存储空间不足，请删除部分个人素材后重试。' : error?.message || '个人风格读取失败，请重试。');
  } finally {
    db.close();
  }
}

export async function personalStylePrompts(owner) {
  return access(owner, 'readonly', async store => (await request(store.index('owner').getAll(owner))).sort((a, b) => a.createdAt - b.createdAt));
}

export async function savePersonalStylePrompt(owner, draft, file) {
  const name = String(draft.name || '').trim(), prompt = String(draft.prompt || '').trim();
  if (!name || name.length > 80) throw new Error('风格名称请填写 1–80 个字符。');
  if (!prompt || prompt.length > 6000) throw new Error('提示词请填写 1–6000 个字符。');
  if (draft.id && !/^personal-style-[a-f0-9-]+$/.test(draft.id)) throw new Error('只能修改自己的风格。');
  const prepared = file ? await preparePersonalImage(file) : undefined;
  return access(owner, 'readwrite', async store => {
    const previous = draft.id ? await request(store.get(draft.id)) : null;
    if (draft.id && (!previous || previous.owner !== owner)) throw new Error('没有找到当前账户的风格。');
    const existing = await request(store.index('owner').getAll(owner));
    if (!previous && existing.length >= 100) throw new Error('最多保留 100 个个人风格，请先删除部分条目。');
    if (existing.some(style => style.id !== draft.id && style.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('已有同名个人风格，请换一个名称。');
    const image = prepared || previous?.image || null;
    if (existing.filter(style => style.id !== draft.id).reduce((total, style) => total + (style.image?.bytes || 0), 0) + (image?.bytes || 0) > MAX_TOTAL) throw new Error('个人风格示例图最多共 100 MB，请先删除部分条目。');
    const style = {
      id: previous?.id || 'personal-style-' + crypto.randomUUID(), owner, name, prompt,
      requiresReference: Boolean(draft.requiresReference), image,
      createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    await request(store.put(style));
    return style;
  });
}

export async function deletePersonalStylePrompt(owner, id) {
  if (!/^personal-style-[a-f0-9-]+$/.test(id)) throw new Error('内置风格不能删除。');
  return access(owner, 'readwrite', async store => {
    const style = await request(store.get(id));
    if (!style || style.owner !== owner) throw new Error('没有找到当前账户的风格。');
    await request(store.delete(id));
  });
}
