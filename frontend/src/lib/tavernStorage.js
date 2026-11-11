import { normalizeTavernAppearance, normalizeTavernBackgrounds } from './tavernAppearance.js';
import { normalizeTavernUserAvatar } from './tavernUserAvatar.js';
import { normalizeTavernImageTemplates } from './tavernImageTemplates.js';
import { BUILTIN_CHARACTERS, RETIRED_TAVERN_CHARACTERS, DEFAULT_TAVERN_PERSONA, DEFAULT_TAVERN_MEMORY, DEFAULT_TAVERN_LORE_ENTRIES, TAVERN_CONTEXT_CHARS, isValidTavernContextChars, normalizeCharacter, normalizeLoreEntries, tavernStateBytes } from './tavern.js';
import { normalizeTavernUsageRecords } from './tavernUsage.js';
import { normalizeTavernMessage, validateTavernMessageIds } from './tavernConversation.js';

const DB_NAME = 'posterflow-ai-tavern';
const STORE = 'owners';
const MAX_BYTES = 20 * 1024 * 1024;
const builtinIds = new Set([...BUILTIN_CHARACTERS, ...RETIRED_TAVERN_CHARACTERS].map(character => character.id));
const blank = () => ({ characters: [], sessions: [], favorites: [] });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasControlCharacters = value => Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)));

function safeText(value, maximum, label, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > maximum || hasControlCharacters(value)) throw new Error(`${label}格式无效或内容过长。`);
  return value;
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('对话编号无效。');
  return value;
}

function time(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('对话时间格式无效。');
  return value;
}

function unique(items, label) {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`${label}编号重复，请重新打开。`);
  return items;
}

function summary(value) {
  if (value === null || value === undefined) return null;
  if (!plain(value)) throw new Error('自动记忆格式无效。');
  const content = safeText(value.text, 6000, '自动记忆');
  if (!content.trim()) throw new Error('自动记忆不能为空。');
  return { text: content, throughMessageId: identifier(value.throughMessageId), createdAt: time(value.createdAt) };
}

