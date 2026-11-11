import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, BookOpen, Check, ChevronRight, Copy, Download, Heart, ImagePlus, LoaderCircle, MessageCircle, MessagesSquare, MoreHorizontal, Pencil, Pin, Plus, ReceiptText, RefreshCw, Search, Send, Settings2, ShieldCheck, Sparkles, Square, Trash2, Upload, X } from 'lucide-react';
import { BUILTIN_CHARACTERS, RETIRED_TAVERN_CHARACTERS, buildTavernMessages, createTavernSession, exportCharacter, getTavernContextStatus } from '../../lib/tavern';
import TavernAppearanceDialog from './TavernAppearanceDialog';
import TavernExportActions from './TavernExportActions';
import TavernImagePromptDialog from './TavernImagePromptDialog';
import { DEFAULT_TAVERN_APPEARANCE, addTavernBackground, removeTavernBackground, prepareTavernBackground, tavernBackgroundStyle } from '../../lib/tavernAppearance';
import { buildTavernBackgroundPrompt } from '../../lib/tavernBackgroundPrompt';
import { fetchImageBlob } from '../../lib/client';
import { buildTavernAssistMessages } from '../../lib/tavernAssist';
import { applyTavernSummary, planTavernSummary, restoreTavernSummary } from '../../lib/tavernMemory';
import { branchTavernSession, createReplyVariant, selectReplyVariant } from '../../lib/tavernConversation';
import { loadTavernState, normalizeTavernState, saveTavernState } from '../../lib/tavernStorage';
import { DEFAULT_TAVERN_SETTINGS, fetchTavernConfig, requestTavernReply } from '../../lib/tavernClient';
import { CharacterEditor, TavernBranchDialog, TavernContextPanel, TavernGreetingPicker, TavernImportDialog, TavernSettings, TavernStorySettings, TavernDialog } from './TavernDialogs';
import { TavernContextMeter, TavernReplyVariants } from './TavernConversationTools';
import { TavernMessageUsage, TavernSessionUsage } from './TavernUsage';
import TavernBillingPanel from './TavernBillingPanel';
import { displayCredits } from '../../lib/credits';
import { normalizeTavernUsage } from '../../lib/tavernUsage';
import './tavern.css';

