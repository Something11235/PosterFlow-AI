import React from 'react';
import { ArrowUpRight, BookOpen, MessageCircle, UserRound } from 'lucide-react';
import { characterOverview, introProse } from '../../lib/tavernCharacterIntro';
import { TavernDialog } from './TavernDialogs';
import './tavern-character-intro.css';

function sourceLink(page) {
  if (!page?.url) return '';
  try {
    const url = new URL(page.url);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export default function TavernCharacterIntro({ character, onClose, onStart }) {
  const { name, avatar, creator, sourcePage } = character;
  const overview = characterOverview(character);
  const scene = introProse(character.scenario, name, 200);
  const startingPoint = introProse(character.introduction?.startingPoint, name, 260)
    || (scene !== overview && scene)
    || '从角色的开场白接下去。你可以说一句话，也可以写下自己接下来的行动。';
  const original = sourcePage?.originalCreator;
  const url = sourceLink(sourcePage);
  const subtitle = introProse(character.subtitle, name, 80);
  const showSubtitle = subtitle && !/^(?:作者|改编|原作)\s*[·：:]|^(?:自定义角色|导入角色卡|导入的角色卡)$/.test(subtitle);

  return <TavernDialog title="角色介绍" eyebrow="CHARACTER PROFILE" icon={BookOpen} onClose={onClose} className="tv-character-intro">
    <div className="tv-dialog-body">
      <div className="tv-intro-identity">
        <div className="tv-intro-portrait">{avatar
          ? <img src={avatar} alt={`${name}的头像`} />
          : <UserRound size={38} strokeWidth={1.4} aria-hidden="true" />}</div>
        <div className="tv-intro-byline"><h3>{name}</h3>
          {showSubtitle && <p>{subtitle}</p>}
          {(creator || original || url) && <div className="tv-intro-credits">
            {original && <span>原作 · {original}</span>}
            {creator && creator !== original && <span>{original ? '改编' : '作者'} · {creator}</span>}
            {url && <a href={url} target="_blank" rel="noopener noreferrer">{sourcePage.platform || '查看原卡'} <ArrowUpRight size={14} aria-hidden="true" /></a>}
          </div>}
        </div>
      </div>
      <section className="tv-intro-section"><h4>故事简介</h4><p>{overview}</p></section>
      <section className="tv-intro-section tv-intro-start"><h4>如何开始</h4><p>{startingPoint}</p></section>
    </div>
    <footer className="tv-dialog-footer">
      <button type="button" className="tv-button tv-button-secondary" onClick={onClose}>关闭</button>
      {onStart && <button type="button" className="tv-button tv-button-primary" onClick={() => onStart(character)}>
        <MessageCircle size={16} aria-hidden="true" />开始对话
      </button>}
    </footer>
  </TavernDialog>;
}
