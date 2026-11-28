import React, { useRef } from "react";
import { CheckCircle2, LoaderCircle, Music2, Plus, X } from "lucide-react";

export default function MusicAudioReferences({ limit, description, audio, canUpload, onLogin }) {
  const input = useRef(null);
  const chooseAudio = () => canUpload ? input.current?.click() : onLogin();
  return <>
    <div className="music-reference-heading"><div><strong>参考音频</strong><small>{description}</small></div>
      <button type="button" className="studio-secondary" disabled={audio.items.length >= limit} onClick={chooseAudio}><Plus size={15} />添加音频</button>
      <input ref={input} type="file" accept="audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" multiple={limit > 1} className="sr-only" aria-label="选择参考音频" onChange={event => { audio.add(event.target.files, limit); event.target.value = ""; }} />
    </div>
    <p className="music-reference-note">MP3 / WAV · 本站上限：每段 20 MB、1 秒至 8 分钟。可先试听；添加素材不扣积分，提交生成时按次计费。</p>
    {!audio.items.length && <button type="button" className="music-reference-empty" aria-label="点击添加参考音频" onClick={chooseAudio}><Music2 size={23} /><span>把旋律、节奏或自己的演奏带进来。</span></button>}
    <div className="music-reference-list">{audio.items.map((item, index) => <article key={item.id} className="music-reference-card"><div><strong>{index + 1}. {item.name}</strong><button type="button" className="studio-icon-button" onClick={() => audio.remove(item.id)} aria-label={`移除音频 ${index + 1}`}><X size={15} /></button></div>
      <audio controls preload="metadata" src={item.url} aria-label={`试听参考音频 ${index + 1}`} onPlay={event => document.querySelectorAll("audio").forEach(audio => { if (audio !== event.currentTarget) audio.pause(); })} />
      {item.state === "uploading" ? <p role="status"><LoaderCircle size={13} className="music-spin" />正在上传并校验音频…</p> : item.state === "failed" ? <p role="alert" className="music-reference-error">{item.error}</p> : <p><CheckCircle2 size={13} />已就绪 · {Math.floor(item.reference.duration / 60)}:{String(Math.floor(item.reference.duration % 60)).padStart(2, "0")}</p>}
    </article>)}</div>
    {audio.message && <p role="alert" className="music-reference-error">{audio.message}</p>}
    {audio.items.length > limit && <p role="alert" className="music-reference-error">音频改编每次使用 1 段素材，请移除多余音频。</p>}
    <p className="music-reference-note">素材临时保留 12 小时。请使用原创或已获授权的录音。生成时，音乐服务商还会审核参考音频。</p>
  </>;
}
