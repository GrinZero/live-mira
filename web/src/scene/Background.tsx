import { isCafeMatte, isStagedScene, companionFrame, layoutFromUrl } from '../../../shared/scene-layout';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { eyeContact } from '../vision/eyeContact';

// Reuse the original photograph through a source-space silhouette. Re-encoding
// a separate foreground plate changes its colors and creates visible seams.
const CAFE_SOURCE = '/assets/bg/cafe_interior.jpg';

// A photographic matte uses its actual aspect ratio. The table foreground shares
// the exact crop of the cafe source; other locations never inherit cafe furniture.
// overlay = 当前底图的 i2i 编辑（事件直接发生在画面里）：同构图同裁切，
// 盖在 matte 上与前景层（桌沿/近景带）同步淡入，until 到期或剧情翻页后淡出。
export function Background() {
  const matteRef = useRef<HTMLDivElement>(null);
  const foregroundRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({
    width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight,
  });
  const [natural, setNatural] = useState({ width: 2560, height: 1440 });
  const fx = useStore((s) => s.fx);
  const url = useStore((s) => s.bgUrl);
  const bgKey = useStore((s) => s.bgKey);
  const cafe = isCafeMatte(url);
  const overlay = useStore((s) => s.overlay);
  // shown = 正在显示（含淡出中）的叠层；store 清掉或到期时先淡出再卸载
  const [shown, setShown] = useState<{ url: string; out: boolean } | null>(null);
  useEffect(() => {
    const resize = () =>
      setSize({ width: visualViewport?.width ?? innerWidth, height: visualViewport?.height ?? innerHeight });
    addEventListener('resize', resize);
    visualViewport?.addEventListener('resize', resize);
    return () => {
      removeEventListener('resize', resize);
      visualViewport?.removeEventListener('resize', resize);
    };
  }, []);

  // 2.5D camera parallax. Face position wins when eye-contact is active; pointer
  // movement is a desktop fallback. The travel is deliberately tiny so a flat
  // photograph still reads as one coherent room rather than sliding cards.
  useEffect(() => {
    let pointerX = 0,
      pointerY = 0,
      x = 0,
      y = 0,
      raf = 0;
    const onPointer = (e: PointerEvent) => {
      pointerX = (e.clientX / Math.max(1, innerWidth) - 0.5) * 2;
      pointerY = (e.clientY / Math.max(1, innerHeight) - 0.5) * 2;
    };
    addEventListener('pointermove', onPointer, { passive: true });
    const tick = () => {
      const gaze = eyeContact.gaze();
      const tx = gaze ? gaze.x : pointerX * 0.55;
      const ty = gaze ? -gaze.y : pointerY * 0.45;
      x += (tx - x) * 0.055;
      y += (ty - y) * 0.055;
      if (isStagedScene(useStore.getState().bgUrl)) {
        if (matteRef.current) matteRef.current.style.transform = 'none';
        // The ground and actor stay registered; only the extracted near object moves.
        raf = requestAnimationFrame(tick);
        return;
      }
      const matte = matteRef.current;
      const foreground = foregroundRef.current;
      if (matte)
        matte.style.transform = `translate3d(${(-x * 4).toFixed(2)}px, ${(-y * 2.5).toFixed(2)}px, 0) scale(1.018)`;
      if (foreground)
        foreground.style.transform = `translate3d(${(x * 7).toFixed(2)}px, ${(y * 4.5).toFixed(2)}px, 0) scale(1.026)`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('pointermove', onPointer);
    };
  }, []);
  useEffect(() => {
    if (!overlay || overlay.sceneKey !== bgKey) {
      setShown((s) => (s ? { ...s, out: true } : s));
      return;
    }
    setShown({ url: overlay.url, out: false });
    const t = window.setTimeout(
      () => setShown((s) => (s?.url === overlay.url ? { ...s, out: true } : s)),
      Math.max(0, overlay.until - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [overlay, bgKey]);
  useEffect(() => {
    if (!shown?.out) return;
    const t = window.setTimeout(() => setShown((s) => (s?.out ? null : s)), 1200);
    return () => window.clearTimeout(t);
  }, [shown?.out]);
  const scale = Math.max(size.width / natural.width, size.height / natural.height);
  const w = natural.width * scale,
    h = natural.height * scale;
  const frame = companionFrame(size.width, size.height, layoutFromUrl(url));
  const style = isStagedScene(url)
    ? { width: frame.width, height: frame.height, left: frame.left, top: frame.top }
    : { width: w, height: h, left: (size.width - w) / 2, top: (size.height - h) / 2 };
  const dim = { filter: `brightness(${1 - fx.dim * 0.22})` };
  const ovClass = `overlay-img${shown?.out ? ' out' : ''}`;
  return (
    <>
      <div ref={matteRef} className="room-matte" style={dim} aria-hidden="true">
        <img
          key={url}
          style={style}
          src={url}
          alt=""
          onLoad={(e) => {
            setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight });
          }}
        />
        {cafe && <div className="window-rain" style={{ ...style, opacity: Math.min(0.42, fx.rain * 0.22) }} />}
        {shown && <img key={`ov-${shown.url}`} style={style} src={shown.url} alt="" className={ovClass} />}
      </div>
      <div className={`scene-depth-haze${cafe ? ' cafe' : ''}`} aria-hidden="true" />
      {/* Only the cafe has a source-aligned object mask. Outdoor JPEG plates
          contain opaque ground, so compositing them above the actor erases legs. */}
      {cafe && (
        <div ref={foregroundRef} className="room-foreground" style={dim} aria-hidden="true">
          <img style={style} src={CAFE_SOURCE} alt="" className="fg-matted" />
          {shown && <img style={style} src={shown.url} alt="" className={`fg-matted ${ovClass}`} />}
        </div>
      )}
    </>
  );
}
