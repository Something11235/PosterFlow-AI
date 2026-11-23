import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Check, History, MessageSquare, Plus, Send } from "lucide-react";
import { PPT_MODEL_NAMES } from "../../lib/pptProject";

const historyDate = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});

export default function PptChat({
  turns, pending, model, busy, composerDisabled, value, onChange, onSaveDraft, onSend, onUseTopic,
  sessions = [], activeChatId, onNewChat, onSelectChat, historyDisabled,
}) {
  const log = useRef(null);
  const historyToggle = useRef(null);
  const historyId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const question = pending?.action === "chat" ? pending.body?.message : "";
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [activeChatId, turns.length, question]);

  return <>
    <header className="ppt-chat-heading">
      <div><MessageSquare size={17} aria-hidden="true"/><h2>AI 对话</h2><span className="ppt-chat-model">{PPT_MODEL_NAMES[model]}</span></div>
      <div className="ppt-chat-actions">
        <button type="button" className="ppt-secondary" disabled={historyDisabled} onClick={() => { setHistoryOpen(false); onNewChat(); }}>
          <Plus size={15} aria-hidden="true"/>新对话
        </button>
        <button ref={historyToggle} type="button" className="ppt-secondary" aria-expanded={historyOpen} aria-controls={historyId}
          onClick={() => setHistoryOpen(open => !open)}>
          <History size={15} aria-hidden="true"/>历史对话
        </button>
      </div>
    </header>
    <section className="ppt-chat-history" id={historyId} aria-label="历史对话" hidden={!historyOpen}
      onKeyDown={event => {
        if (event.key === "Escape") { setHistoryOpen(false); historyToggle.current?.focus(); }
      }}>
      <p>对话记录保存在当前浏览器。</p>
      {historyOpen && <ul>
        {[...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map(session => {
          const selected = session.id === activeChatId;
          const title = (session.turns[0]?.message || (selected && question) || (selected ? value : session.draft) || "").trim() || "新对话";
          return <li key={session.id}>
            <button type="button" aria-current={selected ? "true" : undefined} disabled={historyDisabled}
              onClick={() => { onSelectChat(session.id); setHistoryOpen(false); historyToggle.current?.focus(); }}>
              <span className="ppt-history-title">{title}</span>
              {session.updatedAt > 0 && <time dateTime={new Date(session.updatedAt).toISOString()}>{historyDate.format(session.updatedAt)}</time>}
              {selected && <Check size={15} aria-hidden="true"/>}
            </button>
          </li>;
        })}
      </ul>}
    </section>
    <div ref={log} className="ppt-chat-log" role="log" aria-label="对话记录">
      {!turns.length && !question && <div className="ppt-chat-empty">
        <MessageSquare size={26} aria-hidden="true"/><h3>想聊点什么？</h3>
        <p>可以直接提问，也可以让 AI 根据参考资料梳理提纲，或为当前幻灯片提出建议。</p>
      </div>}
      {turns.map(turn => <React.Fragment key={turn.id}>
        <div className="ppt-chat-user"><span>你</span><p>{turn.message}</p></div>
        <div className="ppt-chat-reply"><span>{PPT_MODEL_NAMES[turn.model] || "AI"}</span><p>{turn.reply}</p>
          {turn.reply.length <= 6000 && <button type="button" disabled={busy} onClick={() => onUseTopic(turn.reply)}>用作演示主题<ArrowUpRight size={13}/></button>}
        </div>
      </React.Fragment>)}
      {question && <div className="ppt-chat-user"><span>你</span><p>{question}</p></div>}
    </div>
    <form className="ppt-chat-compose" onSubmit={event => { event.preventDefault(); if (!busy && value.trim()) onSend(); }}>
      <label className="ppt-field"><span>发送消息</span><textarea rows={3} maxLength={6000} placeholder="输入问题，或继续追问…" value={value}
        disabled={composerDisabled} onChange={event => onChange(event.target.value)} onBlur={onSaveDraft}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.currentTarget.form.requestSubmit();
          }
        }}/></label>
      <div><small>对话按实际 Token 用量计费</small><button type="submit" className="ppt-primary" disabled={busy || !value.trim()}><Send size={15}/>发送</button></div>
    </form>
  </>;
}
