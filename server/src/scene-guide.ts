import type { ForegroundPlan } from '../../shared/foreground-layout.js';
import sharp from 'sharp';
import { SCENE_LAYOUT, type SceneLayout } from '../../shared/scene-layout.js';

// This is a machine-readable composition reference, not a generated background.
// The rectangle and the renderer both use the same source-space layout.
export async function sceneGuide(s: SceneLayout = SCENE_LAYOUT, foreground?: ForegroundPlan | null): Promise<Buffer> {
  const x = s.width * s.x;
  const foot = s.height * s.footY;
  const head = foot - s.height * s.actorHeight;
  const halfWidth = s.width * 0.08;
  const horizon = s.height * 0.35;
  const rays = [-1500, -500, 500, 1500, 2500, 3500, 4500]
    .map((edge) => `<path d="M ${s.width * 0.65} ${horizon} L ${edge} ${s.height}"/>`)
    .join('');
  const rows = [0.5, 0.59, 0.72, 0.9].map((y) => `<path d="M 0 ${s.height * y} H ${s.width}"/>`).join('');
  return sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}">
    <rect width="100%" height="100%" fill="#737985"/>
    <rect y="${horizon}" width="100%" height="${s.height - horizon}" fill="#414751"/>
    ${
      foreground
        ? `<rect x="${(foreground.postX - foreground.postWidth / 2) * s.width}" width="${foreground.postWidth * s.width}" height="${s.height}" fill="#00caca" fill-opacity="0.5" stroke="#00ffff" stroke-width="6"/>
    <rect x="${foreground.side === 'right' ? foreground.postX * s.width : 0}" width="${(foreground.side === 'right' ? 1 - foreground.postX : foreground.postX) * s.width}" height="${foreground.eaveY * s.height}" fill="#00caca" fill-opacity="0.5"/>`
        : ''
    }
    <g stroke="#818995" stroke-width="3" fill="none">${rays}${rows}</g>
    <path d="M 0 ${horizon} H ${s.width}" stroke="#bcc4cf" stroke-width="4"/>
    <rect x="${x - halfWidth}" y="${head}" width="${halfWidth * 2}" height="${foot - head}"
      fill="#ff00aa" fill-opacity="0.18" stroke="#ff00aa" stroke-width="10"/>
  </svg>`),
  )
    .png()
    .toBuffer();
}

export const GUIDE_INSTRUCTION =
  '输入图是空间布局草图，不是成品的画风参考。紫红色矩形框是必须预留的合成净空区，框底边的中点是地面接触锚点；保持它们在画幅内的位置、尺度和透视关系，占位框高度为画幅60%，供近距离全身角色使用，不能缩成远处小人；环境物件的大小应与框内约1.65米高的角色协调。框内仍画连续自然的背景与地面，但不能有家具、树干、栏杆等遮挡。灰色块和网格仅代表空间关系。以主题要求的真实场景完整替换草图，最终成品必须擦除所有色框、色块、网格和辅助线，不画人或人体局部。';
