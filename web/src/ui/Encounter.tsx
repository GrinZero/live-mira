import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import type { ClientDirector } from '../state/directorClient';

// 无人接话时，此刻退成一行还在那儿的低语——和导演端 20s 沉默阈值同一节奏
const SETTLE_MS = 20000;

// 没有弹出的卡片：事件直接发生在画面里（视觉变化叠进底图），
// 现场描述是一行浮在场景上的字，可选回应是漂在画面上的几句话。
export function Encounter({ director }: { director: ClientDirector }) {
  const story = useStore((s) => s.story);
  const photo = useStore((s) => s.photo);
  const phase = useStore((s) => s.phase);
  const [settled, setSettled] = useState(false);
  const revision = story?.revision ?? 0;

  useEffect(() => {
    setSettled(false);
    const t = window.setTimeout(() => setSettled(true), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [revision]);

  if (!story || story.phase !== 'invitation' || photo) return null;

  if (settled) {
    const label = story.title && !story.title.startsWith('此刻') ? `此刻 · ${story.title}` : story.title || '此刻';
    return (
      <button className="encounter settled" onClick={() => setSettled(false)} aria-label={`${label}，点开再看看`}>
        <i className="settled-dot" />
        {label}
      </button>
    );
  }

  return (
    <div className="encounter-live" aria-label="此刻的故事">
      <p className="encounter-event">
        {story.title ? `${story.title}：` : ''}
        {story.event}
      </p>
      <div className="encounter-choices">
        {story.choices.map((choice) => (
          <button
            key={choice.id}
            className="say"
            disabled={phase === 'thinking'}
            aria-label={`说：${choice.label}`}
            onClick={() => director.choose(choice.id)}
          >
            「{choice.label}」
          </button>
        ))}
        <button className="pass" onClick={() => director.choose('dismiss')}>
          先不管它
        </button>
      </div>
    </div>
  );
}
