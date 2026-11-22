import { memo } from 'react';
import { splitTavernStatusBlocks, visibleTavernMessage } from '../../lib/tavernStatusBlocks.js';

export default memo(function TavernMessageText({ role, content }) {
  const visible = visibleTavernMessage(content);
  const sections = role === 'assistant' && splitTavernStatusBlocks(visible);
  if (!sections) return <p>{visible}</p>;
  return <div className="tavern-message-rich">
    {sections.map((section, index) => section.fields
      ? <section className="tavern-status-panel" aria-label="角色状态" key={index}>
        <h4>角色状态</h4>
        <dl>{section.fields.map(({ label, value }, field) => <div key={field}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </section>
      : <p key={index}>{section.text}</p>)}
  </div>;
});
