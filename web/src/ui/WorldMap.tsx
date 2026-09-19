import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { WorldLocation, WorldView } from '../../../shared/world';
import './world-map.css';

export interface WorldMapProps {
  world: WorldView | null;
  onTravel: (id: string) => void;
  onOpenChange: (open: boolean) => void;
  onCancel: () => void;
  disabled?: boolean;
}

type Point = { x: number; y: number };
type Camera = Point & { zoom: number };
const clampZoom = (value: number) => Math.min(2.5, Math.max(0.25, value));

function LocationArtwork({ location }: { location: WorldLocation }) {
  const [failed, setFailed] = useState<string[]>([]);
  const artwork = location.mapStatus === 'ready' && location.mapUrl && !failed.includes(location.mapUrl);
  const src = artwork ? location.mapUrl : location.url;
  const available = src && !failed.includes(src);
  return (
    <div className={`world-map-art ${artwork ? 'is-map' : 'is-photo'}`}>
      {available ? (
        <img
          src={src}
          alt={artwork ? `${location.name}的地图绘景` : `${location.name}的场景照片`}
          draggable={false}
          onError={() => setFailed((urls) => [...urls, src])}
        />
      ) : (
        <span className="world-map-no-image">暂无可用影像</span>
      )}
      {!artwork && (
        <small className="world-map-art-note">
          {location.mapStatus === 'pending' ? '地图绘景准备中' : '地图绘景暂不可用'}
          {available ? ' · 暂用场景照片' : ''}
        </small>
      )}
    </div>
  );
}

