import { DiagnosticsButton } from './ui/DiagnosticsButton';
import { WorldMap } from './ui/WorldMap';
import { SceneJourney } from './scene/SceneJourney';
import { SceneBoundary } from './scene/SceneBoundary';
import { Background } from './scene/Background';
import { Encounter } from './ui/Encounter';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stage } from './scene/Stage';
import { Subtitles } from './ui/Subtitles';
import { InputBar } from './ui/InputBar';
import { EnterOverlay } from './ui/EnterOverlay';
import { StatePill, GeneratingChip, PhotoCard, Flash, DebugPanel, PostFx } from './ui/Overlays';
import { ClientDirector } from './state/directorClient';
import { useStore } from './state/store';
import { SoundControls } from './ui/SoundControls';
import { EyeToggle } from './ui/EyeToggle';
import { EyePreview } from './ui/EyePreview';
import { ResetButton } from './ui/ResetButton';
import { OrientationButton } from './ui/OrientationButton';
import { eyeContact } from './vision/eyeContact';

export default function App() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const isMock = params.get('mock') === '1';
  const director = useMemo(() => new ClientDirector(isMock), [isMock]);
  const [starting, setStarting] = useState(false);
  const entered = useStore((s) => s.entered);
  const world = useStore((s) => s.world);
  const phase = useStore((s) => s.phase);
  const modelReady = useStore((s) => s.modelReady);
  const toast = useStore((s) => s.toast);
  const debugInit = useRef(params.get('debug') === '1');

  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () =>
      document.documentElement.style.setProperty('--usable-height', `${viewport?.height ?? innerHeight}px`);
    resize();
    viewport?.addEventListener('resize', resize);
    return () => viewport?.removeEventListener('resize', resize);
  }, []);

  // 调试开关 + 全局口型钩子
  useEffect(() => {
    useStore.setState({ debugOpen: debugInit.current });
    const w = window as unknown as {
      __mouth: () => number;
      __speech: () => { level: number; beat: number; beatId: number; strength: number };
    };
    w.__mouth = () => director.engine.mouthLevel();
    w.__speech = () => director.engine.speechDrive();
  }, [director]);

  // 环境声联动：雨强 → 音量
  const rain = useStore((s) => s.fx.rain);
  useEffect(() => {
    if (entered) director.engine.setRainLevel(rain);
  }, [rain, entered, director]);

  const onEnter = useCallback(
    async (freshWorld = false) => {
      if (starting) return;
      setStarting(true);
      // 对视默认开：和麦克风在同一次点击手势里申请摄像头。手动关过（localStorage）就不再自动开；
      // 摄像头失败不拦进场——她看不见你，演出照常。
      if (!isMock && localStorage.getItem('mira.eye') !== 'off') {
        void eyeContact.enable().catch(() => {});
      }
      try {
        await director.start(freshWorld);
        director.enter();
      } catch (e) {
        useStore.getState().set({ toast: `连接失败：${(e as Error).message}` });
      } finally {
        setStarting(false);
      }
    },
    [director, starting, isMock],
  );

  const onReset = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      await director.reset();
      director.enter();
    } catch (e) {
      useStore.getState().set({ toast: `连接失败：${(e as Error).message}` });
    } finally {
      setStarting(false);
    }
  }, [director, starting]);

  // 断线提示点击重连
  const onScreenTap = useCallback(() => {
    const st = useStore.getState();
    if (st.phase === 'reconnecting') void director.reconnect();
  }, [director]);

  return (
    <div className="app" onClick={onScreenTap}>
      <Background />
      <SceneBoundary>
        <Stage />
      </SceneBoundary>
      <PostFx />
      <SceneJourney />
      <Flash />
      {entered && (
        <>
          <WorldMap
            world={world}
            onTravel={(id) => director.travelTo(id)}
            onOpenChange={(open) => director.setMapOpen(open)}
            onCancel={() => director.cancelTravel()}
            disabled={phase === 'reconnecting'}
          />
          <StatePill />
          <div className="top-controls">
            <EyeToggle />
            <EyePreview />
            <SoundControls engine={director.engine} />
            <DiagnosticsButton />
            <ResetButton onReset={onReset} />
          </div>
          <OrientationButton />
          <PhotoCard />
          <div className="conversation-dock">
            <Subtitles />
            <Encounter director={director} />
            <GeneratingChip />
            <InputBar director={director} />
          </div>
        </>
      )}
      {!entered && (
        <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 100 }}>
          <DiagnosticsButton />
        </div>
      )}
      {!entered && <EnterOverlay onEnter={onEnter} ready={!starting && modelReady} starting={starting} mock={isMock} />}
      {toast && entered && <div className="toast">{toast}</div>}
      <button
        className="debug-toggle"
        onClick={(e) => {
          e.stopPropagation();
          useStore.setState((s) => ({ debugOpen: !s.debugOpen }));
        }}
      >
        ·
      </button>
      <DebugPanel />
    </div>
  );
}
