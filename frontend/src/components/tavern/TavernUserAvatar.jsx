import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, UserRound } from 'lucide-react';
import { prepareTavernUserAvatar } from '../../lib/tavernUserAvatar';

export default function TavernUserAvatar({ value, onChange, disabled }) {
  const [busy,setBusy]=useState(false), [error,setError]=useState('');
  const mounted=useRef(true);
  useEffect(() => { mounted.current=true; return () => { mounted.current=false; }; },[]);
  async function change(file) {
    setBusy(true); setError('');
    try { const image=file ? await prepareTavernUserAvatar(file) : ''; if(mounted.current) await onChange(image); }
    catch(reason) { if(mounted.current) setError(reason.message); }
    finally { if(mounted.current) setBusy(false); }
  }
  return <section className="tv-user-avatar" aria-label="我的聊天头像"><div className="tv-user-avatar-preview">{value ? <img src={value} alt="我的聊天头像" width="72" height="72" /> : <UserRound size={30} />}</div><div><strong>我的聊天头像</strong><div className="tv-export-buttons"><label className="tv-user-avatar-upload"><Upload size={14} />{busy ? '正在保存…' : value ? '更换头像' : '上传头像'}<input type="file" aria-label="上传我的头像" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy} onChange={event => { const file=event.target.files?.[0]; event.target.value=''; if(file) void change(file); }} /></label>{value && <button type="button" className="tv-button tv-button-secondary" disabled={disabled || busy} onClick={() => void change(null)}>移除头像</button>}{busy && <Loader2 size={16} className="tv-spin" />}</div><p className="tv-field-hint">PNG、JPG、WebP，最多2MB，仅保存在当前账号的本机酒馆中。</p></div>{error && <p className="tv-form-error" role="alert">{error}</p>}</section>;
}
