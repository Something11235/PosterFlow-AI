import React, {useState} from 'react';
import {Music2} from 'lucide-react';
import {TavernDialog} from './TavernDialogs';
import {buildTavernBgmPrompt,TAVERN_BGM_MOODS} from '../../lib/tavernMusic';

export default function TavernBgmDialog({character,session,onGenerate,onClose}) {
  const [mood,setMood]=useState('auto');
  const [prompt,setPrompt]=useState(()=>buildTavernBgmPrompt(character,session));
  return <TavernDialog title="剧情 BGM" eyebrow="MUSIC FOR YOUR STORY" icon={Music2} onClose={onClose}>
    <form className="tv-dialog-form" onSubmit={event=>{event.preventDefault();if(prompt.trim())onGenerate({prompt:prompt.trim(),sessionId:session.id});}}>
      <div className="tv-dialog-body grid gap-3">
        <div className="tv-field"><label className="tv-field-label" htmlFor="tavern-bgm-mood">BGM 氛围</label><select id="tavern-bgm-mood" value={mood} onChange={event=>{setMood(event.target.value);setPrompt(buildTavernBgmPrompt(character,session,event.target.value));}}>{TAVERN_BGM_MOODS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></div>
        <div className="tv-field"><label className="tv-field-label" htmlFor="tavern-bgm-prompt">配乐描述</label><textarea id="tavern-bgm-prompt" rows={8} maxLength={3000} value={prompt} onChange={event=>setPrompt(event.target.value)}/></div>
        <p className="tv-field-hint">根据当前环境、剧情记忆与最近四条消息准备纯音乐。沿用音乐工作区的模型与使用方式：平台每次 2 积分，自带 Key 不扣平台积分；准备配乐描述不额外计费。任务状态未知时请先查询原任务。</p>
        <p className="tv-field-hint">生成后选择“用于酒馆 BGM”返回故事播放。音频为临时链接，请及时下载。</p>
      </div>
      <footer className="tv-dialog-footer"><button type="button" className="tv-button tv-button-secondary" onClick={onClose}>取消</button><button type="submit" className="tv-button tv-button-primary" disabled={!prompt.trim() || Array.from(prompt).length>3000}><Music2 size={16}/>生成 BGM</button></footer>
    </form>
  </TavernDialog>;
}
