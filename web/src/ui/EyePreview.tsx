import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { eyeContact } from '../vision/eyeContact';

// 摄像头预览：展开后看到"她眼里的你"——本机画面 + 追踪锚点圈。
// 预览与隐藏检测元素共用同一 MediaStream，画面不出浏览器；显示做水平镜像，符合看自己的直觉。
export function EyePreview() {
  const eye = useStore((s) => s.eye);
  const tracking = useStore((s) => s.eyeTracking);
  const [open, setOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 一条 MediaStream 可同时喂多个 <video>；关掉追踪/收起时释放引用
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const s = open && eye === 'on' ? (eyeContact.getStream() ?? null) : null;
    if (v.srcObject !== s) v.srcObject = s;
    if (s) void v.play().catch(() => {});
  }, [open, eye]);

  // 锚点圈 rAF 直读 probe()：不进 store，不触发 React 渲染
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const draw = () => {
      const cv = canvasRef.current;
      if (cv) {
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth,
          h = cv.clientHeight;
        if (w && h) {
          const pw = Math.round(w * dpr),
            ph = Math.round(h * dpr);
          if (cv.width !== pw || cv.height !== ph) {
            cv.width = pw;
            cv.height = ph;
          }
          const ctx = cv.getContext('2d');
          if (ctx) {
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, w, h);
            const p = eyeContact.probe();
            if (p) {
              // 画面已镜像：原图 x → 显示 x = 1 - x；锚点取眼线高度，圈住整张脸
              const x = (1 - p.cx) * w,
                y = p.cy * h;
              const r = Math.max(p.w, p.h) * 0.62 * w;
              ctx.lineWidth = 2;
              ctx.strokeStyle = 'rgba(255, 179, 92, 0.95)';
              ctx.beginPath();
              ctx.arc(x, y, r, 0, Math.PI * 2);
              ctx.stroke();
              // 短射线 = 她判断你正在看的方向（你向左看，射线朝画面左）
              const dx = p.gx,
                dy = -p.gy;
              if (dx || dy) {
                const len = (r * 1.35) / (Math.hypot(dx, dy) || 1);
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x + dx * len, y + dy * len);
                ctx.stroke();
              }
              ctx.fillStyle = 'rgba(255, 179, 92, 0.95)';
              ctx.beginPath();
              ctx.arc(x, y, 2.5, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (eye !== 'on') return null;
  return (
    <div className="eye-preview">
      <button
        className={`eye-preview-btn ${open ? 'open' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title="展开本机画面：圈是她盯着的点，画面只在本机不上传"
      >
        {open ? '收起' : '看自己'}
      </button>
      {open && (
        <div className="cam-panel" onClick={(e) => e.stopPropagation()}>
          <div className="cam-view">
            <video ref={videoRef} muted playsInline autoPlay className="cam-video" />
            <canvas ref={canvasRef} className="cam-canvas" />
          </div>
          <div className="cam-status">{tracking ? '圈里是她盯着的点 · 已镜像' : '找不到你的脸'}</div>
        </div>
      )}
    </div>
  );
}
