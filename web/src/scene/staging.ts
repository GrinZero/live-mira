import { isCafeMatte, isStagedScene } from '../../../shared/scene-layout';
// 每场景站位/取景表：把角色"放进"画面而不是贴在镜头前。
// 咖啡馆保持桌边中景；其余场景使用近距离陪伴取景。
// 已校准图片由 companionFrame 同步裁切背景与人物。
export interface SceneStaging {
  groundY: number; // placement 组基准 y
  standing: boolean; // 场景默认姿态，与镜头远近独立
  distance: { portrait: number; landscape: number };
  lookY: number; // 相机注视/机身高度（水平视角取景）
  actorX: { portrait: number; landscape: number };
  shadow: number; // 接触阴影不透明度基准
}

const CAFE: SceneStaging = {
  groundY: -0.26,
  standing: false,
  distance: { portrait: 1.85, landscape: 1.55 },
  lookY: 1.06,
  actorX: { portrait: 0.39, landscape: 0.34 },
  shadow: 0.18,
};

const OUTSIDE: SceneStaging = {
  groundY: -0.18,
  standing: true,
  distance: { portrait: 1.85, landscape: 1.55 },
  lookY: 1.22,
  actorX: { portrait: 0.33, landscape: 0.3 },
  shadow: 0.5,
};

// An unknown photograph has no known ground plane. Use a close-up with feet out
// of frame, rather than pretending every non-cafe location is the same street.
const UNCALIBRATED: SceneStaging = { ...CAFE, standing: true, groundY: -0.18, lookY: 1.22, shadow: 0 };

export function stagingFor(bgKey: string, bgUrl?: string): SceneStaging {
  if (bgUrl ? isCafeMatte(bgUrl) : bgKey === 'cafe_interior') return CAFE;
  return bgUrl && isStagedScene(bgUrl) ? OUTSIDE : UNCALIBRATED;
}
