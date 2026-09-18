// Development-only visual harness. Uses production renderer and media state machine, no microphone or AI calls.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Background } from './src/scene/Background';
import { Stage } from './src/scene/Stage';
import { SceneJourney } from './src/scene/SceneJourney';
import { ClientDirector } from './src/state/directorClient';
import { useStore } from './src/state/store';
import { EyeToggle } from './src/ui/EyeToggle';
import { EyePreview } from './src/ui/EyePreview';
import './src/styles.css';
const director = new ClientDirector(false);
const harness = director as any;
harness.transport = {
  send: (m: any) => {
    if (m.type === 'scene.presented') document.documentElement.dataset.presented = m.id;
  },
};
(window as any).__media = (e: any) => harness.onMessage({ type: 'media.event', event: e });
useStore.setState({ phase: 'listening', entered: true });
const scene = new URLSearchParams(location.search).get('scene') || '/assets/bg/cafe_interior.jpg';
function Check() {
  const transition = useStore((s) => s.sceneTransition);
  const [started, setStarted] = useState(false);
  return (
    <div className="app">
      <Background />
      <Stage />
      <SceneJourney />
      <div className="top-controls">
        <EyeToggle />
        <EyePreview />
      </div>
      <div style={{ position: 'absolute', zIndex: 20, bottom: 20, left: 20, right: 20, color: 'white' }}>
        <p role="status">{transition?.phase || (started ? '已到达' : '咖啡馆 · 验证画面')}</p>
        <button
          style={{ minHeight: 48, padding: 12 }}
          onClick={() => {
            setStarted(true);
            harness.onMessage({ type: 'media.event', event: { id: 'check', kind: 'scene', status: 'generating' } });
            setTimeout(
              () =>
                harness.onMessage({
                  type: 'media.event',
                  event: { id: 'check', kind: 'scene', status: 'ready', url: scene, scene_key: 'outside' },
                }),
              1500,
            );
          }}
        >
          验证出发与到达
        </button>
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Check />);
