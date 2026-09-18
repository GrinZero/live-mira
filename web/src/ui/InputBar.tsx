import { useState } from 'react';
import { useStore } from '../state/store';
import type { ClientDirector } from '../state/directorClient';

// 输入条：文字 + 麦克开/关。语音打断靠自动 VAD，不占手
export function InputBar({ director }: { director: ClientDirector }) {
  const [text, setText] = useState('');
  const muted = useStore((s) => s.micMuted);
  const phase = useStore((s) => s.phase);
  const invited = useStore((s) => s.story?.phase === 'invitation');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    director.sendText(t);
  };
  return (
    <div className="inputbar">
      <button
        className={`micbtn ${muted ? 'off' : ''}`}
        onClick={() => director.setMuted(!muted)}
        title={muted ? '开麦' : '静音'}
        aria-label={muted ? '开麦' : '静音'}
      >
        {muted ? (
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              fill="currentColor"
              d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zM12 15.5c-2.49 0-4.5-2.01-4.5-4.5v-.01l-1.63-1.63C5.32 9.87 5 10.4 5 11c0 3.87 3.13 7 7 7 .57 0 1.12-.07 1.64-.18l-1.5-1.5c-.38.12-.75.18-1.14.18zM12 2c1.66 0 3 1.34 3 3v5.34L8.66 4A3 3 0 0 1 12 2zM3.27 3L2 4.27l7.73 7.73V15H8v2h8v-2h-1.73v-.27l6.99 6.99 1.41-1.41L3.27 3z"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path
              fill="currentColor"
              d="M12 15.5c2.49 0 4.5-2.01 4.5-4.5S14.49 6.5 12 6.5 7.5 8.51 7.5 11s2.01 4.5 4.5 4.5zM12 2c-1.66 0-3 1.34-3 3v6c0 1.66 1.34 3 3 3s3-1.34 3-3V5c0-1.66-1.34-3-3-3zm7 9c0 3.53-2.61 6.44-6 6.93V21h-2v-3.07C7.61 17.44 5 14.53 5 11h1.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5H19z"
            />
          </svg>
        )}
      </button>
      <input
        aria-label="对 Mira 说"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          director.noteInputActivity();
        }}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && submit()}
        placeholder={
          phase === 'speaking'
            ? '她在说话，直接开口即可打断…'
            : invited
              ? '回应此刻，或随口说点什么…'
              : '对她说点什么，或直接开口'
        }
        enterKeyHint="send"
      />
      {phase === 'speaking' && !text.trim() ? (
        <button className="sendbtn interruptbtn" onClick={() => director.interrupt('manual')}>
          打断
        </button>
      ) : (
        <button className="sendbtn" onClick={submit} disabled={!text.trim()}>
          发送
        </button>
      )}
    </div>
  );
}
