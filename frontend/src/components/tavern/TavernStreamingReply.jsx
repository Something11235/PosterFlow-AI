import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import TavernMessageText from './TavernMessageText';

// A request owns its transient text. Only this bubble rerenders as tokens arrive.
export default function TavernStreamingReply({ preview, waitingText }) {
  const [length, setLength] = useState(() => preview.shown);
  const edge = useRef(null);
  const follow = useRef(false);
  useEffect(() => {
    let frame = null;
    let lastDraw = 0;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Bound the visual catch-up if a proxy delivers the whole answer at once.
    const deadline = preview.messageId ? performance.now() + 280 : null;
    function draw(now) {
      frame = null;
      const remaining = preview.text.length - preview.shown;
      if (remaining <= 0) return;
      const elapsed = Math.max(16, Math.min(now - lastDraw, 60));
      lastDraw = now;
      const catchUp = deadline === null ? 200 : Math.max(1, deadline - now);
      const step = reducedMotion ? remaining : Math.max(1, Math.ceil(remaining * elapsed / catchUp));
      let end = Math.min(preview.text.length, preview.shown + step);
      // Keep a UTF-16 surrogate pair together while revealing emoji and rare characters.
      if (end < preview.text.length && /[\uD800-\uDBFF]/.test(preview.text[end - 1])) end++;
      const history = edge.current?.closest('.tavern-message-list');
      follow.current = history && history.scrollHeight - history.scrollTop - history.clientHeight < 72;
      preview.shown = end;
      setLength(end);
      if (end < preview.text.length) schedule();
    }
    function schedule() {
      if (frame === null && preview.shown < preview.text.length) frame = requestAnimationFrame(draw);
    }
    preview.notify = schedule;
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      preview.notify = null;
    };
  }, [preview]);
  useLayoutEffect(() => {
    const history = edge.current?.closest('.tavern-message-list');
    if (follow.current && history) history.scrollTop = history.scrollHeight;
  }, [length]);
  let text = preview.text.slice(0, length);
  if (!preview.messageId || length < preview.text.length) {
    // An unfinished hidden comment must not flash its contents during playback.
    const opener = text.lastIndexOf('<!--');
    if (opener > text.lastIndexOf('-->')) text = text.slice(0, opener);
  }
  return <><TavernMessageText role="assistant" content={text || waitingText || ''} /><span ref={edge} /></>;
}
