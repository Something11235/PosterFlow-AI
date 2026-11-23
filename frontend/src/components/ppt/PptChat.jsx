import React, { useEffect, useRef } from "react";
import { ArrowUpRight, MessageSquare, Send } from "lucide-react";
import { PPT_MODEL_NAMES } from "../../lib/pptProject";

export default function PptChat({ turns, pending, model, busy, value, onChange, onSaveDraft, onSend, onUseTopic }) {
  const log = useRef(null);
  const question = pending?.action === "chat" ? pending.body?.message : "";
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [turns.length, question]);
  return <>
    <header><div><MessageSquare size={17}/><h2>AI 对话</h2></div><span className="ppt-chat-model">{PPT_MODEL_NAMES[model]}</span></header>
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
        disabled={busy} onChange={event => onChange(event.target.value)} onBlur={onSaveDraft}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.currentTarget.form.requestSubmit();
          }
        }}/></label>
      <div><small>对话按实际 Token 用量计费</small><button type="submit" className="ppt-primary" disabled={busy || !value.trim()}><Send size={15}/>发送</button></div>
    </form>
  </>;
}
