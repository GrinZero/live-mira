import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

type OrientationApi = ScreenOrientation & {
  lock?: (orientation: 'landscape') => Promise<void>;
};

async function withTimeout<T>(promise: Promise<T>, milliseconds: number) {
  let timer = 0;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error('orientation-timeout')), milliseconds);
      }),
    ]);
  } finally {
    window.clearTimeout(timer);
  }
}

function isLandscape() {
  return window.matchMedia('(orientation: landscape)').matches;
}

function showToast(message: string) {
  useStore.getState().set({ toast: message });
  window.setTimeout(() => useStore.getState().set({ toast: '' }), 4200);
}

/** Optional mobile enhancement; portrait mode remains fully usable. */
export function OrientationButton() {
  const [landscape, setLandscape] = useState(isLandscape);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(orientation: landscape)');
    const update = () => setLandscape(media.matches);
    media.addEventListener('change', update);
    window.addEventListener('resize', update);
    screen.orientation?.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      screen.orientation?.removeEventListener('change', update);
    };
  }, []);

  const requestLandscape = async () => {
    if (switching || landscape) return;
    setSwitching(true);

    try {
      const orientation = screen.orientation as OrientationApi | undefined;
      if (!orientation?.lock) throw new Error('orientation-lock-unsupported');

      try {
        await withTimeout(orientation.lock('landscape'), 1600);
      } catch {
        // Android browsers commonly only allow lock() from fullscreen.
        if (!document.documentElement.requestFullscreen) throw new Error('fullscreen-unsupported');
        await withTimeout(document.documentElement.requestFullscreen(), 1600);
        try {
          await withTimeout(orientation.lock('landscape'), 1600);
        } catch (error) {
          if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
          throw error;
        }
      }
    } catch {
      showToast('当前浏览器不能自动横屏，请手动旋转手机；竖屏也可以正常使用。');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <button
      type="button"
      className="orientation-btn"
      onClick={(event) => {
        event.stopPropagation();
        void requestLandscape();
      }}
      disabled={switching || landscape}
      aria-label={landscape ? '当前已是横屏' : '切换到横屏体验'}
      title="横屏后画面空间更宽；不想横屏也可以继续使用"
    >
      {switching ? '切换中…' : landscape ? '已横屏' : '横屏体验'}
    </button>
  );
}
