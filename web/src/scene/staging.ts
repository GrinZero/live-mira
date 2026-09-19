// 每场景站位/取景表：把角色"放进"画面而不是贴在镜头前。
// 咖啡馆是坐姿中景（下半身被前景桌台裁掉）；室外是站姿远景——
// 相机拉远到全身、脚落在画面下缘、接触阴影把她压在地面上。
export interface SceneStaging {
  groundY: number; // placement 组基准 y
  standing: boolean; // 室外站姿；咖啡馆坐姿构图
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
  distance: { portrait: 3.2, landscape: 3.05 },
  lookY: 0.88,
  actorX: { portrait: 0.33, landscape: 0.3 },
  shadow: 0.5,
};

export function stagingFor(bgKey: string): SceneStaging {
  return bgKey === 'cafe_interior' ? CAFE : OUTSIDE;
}
