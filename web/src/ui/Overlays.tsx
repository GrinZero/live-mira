import { useEffect, useState } from 'react';
import { useStore } from '../state/store';

// 状态灯：待机/倾听/思考/说话 可见
const PHASE_LABEL: Record<string, string> = {
  boot: '连接中',
  idle: '待机',
  listening: '倾听',
  thinking: '思考',
  speaking: '说话',
  reconnecting: '重连中',
};

export function StatePill() {
  const phase = useStore((s) => s.phase);
  return (
    <div className={`state-pill ${phase}`}>
      <span className="dot" />
      {PHASE_LABEL[phase] ?? phase}
    </div>
  );
}

// 生成中提示："显影中…"——生成式媒体的进行中状态
export function GeneratingChip() {
  const generating = useStore((s) => s.generating);
  if (!generating.length) return null;
  const g = generating[0];
  return (
    <div className="genchip">
      <span className="shimmer" />
      {g.purpose === 'moment' ? '再看清一点' : g.kind === 'photo' ? '照片显影中' : '正在走近'}…
    </div>
  );
}

// "掏照片"：宝丽来卡片，显影式浮现
export function PhotoCard() {
  const photo = useStore((s) => s.photo);
  useEffect(() => {
    if (!photo) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useStore.getState().set({ photo: null });
    };
    addEventListener('keydown', close);
    return () => removeEventListener('keydown', close);
  }, [photo]);
  if (!photo) return null;
  return (
    <section className="photo-card" aria-label="一起看照片">
      <div className="photo-frame">
        <img src={photo.url} alt={photo.caption || 'Mira 展示的照片'} />
        {photo.caption && <div className="photo-caption">{photo.caption}</div>}
        <button className="photo-close" onClick={() => useStore.getState().set({ photo: null })}>
          看好了，放回去 ↙
        </button>
      </div>
    </section>
  );
}

// 闪电视觉层
export function Flash() {
  const lightning = useStore((s) => s.fx.lightning);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (lightning > 0) {
      setActive(true);
      const t = setTimeout(() => setActive(false), 950);
      return () => clearTimeout(t);
    }
  }, [lightning]);
  return <div className={`flash ${active ? 'on' : ''}`} />;
}

// 调试面板：事件日志 + 延迟观测（?debug=1 或角落按钮）
export function DebugPanel() {
  const logs = useStore((s) => s.logs);
  const phase = useStore((s) => s.phase);
  const sessionId = useStore((s) => s.sessionId);
  const open = useStore((s) => s.debugOpen);
  if (!open) return null;
  return (
    <div className="debug-panel">
      <div className="debug-row">
        phase={phase} sid={sessionId.slice(0, 14)}
      </div>
      <div className="debug-log">
        {logs.slice(-60).map((l, i) => (
          <div key={i} className={`logline ${l.cat}`}>
            <span className="lt">{new Date(l.ts).toISOString().slice(17, 23)}</span>
            <span className="lc">{l.cat}</span> {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// 暗角 + 胶片颗粒（CSS 层，便宜稳定）
export function PostFx() {
  return (
    <>
      <div className="vignette" />
      <div className="grain" />
    </>
  );
}
