import { TAVERN_CONTEXT_CHARS, TAVERN_CONTEXT_OPTIONS, TAVERN_MAX_REPLY_CHARS, normalizeLoreEntries } from './tavern.js';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const unsafeText = value => Array.from(value).some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)));
const uuid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function text(value, maximum, label) {
  if (typeof value !== 'string' || value.length > maximum || unsafeText(value)) throw new Error(`${label}格式无效或内容过长。`);
  return value;
}

function variant(value) {
  if (!plain(value) || !identifier(value.id) || !safeTime(value.createdAt)) throw new Error('回复版本编号或时间无效。');
  return { id: value.id, content: text(value.content, TAVERN_MAX_REPLY_CHARS, '回复版本'), createdAt: value.createdAt };
}

function copySummary(value) {
  if (value === null || value === undefined) return null;
  if (!plain(value) || !identifier(value.throughMessageId) || !safeTime(value.createdAt)) throw new Error('自动记忆格式无效。');
  const content = text(value.text, 6000, '自动记忆');
  if (!content.trim()) throw new Error('自动记忆不能为空。');
  return { text: content, throughMessageId: value.throughMessageId, createdAt: value.createdAt };
}

// Shared with storage so variants cannot bypass the message/credential whitelist.
export function normalizeTavernMessage(message) {
  if (!plain(message) || !['user', 'assistant'].includes(message.role)) throw new Error('对话消息角色无效。');
  if (!identifier(message.id) || !safeTime(message.createdAt)) throw new Error('对话消息编号或时间无效。');
  const result = { id: message.id, role: message.role,
    content: text(message.content, message.role === 'assistant' ? TAVERN_MAX_REPLY_CHARS : 6000, '对话消息'), createdAt: message.createdAt };
  if (message.alternatives !== undefined) {
    if (message.role !== 'assistant' || !Array.isArray(message.alternatives) || message.alternatives.length > 10) throw new Error('仅角色回复可保存版本，每条最多 10 个版本。');
    const alternatives = message.alternatives.map(variant);
    if (new Set(alternatives.map(item => item.id)).size !== alternatives.length) throw new Error('回复版本编号重复。');
    if (alternatives.length && !alternatives.some(item => item.id === result.id && item.content === result.content && item.createdAt === result.createdAt)) {
      throw new Error('当前回复与所选版本不一致。');
    }
    result.alternatives = alternatives;
  }
  return result;
}

export function validateTavernMessageIds(messages) {
  const seen = new Set();
  for (const message of messages) {
    const ownIds = new Set([message.id, ...(message.alternatives || []).map(item => item.id)]);
    for (const value of ownIds) {
      if (seen.has(value)) throw new Error('对话消息或回复版本编号重复。');
      seen.add(value);
    }
  }
  return messages;
}

export function createReplyVariant(previous, newReply) {
  const prior = normalizeTavernMessage(previous), next = normalizeTavernMessage(newReply);
  if (prior.role !== 'assistant' || next.role !== 'assistant') throw new Error('只有角色回复可以创建新版本。');
  const alternatives = prior.alternatives?.length ? prior.alternatives.map(item => ({ ...item })) : [variant(prior)];
  if (alternatives.length >= 10) throw new Error('这条回复已有 10 个版本，请保留需要的内容后开启分支。');
  if (alternatives.some(item => item.id === next.id)) throw new Error('新回复版本编号重复。');
  alternatives.push(variant(next));
  return { id: next.id, role: 'assistant', content: next.content, createdAt: next.createdAt, alternatives };
}

export function selectReplyVariant(session, messageId, variantId) {
  if (!plain(session) || !Array.isArray(session.messages)) throw new Error('对话数据格式无效。');
  const messages = validateTavernMessageIds(session.messages.map(normalizeTavernMessage));
  const index = messages.findIndex(message => message.id === messageId);
  if (index < 0 || index !== messages.length - 1 || messages[index].role !== 'assistant') throw new Error('仅能切换当前最后一条角色回复的版本。');
  const selected = messages[index].alternatives?.find(item => item.id === variantId);
  if (!selected) throw new Error('找不到这个回复版本。');
  const boundary = session.summary ? messages.findIndex(message => message.id === session.summary.throughMessageId) : -1;
  const invalidateSummary = !!session.summary && (boundary < 0 || boundary >= index);
  messages[index] = { ...messages[index], ...selected };
  const history = session.summaryHistory === undefined ? [] : session.summaryHistory;
  if (!Array.isArray(history) || history.length > 5) throw new Error('自动记忆最多保留 5 个历史版本。');
  return { messages, summary: invalidateSummary ? null : copySummary(session.summary),
    summaryHistory: invalidateSummary ? [] : history.map(copySummary) };
}

export function branchTavernSession(session, messageId, { content, now = Date.now() } = {}) {
  if (!plain(session) || !identifier(session.id) || !identifier(session.characterId) || !Array.isArray(session.messages) || !safeTime(now)) {
    throw new Error('分支来源或时间无效。');
  }
  const source = validateTavernMessageIds(session.messages.map(normalizeTavernMessage));
  const index = source.findIndex(message => message.id === messageId);
  if (index < 0) throw new Error('找不到分支起点消息。');
  const messages = source.slice(0, index + 1);
  if (content !== undefined) {
    const selected = messages[index];
    messages[index] = { id: selected.id, role: selected.role, createdAt: selected.createdAt,
      content: text(content, selected.role === 'assistant' ? TAVERN_MAX_REPLY_CHARS : 6000, '分支消息') };
  }
  const title = text(session.title ?? '新对话', 160, '对话标题');
  const contextChars = session.contextChars === undefined ? TAVERN_CONTEXT_CHARS : session.contextChars;
  const autoMemory = session.autoMemory === undefined ? false : session.autoMemory;
  if (!TAVERN_CONTEXT_OPTIONS.includes(contextChars) || typeof autoMemory !== 'boolean') throw new Error('分支上下文或记忆设置无效。');
  return { id: `session-${uuid()}`, characterId: session.characterId, title: `${title.slice(0, 155)} · 分支`,
    createdAt: now, updatedAt: now, sourceSessionId: session.id,
    persona: text(session.persona ?? '', 3000, '用户人设'), personaPresetVersion: 1,
    memory: text(session.memory ?? '', 6000, '对话摘要'), scenario: text(session.scenario ?? '', 3000, '故事起点'),
    loreEntries: normalizeLoreEntries(session.loreEntries ?? []), contextPresetVersion: 1,
    contextChars, autoMemory,
    summary: null, summaryHistory: [], messages, usageRecords: [],
    legacyReplyCount: messages.filter((message, messageIndex) => messageIndex !== 0 && message.role === 'assistant').length };
}
