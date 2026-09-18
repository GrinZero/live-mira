import { useStore } from '../state/store';

// 字幕区：下三分之一。Mira 台词主显，用户转写次显，旁白淡入淡出
export function Subtitles() {
  const subtitles = useStore((s) => s.subtitles);
  const phase = useStore((s) => s.phase);
  const last = [...subtitles].reverse();
  const mira = last.find((s) => s.who === 'mira');
  const user = last.find((s) => s.who === 'user' && !s.final === false);
  const narration = last.find((s) => s.who === 'narration');

  return (
    <div className="subtitles" aria-live="polite">
      {narration && (
        <div className="sub narration" key={narration.id}>
          {narration.text}
        </div>
      )}
      {user && (
        <div className="sub user" key={user.id}>
          {user.final ? '「' : ''}
          {user.text}
          {user.final ? '」' : '…'}
        </div>
      )}
      {phase === 'thinking' && <div className="sub mira thinking">…</div>}
      {mira && (
        <div className={`sub mira ${mira.interrupted ? 'interrupted' : ''}`} key={mira.id}>
          {mira.text}
        </div>
      )}
    </div>
  );
}
