import { useState } from 'react';
import type { AudioEngine } from '../audio/engine';

export function SoundControls({ engine }: { engine: AudioEngine }) {
  const [rain, setRain] = useState(70);
  const [music, setMusic] = useState(18);
  return (
    <details className="sound-controls">
      <summary>声音</summary>
      <div className="sound-sliders">
        <label>
          雨声{' '}
          <input
            aria-label="雨声音量"
            type="range"
            min="0"
            max="100"
            value={rain}
            onChange={(e) => {
              const v = +e.target.value;
              setRain(v);
              engine.setRainVolume(v / 100);
            }}
          />
        </label>
        <label>
          音乐{' '}
          <input
            aria-label="背景音乐音量"
            type="range"
            min="0"
            max="100"
            value={music}
            onChange={(e) => {
              const v = +e.target.value;
              setMusic(v);
              engine.setMusicVolume(v / 100);
            }}
          />
        </label>
        <small>雨夜 · 未打烊</small>
      </div>
    </details>
  );
}
