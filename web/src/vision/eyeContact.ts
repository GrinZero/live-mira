import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { useStore } from '../state/store';

// 对视：摄像头 + MediaPipe FaceLandmarker 本地推理（画面不出浏览器）。
// 输出两件事：
//   1) 用户脸相对设备前方的"角偏移 + 距离"（视场角换算，非线性近似）——她在物理上该看哪
//   2) 用户视线方向（eyeLook* blendshape + 鼻尖相对脸中心的头转线索）——你正在看哪
// 约 15fps 低分辨率检测；找不到脸不更新，sample 自然过期 → 视线回落默认。

export type EyeState = 'off' | 'starting' | 'on' | 'denied' | 'unsupported' | 'error';

export interface GazeSample {
  x: number; // 人脸相对视场中心的水平角偏移，-1..1（±1=±半视场），+ = 屏幕右
  y: number; // 垂直角偏移 -1..1，+ = 偏上（对准眼线，非脸中心）
  dist: number; // 估计距离（米）：脸高占画面比例 × 视场角反推
  gx: number; // 用户视线方向 -1..1：+x 屏幕右、+y 屏幕上；≈0 = 正眼看屏幕（看着她）
  gy: number;
  at: number; // performance.now()；超过 FRESH_MS 视为丢失
}

// 预览面板的锚点：原始图像坐标（未镜像），配合镜像显示时 x 需翻成 1-cx
export interface FaceProbe {
  cx: number;
  cy: number; // 追踪锚点：脸框中心 x + 眼线高度 y
  w: number;
  h: number; // 脸框宽/高
  gx: number;
  gy: number; // 平滑后的视线偏移（与 GazeSample 同源）
}

const FRESH_MS = 600;
// 前置摄像头典型视场角（4:3）：水平 ~62°、垂直 ~48°；脸高（发际-下巴）≈0.21m
export const CAM_HFOV = (62 * Math.PI) / 180;
export const CAM_VFOV = (48 * Math.PI) / 180;
const FACE_H_M = 0.21;
// 用户视线方向死区：小于这个值当她"正眼看着你"，避免眼珠微颤
const GAZE_DEADZONE = 0.07;

class EyeContact {
  state: EyeState = 'off';
  private sample: GazeSample = { x: 0, y: 0, dist: 0.55, gx: 0, gy: 0, at: -Infinity };
  private sm = { x: 0, y: 0, dist: 0.55, gx: 0, gy: 0 }; // EMA 平滑值，吃 landmark 抖动
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private proc?: HTMLCanvasElement;
  private procCtx?: CanvasRenderingContext2D;
  private lm?: FaceLandmarker;
  private landmarkerP?: Promise<FaceLandmarker>;
  private timer = 0;
  private gen = 0;
  private debug = false;
  private mark = { cx: 0.5, cy: 0.5, w: 0, h: 0, gx: 0, gy: 0, at: -Infinity };

  private updateTracking() {
    const tracking = this.gaze() !== null;
    if (useStore.getState().eyeTracking !== tracking) useStore.setState({ eyeTracking: tracking });
  }

  private setState(s: EyeState) {
    this.state = s;
    useStore.setState({ eye: s });
    this.updateTracking();
  }

  private loadLandmarker() {
    this.landmarkerP ??= (async () => {
      const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task' },
        runningMode: 'VIDEO',
        numFaces: 1,
        // blendshapes 拿 eyeLook*（用户看哪）；不做表情驱动，不用 transformationMatrix
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
    })();
    // 加载失败（模型 404/断网）后允许重试：清掉 rejected promise
    this.landmarkerP.catch(() => {
      this.landmarkerP = undefined;
    });
    return this.landmarkerP;
  }