const emptyState = () => ({ characters: [], sessions: [], favorites: [] });
const timeLabel = value => new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
function downloadJson(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name.replace(/[\\/:*?"<>|]/g, '_') + '.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadOriginalPng(character) {
  if (!character.avatar?.startsWith('data:image/png;base64,')) return;
  const bytes = Uint8Array.from(atob(character.avatar.slice('data:image/png;base64,'.length)), char => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `${character.name.replace(/[\\/:*?"<>|]/g, '_')}-原图.png`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function TavernWorkspace({ active, identity = 'guest', authHeaders, onStartImage, backgroundImport, onBackgroundImportHandled, session: authSession, account, accountLoading, onLogin, onAccountRefresh }) {
  const [state, setState] = useState(emptyState);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [saveStatus, setSaveStatus] = useState('正在读取');
  const [tab, setTab] = useState('discover');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [editor, setEditor] = useState(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [exportSelection, setExportSelection] = useState(null);
  const [imagePrompt, setImagePrompt] = useState(null);
  const [billingOpen, setBillingOpen] = useState(false);
  const [settings, setSettings] = useState({ ...DEFAULT_TAVERN_SETTINGS });
  const [service, setService] = useState(null);
  const platformReady = service?.platform_configured === true && service?.pricing?.billing_enabled === true;
  const [contextOpen, setContextOpen] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [drafts, setDrafts] = useState({});
  const [notice, setNotice] = useState('');
  const [chatError, setChatError] = useState('');
  const [pending, setPending] = useState(false);
  const [pendingKind, setPendingKind] = useState('chat');
  const [assistUndo, setAssistUndo] = useState(null);
  const [greetingCharacter, setGreetingCharacter] = useState(null);
  const [branchMessage, setBranchMessage] = useState(null);
  const [pendingRequestId, setPendingRequestId] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [unsavedReply, setUnsavedReply] = useState(null);
  const controller = useRef(null), operation = useRef(false), saveQueue = useRef(Promise.resolve()), mounted = useRef(true), bottom = useRef(null), composer = useRef(null);
  const stateRef = useRef(state); stateRef.current = state;
  const importingBackground = useRef(null), backgroundCallbacks = useRef(null);
  backgroundCallbacks.current = { authHeaders, onBackgroundImportHandled, addBackground };
  const availableCharacters = [...BUILTIN_CHARACTERS, ...state.characters];
  const characters = [...availableCharacters, ...RETIRED_TAVERN_CHARACTERS];
  const session = state.sessions.find(item => item.id === selectedId);
  const usageByMessageId = new Map((session?.usageRecords || []).filter(record => record.messageId).map(record => [record.messageId, record]));
  const character = session && characters.find(item => item.id === session.characterId);
  const featured = BUILTIN_CHARACTERS[0];
  const visibleCharacters = availableCharacters.filter(item => (tab !== 'mine' || state.characters.some(saved => saved.id === item.id)) && (tab !== 'favorites' || state.favorites.includes(item.id)) && `${item.name} ${item.subtitle} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const draft = drafts[selectedId] || '';
  const contextStatus = useMemo(() => character && session ? getTavernContextStatus(character, session, draft) : null, [character, session, draft]);
  const sortedSessions = [...state.sessions].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt);
  const visibleSessions = sortedSessions.filter(item => `${item.title} ${characters.find(person => person.id === item.characterId)?.name}`.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    loadTavernState(identity).then(value => { if (!cancelled) { setState(value); setReady(true); setSaveStatus('已保存到此浏览器'); } }).catch(error => { if (!cancelled) setStorageError(error.message); });
    return () => { cancelled = true; mounted.current = false; controller.current?.abort(); };
  }, [identity]);
  useEffect(() => {
    const request = new AbortController();
    fetchTavernConfig(request.signal).then(setService).catch(() => setService({ platform_configured: false, own_key_supported: false }));
    return () => request.abort();
  }, []);
  useEffect(() => {
    if (!ready) return;
    setSaveStatus('保存中…');
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => saveTavernState(identity, state)).then(() => { if (mounted.current && stateRef.current === state) { setSaveStatus('已保存到此浏览器'); setStorageError(''); } }).catch(error => { if (mounted.current) { setStorageError(error.message); setSaveStatus('未保存'); } });
  }, [state, identity, ready]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); } }, [notice]);
  const messageCount = session?.messages.length || 0;
  useEffect(() => { if (active && selectedId) bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [messageCount, pending, active, selectedId]);
  useEffect(() => {
    if (!ready || !backgroundImport || backgroundImport.identity !== identity || importingBackground.current === backgroundImport.id) return;
    importingBackground.current = backgroundImport.id;
    const callbacks = backgroundCallbacks.current;
    void (async () => {
      try {
        const blob = await fetchImageBlob(backgroundImport.filename, { authenticated: identity !== 'guest', headers: callbacks.authHeaders });
        if (!mounted.current) return;
        const extension = backgroundImport.filename.split('.').at(-1)?.toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[extension];
        if (!mime) throw new Error('背景库支持PNG、JPG或WebP，请切换静态图片输出或下载后自行转换。');
        const image = await prepareTavernBackground(new File([blob], backgroundImport.filename, { type: mime }));
        if (!mounted.current) return;
        await backgroundCallbacks.current.addBackground({ id: crypto.randomUUID(), name: backgroundImport.name || 'AI 生成背景', image,
          source: 'generated', sourceFilename: backgroundImport.filename, createdAt: Date.now() });
        if (mounted.current) { setNotice('生成图片已存入我的背景库，可在聊天外观中选择。'); callbacks.onBackgroundImportHandled?.(backgroundImport.id, { ok: true }); }
      } catch (error) {
        if (mounted.current) callbacks.onBackgroundImportHandled?.(backgroundImport.id, { ok: false, error: error.message });
      }
    })();
  }, [backgroundImport, ready, identity]);

  function commitState(change) {
    try {
      const next = normalizeTavernState(change(stateRef.current));
      stateRef.current = next;
      setState(next);
      return true;
    } catch (error) { setNotice(error.message); return false; }
  }
  const updateSession = (id, patch) => stateRef.current.sessions.some(item => item.id === id) && commitState(previous => ({ ...previous, sessions: previous.sessions.map(item => item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item) }));
  async function retryStorage() {
    if (!ready) {
      try { const value = await loadTavernState(identity); if (mounted.current) { setState(value); setReady(true); setStorageError(''); } } catch (error) { setStorageError(error.message); }
      return;
    }
    const snapshot = stateRef.current;
    setSaveStatus('保存中…');
    saveQueue.current = saveQueue.current.catch(() => {}).then(() => saveTavernState(identity, snapshot)).then(() => {
      if (mounted.current && stateRef.current === snapshot) { setStorageError(''); setSaveStatus('已保存到此浏览器'); }
    }).catch(error => { if (mounted.current && stateRef.current === snapshot) { setStorageError(error.message); setSaveStatus('未保存'); } });
    await saveQueue.current;
  }
  function startChat(person, greetingIndex) {
    if (operation.current || pending) { setNotice('请等待当前回复完成，或先停止等待。'); return; }
    if (!ready || storageError) return;
    if (state.sessions.length >= 30) { setNotice('最多保存 30 段对话，请先导出并删除不再需要的对话。'); return; }
    if (greetingIndex === undefined && person.alternateGreetings?.some(value => value.trim())) { setGreetingCharacter(person); return; }
    const next = createTavernSession(person, { greetingIndex: greetingIndex ?? -1 });
    setGreetingCharacter(null);
    if (commitState(previous => ({ ...previous, sessions: [next, ...previous.sessions] }))) { setSelectedId(next.id); setContextOpen(false); setChatError(''); }
  }
  function saveBranch(content) {
    if (operation.current || pending || !session || !branchMessage) throw new Error('当前无法创建分支，请稍后重试。');
    const next = branchTavernSession(session, branchMessage.id, { content });
    if (!commitState(previous => ({ ...previous, sessions: [next, ...previous.sessions] }))) throw new Error('分支未保存，请检查对话数量和本地容量。');
    setBranchMessage(null); setSelectedId(next.id); setContextOpen(false); setChatError('');
    setNotice('已创建新分支，原对话完整保留。');
  }
  function chooseReply(messageId, variantId) {
    if (operation.current || pending || !session) return;
    try { updateSession(session.id, selectReplyVariant(session, messageId, variantId)); }
    catch (error) { setChatError(error.message); }
  }
  function updateContext(patch) {
    if (operation.current || pending || !session) throw new Error('请等待当前请求完成后再修改设定。');
    if (!updateSession(session.id, patch)) throw new Error('设定未保存，请检查内容长度与本地容量。');
  }
  function saveCharacter(person) {
    if (!commitState(previous => ({ ...previous, characters: previous.characters.some(item => item.id === person.id) ? previous.characters.map(item => item.id === person.id ? person : item) : [...previous.characters, person] }))) return false;
    setEditor(undefined); setTab('mine'); setNotice('角色已保存，你可以开始新的对话。');
    return true;
  }
  function removeConfirmed() {
    if (confirmation.type === 'reply') { setUnsavedReply(null); setConfirmation(null); return; }
    if (confirmation.type === 'session') {
      if (!commitState(previous => ({ ...previous, sessions: previous.sessions.filter(item => item.id !== confirmation.id) }))) return;
      setDrafts(previous => { const next = { ...previous }; delete next[confirmation.id]; return next; });
      if (selectedId === confirmation.id) setSelectedId(null);
    } else commitState(previous => ({ ...previous, characters: previous.characters.filter(item => item.id !== confirmation.id), favorites: previous.favorites.filter(id => id !== confirmation.id), sessions: previous.sessions.filter(item => item.characterId !== confirmation.id) }));
    setConfirmation(null); setNotice('已删除。');
  }
  function canSend() {
    if (settings.billingMode === 'platform') {
      if (!platformReady) { setChatError('平台对话服务尚未开放。你可以先编辑角色，或在对话服务中使用自己的 API。'); setSettingsOpen(true); return false; }
      if (!authSession) { setChatError('请先登录账户，再使用平台积分对话。'); onLogin?.(); return false; }
      if (accountLoading) { setChatError('正在读取账户余额，请稍后发送。'); return false; }
      if (!account) { setChatError('尚未取得账户信息，请刷新余额后再试。'); void refreshBalance(); return false; }
      if (!account.email_verified) { setChatError('请先完成邮箱验证，再使用平台积分。'); return false; }
      if (account.profile?.status !== 'active') { setChatError('当前账户暂不可使用平台积分，请联系管理员。'); return false; }
    }
    if (settings.billingMode === 'own_key' && (!settings.apiKey || !settings.endpoint || !settings.model)) { setChatError('请先在对话服务中填写接口地址、API Key 和模型。'); setSettingsOpen(true); return false; }
    if (!service?.own_key_supported && settings.billingMode === 'own_key') { setChatError('当前预览未连接对话后端，配置已保留在本页；连接后端后可发送。'); return false; }
    return true;
  }
  function refreshBalance() {
    if (!mounted.current) return Promise.resolve();
    return Promise.resolve(onAccountRefresh?.()).catch(() => {});
  }
  function openBilling() {
    if (!authSession) { onLogin?.(); return; }
    setBillingOpen(true);
  }
  function reconcileBilling(request) {
    if (!commitState(previous => ({ ...previous, sessions: previous.sessions.map(item => ({ ...item, usageRecords: item.usageRecords.map(record => record.id !== request.request_id || record.billingMode !== 'platform' ? record : {
      ...record, billing: request.billing,
      outcome: request.request_status === 'completed' ? 'completed' : request.request_status === 'failed' ? 'rejected' : record.outcome,
      usage: request.usage ? normalizeTavernUsage(request.usage) : record.usage,
    }) })) }))) throw new Error('服务端账单已读取，但本地用量记录未能更新。请先导出并检查本地容量。');
  }
  function usageAfterFailure(current, usageRecord, error, notSubmitted) {
    return current.usageRecords.flatMap(record => {
      if (record.id !== usageRecord.id || record.outcome === 'completed') return [record];
      if (notSubmitted && !error.billing) return [];
      return [{ ...record, ...(error.billing ? { billing: error.billing } : {}), outcome: notSubmitted ? 'rejected' : 'unknown' }];
    });
  }
  async function persistCurrent() {
    const snapshot = stateRef.current;
    const saved = saveQueue.current.catch(() => {}).then(() => saveTavernState(identity, snapshot));
    saveQueue.current = saved;
    await saved;
  }
  async function runSummary(target, plan) {
    if (target.usageRecords.length >= 1000) { setChatError('本段对话已达到用量记录上限，请导出后开启新对话。'); return null; }
    const usageRecord = { id: crypto.randomUUID(), messageId: null, kind: 'summary', createdAt: Date.now(), model: settings.model || DEFAULT_TAVERN_SETTINGS.model, billingMode: settings.billingMode, outcome: 'unknown', usage: normalizeTavernUsage(null) };
    const request = new AbortController(); controller.current = request;
    setPending(true); setPendingKind('summary'); setPendingRequestId(usageRecord.id); setChatError('');
    let submitted = false;
    try {
      if (!updateSession(target.id, { usageRecords: [...target.usageRecords, usageRecord] })) return null;
      await persistCurrent();
      if (!mounted.current || request.signal.aborted) { const error = new Error('已取消整理，尚未发送摘要请求。'); error.submission_unknown = false; throw error; }
      submitted = true;
      const result = await requestTavernReply({ settings: { ...settings, temperature: 0.2, maxTokens: 2048 }, messages: plan.messages, signal: request.signal, authHeaders, requestId: usageRecord.id, kind: usageRecord.kind });
      if (!mounted.current) return null;
      const current = stateRef.current.sessions.find(item => item.id === target.id);
      const usageRecords = current.usageRecords.map(record => record.id === usageRecord.id ? { ...record, outcome: 'completed', usage: normalizeTavernUsage(result.usage), ...(result.billing ? { billing: result.billing } : {}) } : record);
      let summaryPatch;
      try { summaryPatch = applyTavernSummary(current, plan, result.content, Date.now()); }
      catch (error) {
        updateSession(target.id, { usageRecords, autoMemory: false });
        setUnsavedReply({ kind: 'summary', unusable: true, sessionId: target.id, patch: { usageRecords }, content: result.content });
        throw error;
      }
      const patch = { ...summaryPatch, usageRecords };
      if (!updateSession(target.id, patch)) {
        updateSession(target.id, { usageRecords, autoMemory: false });
        setUnsavedReply({ kind: 'summary', sessionId: target.id, patch, content: result.content });
        setChatError('摘要已生成，但未能保存。请先导出或清理本地容量。');
        return null;
      }
      await persistCurrent();
      setNotice('剧情摘要已更新，原聊天记录完整保留。');
      if (request.signal.aborted || !mounted.current) return null;
      return stateRef.current.sessions.find(item => item.id === target.id);
    } catch (error) {
      if (mounted.current) {
        const current = stateRef.current.sessions.find(item => item.id === target.id);
        const notSubmitted = !submitted || error.submission_unknown === false;
        updateSession(target.id, { autoMemory: false, usageRecords: usageAfterFailure(current, usageRecord, error, notSubmitted) });
        setChatError(request.signal.aborted && !notSubmitted ? '已停止等待摘要。服务商可能已处理，用量待确认；自动整理已暂停，不会自动重试。' : `${error.message} 自动整理已暂停。`);
      }
      return null;
    } finally {
      if (submitted && usageRecord.billingMode === 'platform') void refreshBalance();
      if (mounted.current) { setPending(false); setPendingRequestId(null); setPendingKind('chat'); controller.current = null; }
    }
  }
  async function summarizeNow() {
    if (operation.current || pending || !session || !ready || storageError || unsavedReply || !canSend()) return false;
    operation.current = true;
    try {
      const plan = planTavernSummary(character, session, { force: true, input: draft });
      if (!plan) { setChatError('目前没有足够的旧消息需要整理；最近 4 条消息会保留原文。'); return false; }
      return Boolean(await runSummary(session, plan));
    } catch (error) { setChatError(error.message); return false; }
    finally { operation.current = false; }
  }
  async function assistDraft() {
    if (operation.current || controller.current || pending || !session || !ready || storageError || unsavedReply || !canSend()) return;
    operation.current = true;
    const target = stateRef.current.sessions.find(item => item.id === session.id);
    const original = draft;
    let record, submitted = false;
    const request = new AbortController();
    try {
      if (target.usageRecords.length >= 1000) throw new Error('用量记录已满，请导出后开启新对话。');
      const messages = buildTavernAssistMessages(character, target, original);
      record = { id: crypto.randomUUID(), messageId: null, kind: 'assist', createdAt: Date.now(), model: settings.model || DEFAULT_TAVERN_SETTINGS.model, billingMode: settings.billingMode, outcome: 'unknown', usage: normalizeTavernUsage(null) };
      controller.current = request; setPending(true); setPendingKind('assist'); setPendingRequestId(record.id); setChatError('');
      if (!updateSession(target.id, { usageRecords: [...target.usageRecords, record] })) return;
      await persistCurrent();
      if (request.signal.aborted || !mounted.current) { const error = new Error('已取消助写，尚未提交。'); error.submission_unknown = false; throw error; }
      submitted = true;
      const result = await requestTavernReply({ settings: { ...settings, maxTokens: Math.min(settings.maxTokens || 1024, 1024) }, messages, signal: request.signal, authHeaders, requestId: record.id, kind: 'assist' });
      if (!mounted.current) return;
      const current = stateRef.current.sessions.find(item => item.id === target.id);
      const usageRecords = current.usageRecords.map(item => item.id === record.id ? { ...item, outcome: 'completed', usage: normalizeTavernUsage(result.usage), ...(result.billing ? { billing: result.billing } : {}) } : item);
      const saved = updateSession(target.id, { usageRecords });
      if (!saved || !result.content.trim() || result.content.length > 6000) {
        setUnsavedReply({ kind: 'assist', unusable: true, sessionId: target.id, patch: { usageRecords }, content: result.content });
        setChatError('助写已生成，但未能安全填入草稿。原文已保留，可复制或导出。'); return;
      }
      setDrafts(previous => ({ ...previous, [target.id]: result.content.trim() }));
      setAssistUndo({ sessionId: target.id, original, generated: result.content.trim() });
      await persistCurrent();
      setNotice('助写草稿已填入，修改后再发送；没有自动发送。');
    } catch (error) {
      if (mounted.current) {
        if (record) {
          const current = stateRef.current.sessions.find(item => item.id === target.id);
          if (current) updateSession(target.id, { usageRecords: usageAfterFailure(current, record, error, !submitted || error.submission_unknown === false) });
        }
        setChatError(request.signal.aborted && submitted ? '已停止等待助写，原草稿保留；服务商可能已处理，请查看账单，不会自动重发。' : error.message);
      }
    } finally {
      if (submitted && record?.billingMode === 'platform') void refreshBalance();
      operation.current = false;
      if (mounted.current) { controller.current = null; setPending(false); setPendingKind('chat'); setPendingRequestId(null); composer.current?.focus(); }
    }
  }
  async function send(regenerate = false) {
    if (unsavedReply) { setChatError('请先保存或导出上一次尚未保存的内容，再继续对话。'); return; }
    if (operation.current || controller.current || pending || !session || !ready || storageError || !canSend()) return;
    operation.current = true;
    try {
      let target = stateRef.current.sessions.find(item => item.id === session.id);
      const lastUserIndex = target.messages.findLastIndex(message => message.role === 'user');
      const input = regenerate ? target.messages[lastUserIndex]?.content : draft.trim();
      if (!input) return;
      if ((regenerate ? lastUserIndex : target.messages.length) >= 198) { setChatError('这段对话已达到消息上限，请导出记录后开启新对话。'); return; }
      if (regenerate && (target.messages.at(-1)?.alternatives?.length || 0) >= 10) { setChatError('这条回复已保存 10 个版本，可以从喜欢的版本创建新分支。'); return; }
      if (target.usageRecords.length >= 1000) { setChatError('本段对话已达到用量记录上限，请导出后开启新对话。'); return; }
      if (!regenerate && target.autoMemory) {
        if (target.usageRecords.some(record => record.kind === 'summary' && record.outcome === 'unknown')) {
          updateSession(target.id, { autoMemory: false });
          setChatError('上一次摘要结果尚未确认，已暂停自动整理。请检查服务商记录，确认后可手动整理或继续发送。'); return;
        }
        const plan = planTavernSummary(character, target, { input });
        if (plan && target.usageRecords.length > 998) { setChatError('剩余用量记录空间不足以同时保存摘要和回复，请导出后开启新对话。'); return; }
        if (plan) { target = await runSummary(target, plan); if (!target || !mounted.current) return; }
      }
      const previousMessages = regenerate ? target.messages.slice(0, lastUserIndex) : target.messages;
      if (previousMessages.length >= 198) { setChatError('这段对话已达到消息上限，请导出记录后开启新对话。'); return; }
      const messages = buildTavernMessages(character, { ...target, messages: previousMessages }, input);
      const nextSession = { ...target, messages: [...previousMessages, regenerate ? target.messages[lastUserIndex] : { id: crypto.randomUUID(), role: 'user', content: input, createdAt: Date.now() }], title: !target.titleEdited && target.messages.length <= 1 ? input.slice(0, 24) : target.title };
      const usageRecord = { id: crypto.randomUUID(), messageId: null, kind: 'chat', createdAt: Date.now(), model: settings.model || DEFAULT_TAVERN_SETTINGS.model, billingMode: settings.billingMode, outcome: 'unknown', usage: normalizeTavernUsage(null) };
      const request = new AbortController(); controller.current = request;
      setPending(true); setPendingKind('chat'); setPendingRequestId(usageRecord.id); setChatError(''); setLiveText('');
      const initialPatch = { usageRecords: [...target.usageRecords, usageRecord], ...(!regenerate ? { messages: nextSession.messages, title: nextSession.title } : {}) };
      if (!updateSession(target.id, initialPatch)) { controller.current = null; setPending(false); setPendingRequestId(null); return; }
      if (!regenerate) setDrafts(previous => ({ ...previous, [target.id]: '' }));
      let submitted = false;
      try {
        await persistCurrent();
        if (!mounted.current || request.signal.aborted) { const error = new Error('已停止等待，本次对话尚未发送。'); error.submission_unknown = false; throw error; }
        submitted = true;
        const result = await requestTavernReply({ settings, messages, signal: request.signal, onDelta: setLiveText, authHeaders, requestId: usageRecord.id, kind: usageRecord.kind });
        if (mounted.current) {
          const newReply = { id: crypto.randomUUID(), role: 'assistant', content: result.content, createdAt: Date.now() };
          const current = stateRef.current.sessions.find(item => item.id === target.id);
          const usageRecords = current.usageRecords.map(record => record.id === usageRecord.id ? { ...record, messageId: newReply.id, outcome: 'completed', usage: normalizeTavernUsage(result.usage), ...(result.billing ? { billing: result.billing } : {}) } : record);
          let reply;
          try { reply = regenerate ? createReplyVariant(target.messages.at(-1), newReply) : newReply; }
          catch (error) {
            updateSession(target.id, { usageRecords });
            setUnsavedReply({ unusable: true, sessionId: target.id, patch: { usageRecords }, content: result.content });
            setChatError(`回复已返回，但格式无法保存为新版本：${error.message}`);
            return;
          }
          const patch = { title: nextSession.title, messages: [...nextSession.messages, reply], usageRecords };
          if (!updateSession(target.id, patch)) {
            updateSession(target.id, { usageRecords });
            setUnsavedReply({ sessionId: target.id, patch, content: result.content });
          }
        }
      } catch (error) {
        if (mounted.current) {
          const notSubmitted = !submitted || error.submission_unknown === false;
          const current = stateRef.current.sessions.find(item => item.id === target.id);
          updateSession(target.id, { usageRecords: usageAfterFailure(current, usageRecord, error, notSubmitted), ...(notSubmitted && !regenerate ? { messages: previousMessages, title: target.title } : {}) });
          if (notSubmitted) {
            if (!regenerate) setDrafts(previous => ({ ...previous, [target.id]: input }));
          }
          setChatError(request.signal.aborted ? (notSubmitted ? '已停止等待，本次对话尚未发送。' : '已停止等待。本次请求可能已由服务商处理，用量待确认；不会自动重发。') : error.message);
        }
      } finally { if (submitted && usageRecord.billingMode === 'platform') void refreshBalance(); if (mounted.current) { setPending(false); setPendingRequestId(null); setLiveText(''); controller.current = null; composer.current?.focus(); } }
    } catch (error) { setChatError(error.message); }
    finally { operation.current = false; }
  }
  async function copy(text) { try { await navigator.clipboard.writeText(text); setNotice('已复制。'); } catch { setNotice('浏览器未允许复制，请选中文字手动复制。'); } }
  function illustrate(text) {
    setImagePrompt({ type:'last', message:text });
  }
  async function saveImageTemplates(imageTemplates) {
    if (!ready || !commitState(previous => ({ ...previous, imageTemplates }))) throw new Error('模板未保存，请检查模板格式与本地容量。');
    await persistCurrent();
    if (!mounted.current) throw new Error('账户已切换，请重新打开图像模板。');
  }
  function useImagePrompt(prompt, preset) {
    if (!mounted.current || pending) throw new Error('请等待当前回复结束后再前往生图。');
    onStartImage(prompt, { target:preset.id==='background'?'tavern-background':'tavern-image', identity, size:preset.size, name:`${character.name}的故事背景`.slice(0,80) });
    setImagePrompt(null);
  }
  async function addBackground(item) {
    if (!ready || !mounted.current) throw new Error('背景库仍在读取，请稍后重试。');
    let result;
    if (!commitState(previous => { result = addTavernBackground(previous, item); return result.state; })) throw new Error('背景未保存，请检查20张背景与20MB本地容量限制。');
    await persistCurrent();
    return result.background;
  }
  async function deleteBackground(id) {
    if (!commitState(previous => removeTavernBackground(previous, id))) throw new Error('背景未能删除，请重试。');
    await persistCurrent();
  }
  async function generateBackground() {
    if (pending || !session || !character) { setNotice('请先打开一段故事，等待当前回复结束后再生成背景。'); return; }
    try {
      await persistCurrent();
      if (!mounted.current) return;
      onStartImage(buildTavernBackgroundPrompt(character, session, stateRef.current.imageTemplates), { target: 'tavern-background', identity, name: `${character.name}的故事背景`.slice(0,80) });
      setAppearanceOpen(false);
    } catch (error) { setNotice(error.message); }
  }
  function sessionActions(item) {
    return <details className="tavern-session-menu"><summary aria-label={`${item.title}的故事操作`}><MoreHorizontal size={17} /></summary><div>
      <button type="button" disabled={pending} onClick={event => { event.currentTarget.closest('details').open = false; setRenaming(item); }}><Pencil size={14} />重命名</button>
      <button type="button" disabled={pending} onClick={event => { event.currentTarget.closest('details').open = false; updateSession(item.id, { pinned: !item.pinned }); }}><Pin size={14} />{item.pinned ? '取消置顶' : '置顶'}</button>
      <button type="button" disabled={pending} onClick={event => { event.currentTarget.closest('details').open = false; setConfirmation({ type: 'session', id: item.id, name: item.title }); }}><Trash2 size={14} />删除对话</button>
    </div></details>;
  }
  const writable = ready && !pending;

  return <section className={`tavern-workspace${active ? '' : ' studio-is-hidden'}`} aria-label="AI 酒馆">
    {storageError && <div className="tavern-alert" role="alert">{storageError} <button type="button" onClick={retryStorage}>重试保存与读取</button></div>}
    {unsavedReply && <div className="tavern-alert" role="alert"><span>{unsavedReply.kind === 'summary' ? '摘要已经收到，但未能应用到剧情记忆。请先导出，刷新页面会丢失这份未保存摘要。' : '回复已经收到，但未能加入本地记录。请先导出，刷新页面会丢失这条未保存回复。'}</span><details><summary>查看未保存回复</summary><p style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{unsavedReply.content}</p></details><button type="button" onClick={() => copy(unsavedReply.content)}>复制回复</button><button type="button" onClick={() => downloadJson({ sessionId: unsavedReply.sessionId, content: unsavedReply.content, usageRecords: unsavedReply.patch.usageRecords }, '未保存的酒馆回复')}>导出回复</button><button type="button" disabled={unsavedReply.unusable === true} onClick={() => { if (updateSession(unsavedReply.sessionId, unsavedReply.patch)) setUnsavedReply(null); else setNotice('请先清理其他角色或对话，保留原对话后再重试。'); }}>清理后重试保存</button><button type="button" onClick={() => setConfirmation({ type: 'reply', name: '尚未保存的回复' })}>放弃这条回复</button></div>}
    {notice && <div className="tavern-toast" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}><X size={16} /></button></div>}
    {!session || !character ? <div className="tavern-lobby">
      <div className="tavern-page-bar"><span><MessagesSquare size={18} />AI 酒馆 <i>THE STORY LOUNGE</i></span><div className="tavern-page-actions"><button type="button" className="tavern-button" onClick={() => setAppearanceOpen(true)}><ImagePlus size={16} />背景库</button><button type="button" className="tavern-button" onClick={openBilling}><ReceiptText size={16} />平台账单</button><button type="button" className="tavern-button" onClick={() => setSettingsOpen(true)}><Settings2 size={16} />对话服务</button></div></div>
      <div className="tavern-hero">
        <div className="tavern-hero-copy"><p className="tavern-eyebrow"><span />每一次相遇，都是故事的开始</p><h1>推开门，<br />遇见另一种<span>可能。</span></h1><p className="tavern-hero-description">赋予角色性格，让想象拥有回应。<br />从一句问候开始，一起走进未写完的故事。</p><div className="tavern-hero-actions"><button type="button" className="tavern-button is-primary" onClick={() => startChat(featured)} disabled={!writable}>开启第一段故事<ArrowRight size={17} /></button><button type="button" className="tavern-text-button" onClick={() => { setEditor(null); }} disabled={!writable || state.characters.length >= 30}><Plus size={16} />创造我的角色</button></div><div className="tavern-hero-foot"><span>01 / 角色</span><span>02 / 对话</span><span>03 / 你的世界</span></div></div>
        <button type="button" className="tavern-featured" disabled={!writable} onClick={() => startChat(featured)} aria-label={`与${featured.name}开始对话`}><img src={featured.avatar} alt={featured.name} /><div className="tavern-featured-shade" /><span className="tavern-featured-tag"><Sparkles size={13} />今日相遇</span><span className="tavern-featured-copy"><small>「{featured.firstMessage.slice(0, 48)}{featured.firstMessage.length > 48 ? '…' : ''}」</small><strong>{featured.name}<ArrowUpRight size={25} /></strong><span>{featured.subtitle}</span></span></button>
      </div>
      <div className="tavern-library-heading"><div><p className="tavern-eyebrow">CHARACTERS & STORIES</p><h2>挑选一位，聊聊看。</h2></div><div className="tavern-library-actions"><button type="button" className="tavern-button" disabled={!writable || state.characters.length >= 30} onClick={() => setImportOpen(true)}><Upload size={16} />导入角色卡</button><button type="button" className="tavern-button is-primary" disabled={!writable || state.characters.length >= 30} onClick={() => setEditor(null)}><Plus size={16} />创建角色</button></div></div>
      <div className="tavern-library-toolbar"><div className="tavern-tabs" aria-label="角色分类">{[['discover', '发现角色'], ['mine', '我的角色'], ['favorites', '我的收藏'], ['recent', '最近对话']].map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setQuery(''); }}>{label}{id === 'mine' && <span>{state.characters.length}</span>}</button>)}</div><label className="tavern-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={tab === 'recent' ? '搜索对话' : '寻找名字、性格或故事…'} aria-label="搜索酒馆内容" /></label></div>
      {!ready && !storageError && <p className="tavern-loading" role="status"><LoaderCircle className="tavern-spin" size={20} />正在准备角色与故事…</p>}
      {tab !== 'recent' ? <div className="tavern-character-grid">{visibleCharacters.map((person, index) => <article key={person.id} className="tavern-character-card">
        <div className="tavern-card-art"><img src={person.avatar || '/ai-companions/claude-01.jpg'} alt={person.name} loading="lazy" /><div className="tavern-card-shade" /><span className="tavern-card-number">{String(index + 1).padStart(2, '0')} / CHARACTER</span><button type="button" className={`tavern-favorite${state.favorites.includes(person.id) ? ' is-active' : ''}`} aria-label={`${state.favorites.includes(person.id) ? '取消收藏' : '收藏'}${person.name}`} aria-pressed={state.favorites.includes(person.id)} disabled={!writable} onClick={() => commitState(previous => ({ ...previous, favorites: previous.favorites.includes(person.id) ? previous.favorites.filter(id => id !== person.id) : [...previous.favorites, person.id] }))}><Heart size={17} /></button><div className="tavern-card-name"><span>{person.subtitle}</span><h3>{person.name}</h3></div></div>
        <div className="tavern-card-body"><div className="tavern-tags">{person.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</div><p>{person.description}</p><div className="tavern-card-actions"><button type="button" disabled={!writable} onClick={() => startChat(person)}>开始对话<ArrowUpRight size={17} /></button><details className="tavern-card-menu"><summary aria-label={`${person.name}的更多操作`}><MoreHorizontal size={19} /></summary><div><button type="button" disabled={!writable || (!state.characters.some(item => item.id === person.id) && state.characters.length >= 30)} onClick={() => setEditor(state.characters.some(item => item.id === person.id) ? person : { ...person, id: crypto.randomUUID(), name: person.name + ' · 我的版本' })}><Pencil size={15} />{state.characters.some(item => item.id === person.id) ? '编辑角色' : '另存我的版本'}</button><button type="button" onClick={() => setExportSelection({ character: person })}><Download size={15} />导出角色卡 / 世界书</button>{person.avatar?.startsWith('data:image/png;base64,') && <button type="button" title="保存原始 PNG 中的全部资料，不包含导入后的编辑" onClick={() => downloadOriginalPng(person)}><Download size={15} />下载 PNG 原图</button>}{state.characters.some(item => item.id === person.id) && <button type="button" disabled={!writable || pending} onClick={() => setConfirmation({ type: 'character', id: person.id, name: person.name })}><Trash2 size={15} />删除角色</button>}</div></details></div></div>
      </article>)}</div> : <div className="tavern-recent-list">{visibleSessions.map(item => { const person = characters.find(person => person.id === item.characterId); return <div key={item.id}><button type="button" disabled={pending} onClick={() => { setSelectedId(item.id); setChatError(''); }}><img src={person?.avatar || '/ai-companions/claude-01.jpg'} alt="" /><span><strong>{item.title}</strong><small>{person?.name} · {item.messages.length} 条消息 · {timeLabel(item.updatedAt)}</small></span><ChevronRight size={18} /></button>{sessionActions(item)}</div>; })}</div>}
      {(tab === 'recent' ? !visibleSessions.length : !visibleCharacters.length) && <div className="tavern-empty"><BookOpen size={30} /><h3>{query ? '还没有找到这位角色' : tab === 'recent' ? '第一页，留给下一次相遇。' : tab === 'favorites' ? '把喜欢的角色留在这里' : '你的第一个角色，正在等你创造。'}</h3><p>{query ? '试试其他关键词，或清除搜索。' : '选择一位角色开始对话，或导入你喜欢的角色卡。'}</p><button type="button" className="tavern-button" onClick={() => { setTab('discover'); setQuery(''); }}>浏览角色<ArrowRight size={16} /></button></div>}
      <footer className="tavern-lobby-footer"><span><ShieldCheck size={15} />角色与对话仅保存在当前浏览器 · {saveStatus}</span><span>一个角色，一段尚未发生的故事。</span></footer>
    </div> : <div className={`tavern-chat-layout${contextOpen ? ' has-context' : ''}`}>
      <aside className="tavern-conversations"><button type="button" className="tavern-back" disabled={pending} onClick={() => setSelectedId(null)}><ArrowLeft size={17} />角色大厅</button><div className="tavern-current-character"><img src={character.avatar || '/ai-companions/claude-01.jpg'} alt={character.name} /><h2>{character.name}</h2><p>{character.subtitle}</p></div><button type="button" className="tavern-button" disabled={!writable || pending} onClick={() => startChat(character)}><Plus size={16} />开启新对话</button><p className="tavern-eyebrow">故事记录</p><div className="tavern-session-list">{sortedSessions.map(item => <div className="tavern-session-entry" key={item.id}><button type="button" disabled={pending} aria-current={item.id === selectedId ? 'true' : undefined} onClick={() => { setSelectedId(item.id); setChatError(''); }}><MessageCircle size={15} /><span>{item.pinned && <Pin size={11} aria-label="已置顶" />}{item.title}<small>{timeLabel(item.updatedAt)}</small></span></button>{sessionActions(item)}</div>)}</div><span className="tavern-save-label"><Check size={14} />{saveStatus}</span></aside>
      <div className="tavern-chat-column"><header className="tavern-chat-header"><button type="button" className="tavern-icon-button tavern-mobile-back" aria-label="返回角色大厅" disabled={pending} onClick={() => setSelectedId(null)}><ArrowLeft size={19} /></button><div><h1>{character.name}<span>角色对话</span></h1><p>{settings.billingMode === 'platform' ? (platformReady ? '平台积分服务' : service ? '平台服务待开放' : '读取服务状态…') : `${settings.model || '自选模型'} · 自带 API`}</p></div><button type="button" className="tavern-icon-button" title="导出设定" aria-label="导出设定" onClick={() => setExportSelection({ character, session })}><Download size={18} /></button><button type="button" className="tavern-icon-button" title="聊天外观" aria-label="聊天外观" onClick={() => setAppearanceOpen(true)}><ImagePlus size={18} /></button><button type="button" className="tavern-icon-button" title="平台账单" aria-label="平台账单" onClick={openBilling}><ReceiptText size={18} /></button><button type="button" className="tavern-icon-button" title="对话服务" aria-label="对话服务" disabled={pending} onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button><button type="button" className={`tavern-icon-button${contextOpen ? ' is-selected' : ''}`} title="世界与记忆" aria-label="世界与记忆" aria-expanded={contextOpen} onClick={() => setContextOpen(value => !value)}><BookOpen size={18} /></button></header>
        <details className="tavern-chat-information"><summary><Settings2 size={14} />对话信息<span>积分 · 用量 · 上下文</span></summary>
        {settings.billingMode === 'platform' && <div className="tavern-platform-balance"><span>平台积分 <strong>{!authSession ? '登录后可用' : accountLoading ? '读取中…' : displayCredits(account?.credits?.balance, '暂未取得')}</strong></span>{!authSession ? <button type="button" onClick={onLogin}>登录账户</button> : <button type="button" onClick={() => void refreshBalance()} disabled={accountLoading}><RefreshCw size={13} />刷新余额</button>}</div>}
        <TavernSessionUsage session={session} pendingRequestId={pendingRequestId} />
        <TavernContextMeter status={contextStatus} />
        </details>
        <div className={`tavern-message-list tv-chat-background tv-surface-${(state.appearance || DEFAULT_TAVERN_APPEARANCE).surface}`} style={tavernBackgroundStyle(state.appearance, state.backgrounds)} role="log" aria-label="对话消息" aria-live="polite"><div className="tavern-story-prologue"><div className="tavern-story-heading"><span>故事的起点</span><button type="button" className="tavern-story-edit" disabled={!writable} onClick={() => setStoryOpen(true)}><Pencil size={13} />编辑起点</button></div><p>{session.scenario?.trim() ? session.scenario : '尚未设置初始场景，可以从这里开始补充。'}</p></div>{session.messages.map((message, index) => <article key={message.id} className={`tavern-message is-${message.role}`}><div className="tavern-message-avatar">{message.role === 'assistant' ? <img src={character.avatar || '/ai-companions/claude-01.jpg'} alt="" /> : state.userAvatar ? <img src={state.userAvatar} alt="我的头像" /> : <span>我</span>}</div><div className="tavern-message-content"><div className="tavern-message-byline"><strong>{message.role === 'assistant' ? character.name : '你'}</strong><small>{index === 0 && message.role === 'assistant' ? '角色开场白' : '对话'}</small></div><p>{message.content}</p>{message.role === 'assistant' && <details className="tavern-message-statistics"><summary>Token 与费用</summary><TavernMessageUsage record={usageByMessageId.get(message.id)} /></details>}<div className="tavern-message-actions"><button type="button" onClick={() => copy(message.content)} aria-label={`复制第${index + 1}条消息`}><Copy size={14} />复制</button><button type="button" disabled={!writable || Boolean(unsavedReply)} onClick={() => setBranchMessage(message)} aria-label={`编辑第${index + 1}条消息并创建分支`}><Pencil size={14} />编辑与分支</button>{message.role === 'assistant' && <button type="button" disabled={pending} onClick={() => illustrate(message.content)}><ImagePlus size={14} />创作这幅画面</button>}{message.role === 'assistant' && index > 0 && index === session.messages.length - 1 && <button type="button" disabled={pending} onClick={() => send(true)}><RefreshCw size={14} />重新生成</button>}</div>{message.role === 'assistant' && index === session.messages.length - 1 && <TavernReplyVariants message={message} disabled={!writable || Boolean(unsavedReply)} onSelect={variantId => chooseReply(message.id, variantId)} />}</div></article>)}{pending && pendingKind !== 'assist' && <div className="tavern-thinking" role="status"><LoaderCircle size={17} className="tavern-spin" />{pendingKind === 'summary' ? '正在整理较早的剧情，原聊天记录会保留…' : liveText || `${character.name}正在构思回复…`}</div>}<div ref={bottom} /></div>
        <div className="tavern-composer-area">{chatError && <p className="tavern-chat-error" role="alert">{chatError}</p>}<div className="tavern-composer"><textarea ref={composer} value={draft} onChange={event => setDrafts(previous => ({ ...previous, [session.id]: event.target.value }))} maxLength={6000} rows={3} placeholder={`对${character.name}说些什么，或描述你的行动…`} aria-label="对话内容" disabled={pending || !writable} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia('(max-width: 760px)').matches) { event.preventDefault(); if (draft.trim()) send(); } }} /><div className="tavern-composer-tools"><button type="button" className="tavern-text-button tavern-assist-button" onClick={assistDraft} disabled={pending || !writable || Boolean(unsavedReply)} title="根据当前剧情代拟或润色你的草稿；单独计Token费用，不自动发送"><Sparkles size={15} />{pending && pendingKind === 'assist' ? '正在助写…' : 'AI 助写'}</button>{assistUndo?.sessionId === session.id && draft === assistUndo.generated && <button type="button" className="tavern-text-button" disabled={pending} onClick={() => { setDrafts(previous => ({ ...previous, [session.id]: assistUndo.original })); setAssistUndo(null); composer.current?.focus(); }}>恢复原草稿</button>}<button type="button" className="tavern-text-button" disabled={pending || !writable} onClick={() => setImagePrompt({ type: 'scene' })}><ImagePlus size={15} />画面创作</button><button type="button" className="tavern-text-button" onClick={() => setContextOpen(true)}><BookOpen size={15} />世界与记忆</button><span>{draft.length} / 6000</span>{pending ? <button type="button" className="tavern-button" onClick={() => controller.current?.abort()}><Square size={15} />停止等待</button> : <button type="button" className="tavern-button is-primary" disabled={!draft.trim() || !writable} onClick={() => send()}><Send size={16} />发送</button>}</div></div><div className="tavern-composer-note"><span>默认简体中文回复 · AI助写另计用量 · {settings.billingMode === 'platform' ? (platformReady ? '先预留积分，按实际 Token 结算 · 摘要另计' : '平台服务接入后开放 · 按 Token 计费') : '不扣网站积分 · 上游按你的 API 账户计费'}</span><button type="button" onClick={() => downloadJson({ version: 2, character: exportCharacter(character), session }, session.title)}><Download size={13} />导出对话</button></div></div>
      </div>
      {contextOpen && <aside className="tavern-context-sidebar"><TavernContextPanel key={session.id} session={session} userAvatar={state.userAvatar} onUserAvatarChange={async userAvatar => { if (!commitState(previous => ({ ...previous, userAvatar }))) throw new Error('头像未保存，请检查本地容量。'); await persistCurrent(); }} busy={pending} contextStatus={contextStatus} onSummarize={summarizeNow} onRestoreSummary={() => updateContext(restoreTavernSummary(session))} onEditSummary={text => { if (!session.summary || !text.trim()) throw new Error('请填写非空摘要。'); updateContext({ summary: { ...session.summary, text: text.trim(), createdAt: Date.now() }, summaryHistory: [...session.summaryHistory, session.summary].slice(-5), autoMemory: false }); }} onSettingsChange={updateContext} onChange={value => updateContext({ persona: value.persona, memory: value.memory, loreEntries: value.loreEntries })} onClose={() => setContextOpen(false)} /></aside>}
    </div>}
    {importOpen && <TavernImportDialog kind="character" onImport={person => { if (!saveCharacter({ ...person, id: crypto.randomUUID() })) throw new Error('导入未保存，请先清理本地角色或对话。'); setImportOpen(false); }} onClose={() => setImportOpen(false)} />}
    {editor !== undefined && <CharacterEditor character={editor} onSave={person => { if (!saveCharacter(person)) throw new Error("角色未保存，请检查内容长度与本地容量。"); }} onClose={() => setEditor(undefined)} />}
    {greetingCharacter && <TavernGreetingPicker character={greetingCharacter} onSelect={index => startChat(greetingCharacter, index)} onClose={() => setGreetingCharacter(null)} />}
    {branchMessage && session && <TavernBranchDialog message={branchMessage} onConfirm={saveBranch} onClose={() => setBranchMessage(null)} />}
    {storyOpen && session && <TavernStorySettings key={session.id} session={session} onSave={scenario => { updateContext({ scenario }); setStoryOpen(false); setNotice('故事起点已保存，将用于后续对话。'); }} onClose={() => setStoryOpen(false)} />}
    {billingOpen && authSession && <TavernBillingPanel authHeaders={authHeaders} onClose={() => setBillingOpen(false)} onAccountRefresh={refreshBalance} onReconcile={reconcileBilling} pendingRequestIds={[...new Set(state.sessions.flatMap(item => item.usageRecords.filter(record => record.billingMode === 'platform' && record.outcome === 'unknown' && record.id !== pendingRequestId).map(record => record.id)))]} />}
    {exportSelection && <TavernDialog title="导出角色与世界书" eyebrow="TAKE YOUR STORY" icon={Download} onClose={() => setExportSelection(null)}><div className="tv-dialog-body"><TavernExportActions character={exportSelection.character} session={exportSelection.session} /></div></TavernDialog>}
    {imagePrompt && session && character && <TavernImagePromptDialog key={session.id} character={character} session={session} templates={state.imageTemplates} initialType={imagePrompt.type} message={imagePrompt.message} onSave={saveImageTemplates} onUse={useImagePrompt} onClose={() => setImagePrompt(null)} />}
    {appearanceOpen && <TavernAppearanceDialog value={state.appearance} backgrounds={state.backgrounds} onAdd={addBackground} onDelete={deleteBackground} onGenerate={session ? generateBackground : undefined} onTemplates={session ? () => { setAppearanceOpen(false); setImagePrompt({ type: 'background' }); } : undefined} onClose={() => setAppearanceOpen(false)} onSave={appearance => { if (!commitState(previous => ({ ...previous, appearance }))) throw new Error('外观未保存，请检查本地容量。'); setAppearanceOpen(false); setNotice('聊天外观已保存到此浏览器。'); }} />}
    {settingsOpen && <TavernSettings value={settings} service={service} onSave={value => { setSettings(value); setSettingsOpen(false); setNotice(value.billingMode === 'own_key' ? '对话服务已保存到本页，刷新后需重新填写 Key。' : '已选择平台积分服务，实际计费请查看平台账单。'); }} onClose={() => setSettingsOpen(false)} />}
    {renaming && <RenameStory key={renaming.id} item={renaming} onClose={() => setRenaming(null)} onSave={title => { if (updateSession(renaming.id, { title, titleEdited: true })) { setRenaming(null); setNotice('故事名称已保存。'); } }} />}
    {confirmation && <ConfirmDelete item={confirmation} onClose={() => setConfirmation(null)} onConfirm={removeConfirmed} />}
  </section>;
}

function ConfirmDelete({ item, onClose, onConfirm }) {
  const dialog = useRef(null);
  useEffect(() => { const previous = document.activeElement; dialog.current.showModal(); return () => previous?.focus(); }, []);
  return <dialog ref={dialog} className="tavern-delete-dialog" onCancel={event => { event.preventDefault(); onClose(); }} aria-labelledby="tavern-delete-title"><h2 id="tavern-delete-title">删除“{item.name}”？</h2><p>{item.type === 'reply' ? '这条回复尚未保存，放弃后无法恢复。请确认已经复制或导出。' : item.type === 'character' ? '这个角色及其本机对话记录都会删除。请先导出需要保留的内容。' : '此浏览器中的这段对话将被删除，无法撤销。'}</p><div><button type="button" className="tavern-button" autoFocus onClick={onClose}>保留</button><button type="button" className="tavern-button is-danger" onClick={onConfirm}>确认删除</button></div></dialog>;
}

function RenameStory({ item, onClose, onSave }) {
  const [title, setTitle] = useState(item.title);
  return <TavernDialog icon={Pencil} title="重命名故事" eyebrow="YOUR STORY" onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (title.trim()) onSave(title.trim()); }}><div className="tv-dialog-body"><label className="tv-field-label" htmlFor="tavern-story-name">故事名称</label><input id="tavern-story-name" data-initial-focus className="tavern-story-name" value={title} maxLength={160} required onChange={event => setTitle(event.target.value)} /></div><footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" onClick={onClose}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={!title.trim()}>保存名称</button></footer></form></TavernDialog>;
}
