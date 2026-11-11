import React, { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadTavernExport } from '../../lib/tavernExport';

export default function TavernExportActions({ character, getCharacter, session, disabled = false }) {
  const [busy,setBusy]=useState(''), [error,setError]=useState(''), [notice,setNotice]=useState('');
  async function download(kind) {
    if(busy || disabled) return;
    setBusy(kind); setError(''); setNotice('');
    try {
      const result=await downloadTavernExport(getCharacter ? getCharacter() : character,kind,session);
      setNotice(result==='cancelled' ? '已取消导出。' : result==='saved' ? '文件已保存。' : '导出文件已准备，请查看浏览器下载。');
    } catch(reason) { setError(reason.message || '导出失败，请重试。'); }
    finally { setBusy(''); }
  }
  return <section className="tv-export-actions" aria-label="导出角色与世界书"><div className="tv-export-buttons">{[['png','PNG 角色卡'],['json','JSON 角色卡'],['lorebook','世界书 JSON']].map(([kind,label]) => <button key={kind} type="button" className="tv-button tv-button-secondary" disabled={disabled || Boolean(busy)} onClick={() => void download(kind)}>{busy===kind ? <Loader2 size={15} className="tv-spin" /> : <Download size={15} />}{label}</button>)}</div><p className="tv-field-hint">PNG含角色封面与当前角色资料，可重新导入本站或SillyTavern；JSON角色卡含内嵌世界书，不含头像。{session ? '将导出当前故事起点与世界书。' : '导出当前角色设定。'}不包含API Key、我的人设、剧情记忆或聊天记录；高级插件扩展不保证兼容。</p>{error && <p className="tv-form-error" role="alert">{error}</p>}{notice && <p className="tv-save-status" role="status">{notice}</p>}</section>;
}