  async enable() {
    if (this.state === 'on' || this.state === 'starting') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setState('unsupported');
      throw new Error('camera unsupported');
    }
    this.setState('starting');
    this.debug = false;
    const gen = ++this.gen;
    try {
      const [stream, landmarker] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
          audio: false,
        }),
        this.loadLandmarker(),
      ]);
      if (gen !== this.gen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      } // await 间隙被 disable
      this.stream = stream;
      this.lm = landmarker;
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.autoplay = true;
      v.srcObject = stream;
      // iOS Safari 需要元素在 DOM 中才稳定出帧；永远不可见、不渲染画面
      v.style.cssText = 'position:fixed;left:-8px;top:-8px;width:2px;height:2px;opacity:.01;pointer-events:none';
      document.body.appendChild(v);
      this.video = v;
      await v.play();
      stream.getVideoTracks()[0]?.addEventListener('ended', () => this.disable());
      this.setState('on');
      this.timer = window.setInterval(() => {
        this.detect();
        this.updateTracking();
      }, 66);
    } catch (e) {
      this.release();
      this.setState((e as DOMException).name === 'NotAllowedError' ? 'denied' : 'error');
      throw e;
    }
  }

  disable() {
    this.debug = false;
    this.gen++;
    this.release();
    this.setState('off');
  }

  private release() {
    window.clearInterval(this.timer);
    this.sample.at = -Infinity;
    this.mark.at = -Infinity;
    this.sm = { x: 0, y: 0, dist: 0.55, gx: 0, gy: 0 };
    this.video?.remove();
    this.video = undefined;
    this.proc = undefined;
    this.procCtx = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
  }

  private detect() {
    const v = this.video,
      lm = this.lm;
    if (!v || !lm || this.debug || document.hidden || v.readyState < 2) return;
    // 隐藏 <video> 不进合成器：Chromium 对 getUserMedia 走零拷贝合成，
    // MediaPipe 直接 texImage2D(视频元素) 拿到的是黑帧（不报错、检测为空）。
    // 先 drawImage 落到 canvas——drawImage 有自己的取帧路径，不受合成状态影响。
    const c = (this.proc ??= document.createElement('canvas'));
    if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
    }
    const ctx = (this.procCtx ??= c.getContext('2d') ?? undefined);
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    let res;
    try {
      res = lm.detectForVideo(c, performance.now());
    } catch {
      return;
    } // 单帧失败忽略，下一帧再来
    const face = res.faceLandmarks?.[0];
    if (!face?.length) return;

    // --- 人脸位置：bbox + 眼线（33/263 = 左右外眼角，比 bbox 中心更接近"眼睛"）---
    let minX = 1,
      maxX = 0,
      minY = 1,
      maxY = 0;
    for (const p of face) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) / 2;
    const faceW = maxX - minX,
      faceH = maxY - minY;
    const eyeY = (face[33].y + face[263].y) / 2;
    // 距离：脸高张角 = fracH × vfov → dist = faceH_m / (2·tan(角/2))
    const dist = FACE_H_M / (2 * Math.tan((faceH * CAM_VFOV) / 2));

    // --- 用户视线方向 ---
    // 眼珠：ARKit eyeLook*——用户向其右看 = 左眼看向鼻(In_L)+右眼看向鬓(Out_R)
    const cats = res.faceBlendshapes?.[0]?.categories;
    const bs = new Map<string, number>();
    if (cats) for (const c of cats) bs.set(c.categoryName, c.score);
    const b = (n: string) => bs.get(n) ?? 0;
    const eyeX = (b('eyeLookInLeft') + b('eyeLookOutRight') - b('eyeLookOutLeft') - b('eyeLookInRight')) / 2;
    const eY = (b('eyeLookUpLeft') + b('eyeLookUpRight') - b('eyeLookDownLeft') - b('eyeLookDownRight')) / 2;
    // 头转：鼻尖相对脸中心的偏移（原始帧未镜像 → 翻成屏幕空间）
    const noseOffX = -(face[1].x - cx) / (faceW || 1);
    let gx = eyeX * 0.55 + noseOffX * 0.75;
    // 垂直跟随以眼线位置为主，不能把鼻尖天然低于眼睛当成持续低头。
    let gy = eY * 0.6;
    if (Math.abs(gx) < GAZE_DEADZONE) gx = 0;
    else gx *= 1.25;
    if (Math.abs(gy) < GAZE_DEADZONE) gy = 0;
    else gy *= 1.25;
    gx = Math.max(-1, Math.min(1, gx));
    gy = Math.max(-1, Math.min(1, gy));

    // --- EMA 平滑后落盘（α≈0.35：压抖动但保持跟手）---
    const s = this.sm,
      a = 0.35;
    s.x += (-(cx - 0.5) * 2 - s.x) * a;
    s.y += ((0.5 - eyeY) * 2 - s.y) * a;
    s.dist += (dist - s.dist) * a;
    s.gx += (gx - s.gx) * a;
    s.gy += (gy - s.gy) * a;
    this.sample = {
      x: Math.max(-1, Math.min(1, s.x)),
      y: Math.max(-1, Math.min(1, s.y)),
      dist: Math.max(0.2, Math.min(1.6, s.dist)),
      gx: s.gx,
      gy: s.gy,
      at: performance.now(),
    };
    this.mark = { cx, cy: eyeY, w: faceW, h: faceH, gx: s.gx, gy: s.gy, at: this.sample.at };
  }

  /** 当前有效注视样本；无脸/未开启返回 null */
  gaze(): GazeSample | null {
    if (this.state !== 'on') return null;
    return performance.now() - this.sample.at < FRESH_MS ? this.sample : null;
  }

  /** 预览面板：最新追踪锚点（原图坐标 0..1）；无脸/超时返回 null */
  probe(): FaceProbe | null {
    if (performance.now() - this.mark.at > FRESH_MS) return null;
    const { cx, cy, w, h, gx, gy } = this.mark;
    return { cx, cy, w, h, gx, gy };
  }

  /** 预览面板共享同一 MediaStream；只读，调用方不要 stop */
  getStream() {
    return this.stream;
  }

  /** 测试钩子：无摄像头环境注入样本，验证视线链路（stage-check / playwright 用） */
  inject(x: number, y: number, dist = 0.55, gx = 0, gy = 0) {
    this.debug = true;
    this.setState('on');
    this.sample = { x, y, dist, gx, gy, at: performance.now() };
    // 由角偏移反推近似图像坐标，让预览面板在无摄像头环境也能画圈
    this.mark = { cx: 0.5 - x / 2, cy: 0.5 - y / 2, w: 0.4, h: 0.5, gx, gy, at: this.sample.at };
    this.updateTracking();
  }
}

export const eyeContact = new EyeContact();
(window as unknown as { __eye?: EyeContact }).__eye = eyeContact;