// Whitelist every persisted field, including nested messages; credentials/config are never stored.
function normalizeState(state, allowMigrationGrowth = false) {
  if (!plain(state) || !Array.isArray(state.characters) || !Array.isArray(state.sessions) || !Array.isArray(state.favorites)) throw new Error('酒馆本地数据格式无效。');
  if (state.characters.length > 30) throw new Error('最多保存 30 个个人角色，请先删除部分角色。');
  if (state.sessions.length > 30) throw new Error('最多保存 30 个对话，请先删除部分对话。');
  if (state.favorites.length > 34) throw new Error('收藏数量超过限制。');
  const characters = unique(state.characters.map(character => {
    const normalized = normalizeCharacter(character);
    if (builtinIds.has(normalized.id)) throw new Error('内置角色请另存为个人角色。');
    return normalized;
  }), '角色');
  const known = new Map([...BUILTIN_CHARACTERS, ...RETIRED_TAVERN_CHARACTERS, ...characters].map(character => [character.id, character]));
  const sessions = unique(state.sessions.map(session => {
    if (!plain(session) || !Array.isArray(session.messages)) throw new Error('对话数据格式无效。');
    if (session.messages.length > 200) throw new Error('每个对话最多保留 200 条消息，请开启新对话。');
    const characterId = identifier(session.characterId);
    if (!known.has(characterId)) throw new Error('对话所用角色不存在，请先删除关联对话。');
    if (session.personaPresetVersion !== undefined && session.personaPresetVersion !== 1) throw new Error('用户人设预设版本无效，请更新页面后重试。');
    if (session.contextPresetVersion !== undefined && session.contextPresetVersion !== 1) throw new Error('剧情记忆与世界书预设版本无效，请更新页面后重试。');
    const persona = safeText(session.persona, 3000, '用户人设');
    const memory = safeText(session.memory, 6000, '对话摘要');
    const loreEntries = normalizeLoreEntries(session.loreEntries ?? []);
    const useContextDefaults = session.contextPresetVersion === undefined && characterId === 'tavern-lanxing';
    const usageRecords = normalizeTavernUsageRecords(session.usageRecords);
    const legacyReplyCount = session.legacyReplyCount === undefined
      ? session.usageRecords === undefined ? session.messages.filter((message, index) => index !== 0 && message?.role === 'assistant').length : 0
      : session.legacyReplyCount;
    if (!Number.isSafeInteger(legacyReplyCount) || legacyReplyCount < 0) throw new Error('历史未统计回复数量无效。');
    const contextChars = session.contextChars === undefined ? TAVERN_CONTEXT_CHARS : session.contextChars;
    if (!isValidTavernContextChars(contextChars)) throw new Error('上下文长度选项无效。');
    const autoMemory = session.autoMemory === undefined ? false : session.autoMemory;
    if (typeof autoMemory !== 'boolean') throw new Error('自动记忆开关无效。');
    const summaryHistory = session.summaryHistory === undefined ? [] : session.summaryHistory;
    if (!Array.isArray(summaryHistory) || summaryHistory.length > 5) throw new Error('自动记忆最多保留 5 个历史版本。');
    if (session.sourceSessionId !== undefined) identifier(session.sourceSessionId);
    return {
      id: identifier(session.id), characterId,
      title: safeText(session.title, 160, '对话标题', '新对话'),
      ...(session.pinned === true ? { pinned: true } : {}),
      ...(session.titleEdited === true ? { titleEdited: true } : {}),
      createdAt: time(session.createdAt), updatedAt: time(session.updatedAt),
      persona: session.personaPresetVersion === undefined && !persona.trim() ? DEFAULT_TAVERN_PERSONA : persona,
      personaPresetVersion: 1,
      memory: useContextDefaults && !memory.trim() ? DEFAULT_TAVERN_MEMORY : memory,
      loreEntries: useContextDefaults && loreEntries.length === 0 ? normalizeLoreEntries(DEFAULT_TAVERN_LORE_ENTRIES) : loreEntries,
      contextPresetVersion: 1,
      scenario: safeText(session.scenario, 3000, '故事起点', known.get(characterId).scenario),
      contextChars, autoMemory, summary: summary(session.summary), summaryHistory: summaryHistory.map(item => {
        if (item === undefined) throw new Error('自动记忆历史版本格式无效。');
        return summary(item);
      }),
      ...(session.sourceSessionId !== undefined ? { sourceSessionId: session.sourceSessionId } : {}),
      usageRecords, legacyReplyCount,
      messages: validateTavernMessageIds(session.messages.map(normalizeTavernMessage)),
    };
  }), '对话');
  const favorites = [...new Set(state.favorites.map(identifier))].filter(value => known.has(value));
  let appearance = state.appearance === undefined ? undefined : normalizeTavernAppearance(state.appearance);
  let backgrounds = state.backgrounds === undefined ? undefined : normalizeTavernBackgrounds(state.backgrounds);
  const migratingBackground = appearance?.preset === 'image' && backgrounds === undefined;
  if (migratingBackground) {
    backgrounds = [{ id: 'legacy-background', name: '原聊天背景', image: appearance.image, source: 'local', createdAt: 0 }];
    appearance = { ...appearance, preset: 'library', image: '', backgroundId: 'legacy-background' };
  }
  if (appearance?.preset === 'library' && !backgrounds?.some(item => item.id === appearance.backgroundId)) throw new Error('所选背景不存在，请重新选择。');
  const normalized = { characters, sessions, favorites, ...(appearance ? { appearance } : {}), ...(backgrounds ? { backgrounds } : {}),
    ...(state.userAvatar === undefined ? {} : { userAvatar: normalizeTavernUserAvatar(state.userAvatar) }),
    ...(state.imageTemplates === undefined ? {} : { imageTemplates: normalizeTavernImageTemplates(state.imageTemplates) }) };
  if (tavernStateBytes(normalized) > MAX_BYTES) {
    // Only loading an originally compliant legacy record may cross the quota as
    // known migrations add fields. Editing and saving must still fit the quota.
    const pendingMigration = state.sessions.some(session => ['personaPresetVersion', 'contextPresetVersion', 'scenario', 'usageRecords', 'legacyReplyCount', 'contextChars', 'autoMemory', 'summary', 'summaryHistory']
      .some(field => session[field] === undefined) || session.usageRecords?.some(record => record.kind === undefined))
      || migratingBackground || state.characters.some(character => ['creatorNotes', 'creator', 'characterVersion', 'systemPrompt',
        'postHistoryInstructions', 'alternateGreetings', 'depthPrompt'].some(field => character[field] === undefined));
    if (!allowMigrationGrowth || !pendingMigration || tavernStateBytes(state) > MAX_BYTES) {
      throw new Error('酒馆本地资料最多 20 MB，请删除部分头像或对话。');
    }
  }
  return normalized;
}

export function normalizeTavernState(state) { return normalizeState(state); }

function validateOwner(owner) {
  if (typeof owner !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner)) throw new Error('账户信息无效，请刷新后重试。');
  return owner;
}

function storageError(error) {
  if (error?.name === 'QuotaExceededError') return new Error('浏览器存储空间不足，请删除部分酒馆资料后重试。');
  return new Error('酒馆本地存储暂时不可用，请允许浏览器保存网站数据后重试。');
}

async function openStore() {
  if (!globalThis.indexedDB) throw storageError();
  return new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch (error) { reject(storageError(error)); return; }
    let blocked = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(storageError(request.error));
    request.onblocked = () => { blocked = true; reject(new Error('请关闭其他酒馆页面后重新打开。')); };
  });
}

async function access(owner, mode, value) {
  const key = validateOwner(owner);
  const db = await openStore();
  try {
    return await new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const query = mode === 'readonly' ? store.get(key) : store.put(value, key);
      query.onsuccess = () => { result = query.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(storageError(tx.error));
      tx.onerror = () => reject(storageError(tx.error));
    });
  } catch (error) {
    if (error?.message?.startsWith('浏览器') || error?.message?.startsWith('酒馆')) throw error;
    throw storageError(error);
  } finally { db.close(); }
}

export async function loadTavernState(owner) {
  const stored = await access(owner, 'readonly');
  return stored === undefined ? blank() : normalizeState(stored, true);
}

export async function saveTavernState(owner, state) {
  validateOwner(owner);
  const normalized = normalizeTavernState(state);
  await access(owner, 'readwrite', normalized);
  return normalized;
}
