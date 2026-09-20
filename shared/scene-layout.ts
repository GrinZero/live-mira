// Source-image coordinates shared by generation, background crop and VRM camera.
export const SCENE_LAYOUT = { width: 2560, height: 1440, x: 0.4, footY: 0.8, actorHeight: 0.6 };
export type SceneLayout = typeof SCENE_LAYOUT;

// Reviewed calibration for the persisted cafe-photo scene. Its generated guide
// (304, 830) lands on the table, so it must not override this asset-specific fix.
const CAFE_PHOTO_LAYOUT: SceneLayout = { ...SCENE_LAYOUT, x: 0.69, footY: 0.87, actorHeight: 0.64 };
const CAFE_PHOTO_ASSETS = [
  '4e03031463d164b2fb5da70f7e1fb0bd4894e244b744d520af71fe2ad11db7b7.jpg',
  'scene_69187971_5f40890616_stage3_304_830.jpg',
];

export function isCafeMatte(url: string): boolean {
  const file = url.split(/[?#]/)[0].split('/').pop();
  return (
    file === 'cafe_interior.jpg' || file === '8920a2e85a323e979948ea2aa36d6c0f8bcdd66f894b4e457d4975caf2818768.jpg'
  );
}

export function isCafeEnvironment(url: string): boolean {
  return isCafeMatte(url) || CAFE_PHOTO_ASSETS.includes(url.split(/[?#]/)[0].split('/').pop() ?? '');
}

export function randomSceneLayout(random = Math.random): SceneLayout {
  return {
    ...SCENE_LAYOUT,
    x: Math.round((0.25 + random() * 0.5) * 1000) / 1000,
    footY: Math.round((0.74 + random() * 0.1) * 1000) / 1000,
  };
}

export function layoutToken(s: SceneLayout): string {
  return `stage3_${Math.round(s.x * 1000)}_${Math.round(s.footY * 1000)}`;
}

export function layoutFromUrl(url: string): SceneLayout | null {
  if (CAFE_PHOTO_ASSETS.includes(url.split(/[?#]/)[0].split('/').pop() ?? '')) return { ...CAFE_PHOTO_LAYOUT };
  const match = url.match(/(?:_|[?&]layout=)stage3_(\d{3})_(\d{3})(?:_|[.&]|$)/);
  if (!match) return null;
  const x = Number(match[1]) / 1000,
    footY = Number(match[2]) / 1000;
  return x >= 0.25 && x <= 0.75 && footY >= 0.74 && footY <= 0.84 ? { ...SCENE_LAYOUT, x, footY } : null;
}

export const isStagedScene = (url: string) =>
  !!layoutFromUrl(url) || url.includes('_stage2_') || /[?&]layout=stage2(?:&|$)/.test(url);

export function sceneFrame(width: number, height: number, layout?: SceneLayout | null) {
  const s = layout ?? SCENE_LAYOUT;
  const scale = Math.max(width / s.width, height / s.height);
  const w = s.width * scale;
  const h = s.height * scale;
  // A full-body safety envelope (including relaxed arms) in viewport pixels.
  const actorHeight = (h * s.actorHeight) / height;
  const halfActorWidth = Math.min(0.45, (height * actorHeight * 0.22) / width + 0.04);
  const screenX = layout ? Math.max(halfActorWidth, Math.min(1 - halfActorWidth, s.x)) : 0.35;
  const left = Math.max(width - w, Math.min(0, width * screenX - w * s.x));
  const top = Math.max(height - h, Math.min(0, height * (layout ? s.footY : 0.82) - h * s.footY));
  return {
    width: w,
    height: h,
    left,
    top,
    actorX: (left + w * s.x) / width,
    footY: (top + h * s.footY) / height,
    actorHeight,
  };
}

// Close companion framing. Zoom the photograph and actor together so doors and
// furniture keep the same scale; the calibrated ground lies below the crop.
export function companionFrame(width: number, height: number, layout?: SceneLayout | null) {
  const s = layout ?? SCENE_LAYOUT;
  const scale = Math.max(width / s.width, height / s.height, (height * 1.65) / (s.height * s.actorHeight));
  const w = s.width * scale,
    h = s.height * scale;
  const actorHeight = (h * s.actorHeight) / height;
  const screenX = width / height < 0.9 ? 0.5 : 0.42;
  const left = Math.max(width - w, Math.min(0, width * screenX - w * s.x));
  const top = Math.max(height - h, Math.min(0, height * 0.04 - h * (s.footY - s.actorHeight)));
  return {
    width: w,
    height: h,
    left,
    top,
    actorX: (left + w * s.x) / width,
    footY: (top + h * s.footY) / height,
    actorHeight,
  };
}

export function sceneLayoutPrompt(s: SceneLayout = SCENE_LAYOUT) {
  return `横向16:9的无人环境空镜。构图约束：图宽${s.x * 100}%、图高${s.footY * 100}%处为地面锚点，该点及周围必须是连贯、平整、没有障碍的步道或地板。锚点向上${s.actorHeight * 100}%图高、左右各8%图宽的区域保持开阔，家具和植物放在这个区域之外。这是近距离陪伴场景，预留区用于近景主体，不能做远景小人构图，附近桌椅、门窗与路灯必须遵循这个尺度。镜头水平，地平线位于图高35%左右，禁止仰拍、俯拍或贴地镜头。画面仅有环境、建筑与地面，绝对没有人、人体局部、腿、鞋、剪影或第一人称身体。地面纹理和光照连续经过锚点，不绘制锚点符号或标记，画面铺满，无拼贴、白边、文字或UI。`;
}