export function WorldMap({ world, onTravel, onOpenChange, onCancel, disabled = false }: WorldMapProps) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const dragged = useRef(false);
  const gestureDistance = useRef(0);
  const titleId = useId();
  const hintId = useId();
  const locations = (world?.locations ?? []).filter((location) => location.visits > 0);
  const current = locations.find((location) => location.id === world?.currentLocationId);
  const selected = locations.find((location) => location.id === selectedId) ?? current;
  // Keep the supplied geography intact, including negative coordinates. Small grid units
  // are expanded uniformly so adjacent regions remain independently selectable.
  let nearest = Infinity;
  for (let i = 0; i < locations.length; i++) {
    for (let j = i + 1; j < locations.length; j++) {
      const distance = Math.hypot(locations[i].x - locations[j].x, locations[i].y - locations[j].y);
      if (distance > 0) nearest = Math.min(nearest, distance);
    }
  }
  const unit = Number.isFinite(nearest) ? Math.max(1, 330 / nearest) : 1;
  const position = (location: WorldLocation): Point => ({
    x: Number.isFinite(location.x) ? location.x * unit : 0,
    y: Number.isFinite(location.y) ? location.y * unit : 0,
  });
  const center = (location?: WorldLocation) => {
    const point = location ? position(location) : { x: 0, y: 0 };
    setCamera({ x: -point.x, y: -point.y, zoom: 1 });
  };
  const fit = () => {
    const viewport = viewportRef.current;
    if (!viewport || !locations.length) return;
    const points = locations.map(position);
    const left = Math.min(...points.map((point) => point.x)) - 150;
    const right = Math.max(...points.map((point) => point.x)) + 150;
    const top = Math.min(...points.map((point) => point.y)) - 140;
    const bottom = Math.max(...points.map((point) => point.y)) + 140;
    const zoom = clampZoom(
      Math.min((viewport.clientWidth - 32) / (right - left), (viewport.clientHeight - 32) / (bottom - top), 1),
    );
    setCamera({ x: (-(left + right) / 2) * zoom, y: (-(top + bottom) / 2) * zoom, zoom });
  };
  const changeOpen = (value: boolean) => {
    setOpen(value);
    onOpenChange(value);
    if (value) {
      setSelectedId(current?.id ?? locations[0]?.id ?? null);
      center(current ?? locations[0]);
    }
  };
  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement;
    const activePointers = pointers.current;
    const opener = openerRef.current;
    dialog.showModal();
    fit();
    return () => {
      dialog.close();
      activePointers.clear();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      else opener?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      const x = event.clientX - bounds.left - bounds.width / 2;
      const y = event.clientY - bounds.top - bounds.height / 2;
      setCamera((old) => {
        const zoom = clampZoom(old.zoom * Math.exp(-event.deltaY * 0.002));
        const ratio = zoom / old.zoom;
        return { x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio, zoom };
      });
    };
    viewport.addEventListener('wheel', wheel, { passive: false });
    return () => viewport.removeEventListener('wheel', wheel);
  }, [open]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!open || !viewport || !locations.length) return;
    const frame = requestAnimationFrame(fit);
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [open, world?.id, locations.length]);
  const zoomBy = (factor: number) =>
    setCamera((old) => {
      const zoom = clampZoom(old.zoom * factor);
      return { x: (old.x * zoom) / old.zoom, y: (old.y * zoom) / old.zoom, zoom };
    });
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!pointers.current.size) {
      dragged.current = false;
      gestureDistance.current = 0;
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    // Capture on the hit element so a stationary marker tap retains its click target.
    (event.target as Element).setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.current.values()];
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const after = [...pointers.current.values()];
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    gestureDistance.current += Math.hypot(dx, dy);
    if (gestureDistance.current > 5 || after.length > 1) dragged.current = true;
    if (after.length === 1) setCamera((old) => ({ ...old, x: old.x + dx, y: old.y + dy }));
    else if (after.length === 2) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const midpoint = (points: Point[]) => ({
        x: (points[0].x + points[1].x) / 2 - bounds.left - bounds.width / 2,
        y: (points[0].y + points[1].y) / 2 - bounds.top - bounds.height / 2,
      });
      const a = midpoint(before),
        b = midpoint(after);
      const distance = (points: Point[]) => Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const ratio = distance(after) / Math.max(1, distance(before));
      setCamera((old) => {
        const zoom = clampZoom(old.zoom * ratio);
        return { x: b.x - ((a.x - old.x) * zoom) / old.zoom, y: b.y - ((a.y - old.y) * zoom) / old.zoom, zoom };
      });
    }
  };
  const pointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
  };
  return (
    <>
      <button
        ref={openerRef}
        type="button"
        className="world-map-opener"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={titleId + '-dialog'}
        onClick={() => changeOpen(true)}
      >
        <span aria-hidden="true" className="world-map-lamp" />
        <span>
          <small>走过的地方</small>
          <strong>{current?.name ?? '雨夜地图'}</strong>
        </span>
        <span aria-hidden="true">↗</span>
      </button>
      {open && (
        <dialog
          ref={dialogRef}
          id={titleId + '-dialog'}
          className="world-map-dialog"
          aria-labelledby={titleId}
          aria-describedby={hintId}
          onCancel={(event) => {
            event.preventDefault();
            changeOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              changeOpen(false);
            }
            if (event.key !== 'Tab') return;
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
            ];
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }}
        >
          <header className="world-map-header">
            <div>
              <p>雨夜 · 足迹</p>
              <h2 id={titleId}>走过的地方</h2>
            </div>
            <button type="button" autoFocus onClick={() => changeOpen(false)} aria-label="关闭地图">
              收起 ×
            </button>
          </header>
          <p id={hintId} className="world-map-hint">
            已走过 {locations.length} 个地方。拖动或缩放地图，点击亮起的地点返回。
          </p>
          {world?.travel && (
            <div className="world-map-travel-state">
              <p role="status">
                {world.travel.status === 'preparing' ? '正在准备前往' : '已准备好前往'}
                {locations.find((location) => location.id === world.travel?.targetId)?.name ?? '目的地'}…
              </p>
              <button type="button" onClick={onCancel}>
                取消行程
              </button>
            </div>
          )}
          <div className="world-map-body">
            <div className="world-map-chart">
              <div
                ref={viewportRef}
                className="world-map-viewport"
                role="group"
                aria-label="已到访地点地图"
                tabIndex={0}
                onPointerDown={pointerDown}
                onPointerMove={pointerMove}
                onPointerUp={pointerEnd}
                onPointerCancel={pointerEnd}
                onLostPointerCapture={pointerEnd}
                onClickCapture={(event) => {
                  if (dragged.current && event.detail !== 0) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  const moves: Record<string, Point> = {
                    ArrowLeft: { x: 60, y: 0 },
                    ArrowRight: { x: -60, y: 0 },
                    ArrowUp: { x: 0, y: 60 },
                    ArrowDown: { x: 0, y: -60 },
                  };
                  if (moves[event.key]) {
                    event.preventDefault();
                    const move = moves[event.key];
                    setCamera((old) => ({ ...old, x: old.x + move.x, y: old.y + move.y }));
                  }
                  if (event.key === '+' || event.key === '=') {
                    event.preventDefault();
                    zoomBy(1.25);
                  }
                  if (event.key === '-') {
                    event.preventDefault();
                    zoomBy(0.8);
                  }
                  if (event.key === 'Home') {
                    event.preventDefault();
                    center(current);
                  }
                }}
              >
                {!locations.length && (
                  <div className="world-map-empty">
                    {world ? '正在记录当前位置' : '正在连接这次相遇的地图'}
                    <small>地点数据还没有同步。连接恢复后会显示已到访的区域。</small>
                    <button type="button" onClick={() => onOpenChange(true)}>
                      重新同步地图
                    </button>
                  </div>
                )}
                <div
                  className="world-map-plane"
                  style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
                >
                  <svg className="world-map-routes" aria-hidden="true">
                    {world?.connections.map((edge) => {
                      const from = locations.find((location) => location.id === edge.from);
                      const to = locations.find((location) => location.id === edge.to);
                      if (!from || !to) return null;
                      const a = position(from),
                        b = position(to);
                      return <line key={`${edge.from}:${edge.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
                    })}
                  </svg>
                  {locations.map((location) => {
                    const point = position(location);
                    return (
                      <button
                        type="button"
                        key={location.id}
                        className="world-map-region"
                        style={{ left: point.x, top: point.y }}
                        aria-pressed={selected?.id === location.id}
                        aria-label={`${location.name}${current?.id === location.id ? '，当前位置' : ''}，查看地点`}
                        onClick={() => setSelectedId(location.id)}
                      >
                        <LocationArtwork location={location} />
                        <strong>{location.name}</strong>
                        {current?.id === location.id && <span className="world-map-current">● 你在这里</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
              {!!locations.length && (
                <div className="world-map-tools" aria-label="地图视图控制">
                  <button
                    type="button"
                    onClick={() => zoomBy(0.8)}
                    disabled={camera.zoom <= 0.25}
                    aria-label="缩小地图"
                  >
                    −
                  </button>
                  <output aria-label="地图缩放比例">{Math.round(camera.zoom * 100)}%</output>
                  <button
                    type="button"
                    onClick={() => zoomBy(1.25)}
                    disabled={camera.zoom >= 2.5}
                    aria-label="放大地图"
                  >
                    ＋
                  </button>
                  <button type="button" onClick={fit}>
                    全览
                  </button>
                  <button type="button" onClick={() => center(current)} disabled={!current}>
                    当前位置
                  </button>
                </div>
              )}
            </div>
            <aside className="world-map-sidebar" aria-label="地点详情与足迹">
              {selected && (
                <section className="world-map-preview" aria-label="选中地点">
                  <LocationArtwork key={selected.id} location={selected} />
                  <h3>{selected.name}</h3>
                  <p>
                    {
                      selected.description
                        .replace(/^目的地[（(].*?[）)]的环境[：:]\s*/, '')
                        .split(/。镜头|。延续时间天气/)[0]
                    }
                  </p>
                  <small>
                    已到访 {selected.visits} 次{selected.id === current?.id ? ' · 当前位置' : ''}
                  </small>
                  <button
                    type="button"
                    className="world-map-travel"
                    disabled={disabled || !!world?.travel || selected.id === current?.id}
                    onClick={() => onTravel(selected.id)}
                  >
                    {selected.id === current?.id ? '此刻在这里' : `回到${selected.name}`}
                  </button>
                  {disabled && !world?.travel && <small>暂时无法出发，仍可查看地图。</small>}
                </section>
              )}
              {!!locations.length && (
                <nav className="world-map-visited" aria-label="已到访地点列表">
                  <h3>留下的足迹</h3>
                  <ul>
                    {locations.map((location) => (
                      <li key={location.id}>
                        <button
                          type="button"
                          aria-pressed={selected?.id === location.id}
                          onClick={() => {
                            setSelectedId(location.id);
                            center(location);
                          }}
                        >
                          <span>{location.name}</span>
                          <small>{location.id === current?.id ? '你在这里' : `${location.visits} 次到访`}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
            </aside>
          </div>
        </dialog>
      )}
    </>
  );
}
