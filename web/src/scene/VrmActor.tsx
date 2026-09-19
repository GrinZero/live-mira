import { isStagedScene } from '../../../shared/scene-layout';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useLoader, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { useStore } from '../state/store';
import { SCENE_ARRIVE_MS, SCENE_DEPART_MS } from '../state/sceneTransition';
import { eyeContact, CAM_HFOV, CAM_VFOV } from '../vision/eyeContact';
import { EMOTION_MAP, EXPRESSION_PRESETS, type CharacterActor } from './actor';
import { stagingFor } from './staging';
import { useImageLighting } from './useImageLighting';
import type { ClientPhase, Emotion, Gesture, GazeTarget, HandAnchor, Motion } from '../../../shared/protocol';

// VrmActor：VRM 角色 + 程序化骨骼动作 + 情绪 expression + 振幅口型 + 眨眼/呼吸/视线
// 琥珀色"雨衣"通过打光色温呈现；程序化星星发夹挂在 head 骨上呼应人设。
// 姿态是原子槽位合成：手部空间锚点 × 躯干/头连续量 × 视线锚点，hold_ms 后整体回位。

// 每模型调校：VRM 0.x 模型面向 -Z 且骨骼局部轴向与 1.0 相反，按 extensions.VRM 判定
interface ModelTune {
  yaw: number;
  zSign: 1 | -1;
  hide?: RegExp;
}
function tuneFor(gltf: { parser?: { json?: { extensions?: Record<string, unknown> } } }): ModelTune {
  const isVrm0 = !!gltf.parser?.json?.extensions?.VRM;
  return isVrm0 ? { yaw: Math.PI, zSign: -1 } : { yaw: 0, zSign: 1 };
}

class VrmActorImpl implements CharacterActor {
  emotion: Emotion = 'neutral';
  phase: ClientPhase = 'idle';
  mouth = 0;
  private gestureStart = 0;
  private gestureDur = 0;
  private activeGesture: Gesture | null = null;
  private motionStart = 0;
  private motionDur = 0;
  private activeMotion: Motion | null = null;
  private journey: 'preparing' | 'departing' | 'arriving' | null = null;
  private journeyStart = 0;
  private standing = false;
  private baseStanding = false; // 场景默认站姿（室外），由 staging 表驱动
  private blinkTimer = 2.5;
  private blinkPhase = 0;
  // 音频驱动动作：能量包络 + 重音脉冲 → 弹簧积分出点头/侧头/歪头
  private speech = { level: 0, beat: 0, beatId: 0, strength: 0 };
  private prevBeatId = 0;
  private nod = 0;
  private nodVel = 0;
  private yaw = 0;
  private yawVel = 0;
  private tilt = 0;
  private tiltVel = 0;
  private phraseAcc = 0;
  private nextBeatAt = 0;
  private exprWeights: Record<string, number> = {};
  private boneHome = new Map<string, THREE.Euler>();
  private boneTarget = new Map<string, THREE.Euler>();
  private gazeObj = new THREE.Object3D();
  // 视线平滑 + 头部跟随（摄像头追踪）：眼先到位、头慢半拍
  private gazeCur = new THREE.Vector3(0.05, 1.35, 2.0);
  private gazeHead = { yaw: 0, pitch: 0, has: false };
  private static _f = new THREE.Vector3();
  private static _r = new THREE.Vector3();
  private static _u = new THREE.Vector3();
  private static _gp = new THREE.Vector3();

  constructor(
    private vrm: VRM,
    private star: THREE.Object3D,
    private tune: ModelTune,
    private camera: THREE.Camera,
  ) {
    const hum = vrm.humanoid;
    hum.resetNormalizedPose(); // HMR/remounts must not use an animated pose as the new rest pose.
    for (const name of [
      'head',
      'neck',
      'spine',
      'chest',
      'hips',
      'rightUpperArm',
      'rightLowerArm',
      'leftUpperArm',
      'leftLowerArm',
      'rightHand',
      'leftHand',
      'rightUpperLeg',
      'rightLowerLeg',
      'rightFoot',
      'leftUpperLeg',
      'leftLowerLeg',
      'leftFoot',
    ] as const) {
      const b = hum.getNormalizedBoneNode(name);
      if (b) this.boneHome.set(name, b.rotation.clone());
    }
    this.applyRest();
    this.star.visible = true;
    this.tintRaincoat();
    // 首帧即 rest 姿态：直接写骨骼/表情/视线，避免从 T-pose 阻尼滑入的怪动作
    for (const [name, home] of this.boneHome) {
      const b = hum.getNormalizedBoneNode(name as never);
      if (b) b.rotation.copy(home);
    }
    const em = vrm.expressionManager;
    if (em) {
      this.exprWeights = { ...EMOTION_MAP.neutral };
      for (const p of EXPRESSION_PRESETS) em.setValue(p, this.exprWeights[p] ?? 0);
    }
    if (vrm.lookAt) {
      this.gazeObj.position.copy(this.gazeTarget(0));
      this.gazeObj.updateMatrixWorld();
      vrm.lookAt.target = this.gazeObj;
    }
    vrm.update(0);
  }

  // 把上衣材质向琥珀色雨衣方向调（MToon color 为纹理乘色）
  private tintRaincoat() {
    this.vrm.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const name = (m as THREE.Material & { name?: string }).name ?? '';
        if (name === 'huku_bake' || name === 'F00_006_01_Tops_01_CLOTH') {
          const c = (m as THREE.MeshStandardMaterial).color;
          if (c) c.lerp(new THREE.Color('#d9a05b'), 0.35);
        }
      }
    });
  }

  // 静态姿态：放下手臂 + 肘微弯 + 手部自然垂落（VRM 默认 T-pose 需要松弛化）
  // 实测：右臂绕 Z 正转下落，左臂反之
  private applyRest() {
    const rest: Record<string, [number, number, number]> = {
      rightUpperArm: [0, 0, 1.15],
      leftUpperArm: [0, 0, -1.15],
      rightLowerArm: [0, 0, 0.18],
      leftLowerArm: [0, 0, -0.18],
      rightHand: [0, 0, 0.08],
      leftHand: [0, 0, -0.08],
    };
    for (const [name, [x, y, z]] of Object.entries(rest)) {
      const home = this.boneHome.get(name);
      if (home) this.boneHome.set(name, new THREE.Euler(home.x + x, home.y + y, home.z + z * this.tune.zSign));
    }
  }

  setEmotion(e: Emotion) {
    this.emotion = e;
  }
  setState(s: ClientPhase) {
    this.phase = s;
    // reset/reconnect can happen after the one-shot store command has already
    // been consumed. Clear runtime-owned performance state as well, otherwise
    // a dance/walk may keep playing for the rest of its duration after reset.
    if (s === 'idle' || s === 'reconnecting') {
      this.activeMotion = null;
      this.standing = false;
      this.clearGesture();
    }
  }
  setMouthOpen(v: number) {
    this.mouth = v;
  }
  setSpeech(s: { level: number; beat: number; beatId: number; strength: number }) {
    this.speech = s;
  }

  // 手部空间锚点 → 骨转目标（相对 rest 的偏移；存的是右侧值，左手镜像 = y/z 取反）
  // 每个锚点只管"手在身体哪里"，不携带语义：head_side 可以是撩发也可以是扶额。
  private static HAND_TARGETS: Record<
    Exclude<HandAnchor, 'rest'>,
    Record<'upperArm' | 'lowerArm', [number, number, number]>
  > = {
    head_side: { upperArm: [0.15, 0, -1.9], lowerArm: [0, 0, -1.6] },
    face: { upperArm: [0.3, 0.15, -1.5], lowerArm: [0.05, 0, -1.35] },
    chest: { upperArm: [0.55, 0.35, -0.5], lowerArm: [0.9, 0.5, 0] },
    lap: { upperArm: [0.15, 0.1, -0.75], lowerArm: [0.35, 0.25, 0] },
    table: { upperArm: [0.4, 0.05, -1.25], lowerArm: [0.5, 0.2, 0] },
    forward_low: { upperArm: [0.5, 0.25, -0.95], lowerArm: [0.55, 0.45, 0] },
    forward_eye: { upperArm: [0.5, 0.55, -0.9], lowerArm: [0.6, 0.7, 0] },
  };

  private static GAZE_POINTS: Record<Exclude<GazeTarget, 'user'>, THREE.Vector3> = {
    door: new THREE.Vector3(1.6, 1.25, -0.8), // 门口在画面右侧
    window: new THREE.Vector3(-1.3, 1.4, -0.6), // 雨窗在画面左侧
    down: new THREE.Vector3(0.1, 0.95, 1.4),
    prop: new THREE.Vector3(0.35, 1.15, 0.7), // 手中物（胸前偏前）
    away: new THREE.Vector3(-0.9, 1.5, 1.6),
  };

  private setBone(b: string, x: number, y: number, z: number) {
    this.boneTarget.set(b, new THREE.Euler(x, y, z * this.tune.zSign));
  }

  // 单手臂链：右侧值直接写 right*，镜像（y,z 取反）写 left*
  private applyHand(side: 'right' | 'left', anchor: HandAnchor) {
    if (anchor === 'rest') return;
    const t = VrmActorImpl.HAND_TARGETS[anchor];
    const m = side === 'right' ? 1 : -1;
    this.setBone(`${side}UpperArm`, t.upperArm[0], t.upperArm[1] * m, t.upperArm[2] * m);
    this.setBone(`${side}LowerArm`, t.lowerArm[0], t.lowerArm[1] * m, t.lowerArm[2] * m);
  }

  playGesture(g: Gesture) {
    this.activeGesture = g;
    this.gestureStart = performance.now() / 1000;
    this.gestureDur = Math.min(9, Math.max(0.8, (g.hold_ms ?? 3500) / 1000));
    this.boneTarget.clear();
    // 手：双手共位 = 两侧同到 chest 锚点（旧 hug_cup 的分解形态）
    if (g.hands === 'hold_center') {
      this.applyHand('right', 'chest');
      this.applyHand('left', 'chest');
    } else {
      this.applyHand('right', g.hand_r ?? 'rest');
      this.applyHand('left', g.hand_l ?? 'rest');
    }
    // 躯干：lean=前倾/-后仰，turn=左转/-右转；stand 时脊柱挺直一点配合整体抬升
    const lean = g.torso?.lean ?? 0,
      turn = g.torso?.turn ?? 0;
    if (lean || turn || g.posture === 'stand') {
      this.setBone('spine', lean * 0.28 + (g.posture === 'stand' ? 0.08 : 0), turn * 0.4, 0);
      this.setBone('chest', lean * 0.2, turn * 0.22, 0);
    }
    // 头：pitch 正=抬头（本模型 -x 为抬），tilt=侧倾；转身时头跟随一点
    const pitch = g.head?.pitch ?? 0,
      tilt = g.head?.tilt ?? 0;
    if (pitch || tilt || turn) this.setBone('head', -pitch * 0.3, turn * 0.15, tilt * 0.25);
  }

  clearGesture() {
    this.activeGesture = null;
    this.boneTarget.clear();
  }

  private static MOTION_DEFAULT_MS: Record<Motion['action'], number> = {
    idle: 800,
    walk: 4200,
    turn: 1700,
    dance: 6500,
    stand_up: 1800,
    sit_down: 1800,
  };

  playMotion(m: Motion) {
    if (m.action === 'idle') {
      this.clearMotion();
      return;
    }
    this.activeMotion = m;
    this.motionStart = performance.now() / 1000;
    this.motionDur = THREE.MathUtils.clamp((m.duration_ms ?? VrmActorImpl.MOTION_DEFAULT_MS[m.action]) / 1000, 0.8, 12);
  }

  clearMotion() {
    if (this.activeMotion?.action === 'stand_up') this.standing = true;
    if (this.activeMotion?.action === 'sit_down') this.standing = false;
    this.activeMotion = null;
  }

  setJourney(journey: 'preparing' | 'departing' | 'arriving' | null) {
    if (this.journey === journey) return;
    this.journey = journey;
    this.journeyStart = performance.now() / 1000;
    // 换景移动拥有全身 locomotion；局部 gesture 仍由上层在换景开始时清理。
    if (journey === 'departing' || journey === 'arriving') this.activeMotion = null;
    if (!journey) this.standing = this.baseStanding; // 走位结束归位到场景默认姿态
  }

  setSceneStanding(s: boolean) {
    this.baseStanding = s;
  }

  private motionPose(now: number) {
    const bones = new Map<string, THREE.Euler>();
    let rootY = this.standing || this.baseStanding ? 0.16 : 0;
    let bobY = 0;
    const put = (name: string, x = 0, y = 0, z = 0) => bones.set(name, new THREE.Euler(x, y, z * this.tune.zSign));

    const motion = this.activeMotion;
    let elapsed = motion ? now - this.motionStart : 0;
    let duration = this.motionDur;
    const journeyK = 1;
    if (!motion && (this.journey === 'departing' || this.journey === 'arriving')) {
      // Only an anticipatory glance/turn is spatially credible against an
      // uncalibrated photo. Keep feet and root anchored; the journey is an edit.
      elapsed = now - this.journeyStart;
      duration = (this.journey === 'departing' ? SCENE_DEPART_MS : SCENE_ARRIVE_MS) / 1000;
      const p = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
      const turn =
        this.journey === 'departing'
          ? THREE.MathUtils.smoothstep(p, 0, 0.5)
          : 1 - THREE.MathUtils.smoothstep(p, 0, 0.7);
      put('head', 0, -0.24 * turn, 0);
      put('chest', 0, -0.1 * turn, 0);
      return { bones, rootY, bobY };
    }

    if (!motion) return { bones, rootY, bobY };
    if (this.activeMotion && elapsed >= duration) {
      this.clearMotion();
      return { bones, rootY: this.standing ? 0.16 : 0, bobY };
    }

    const p = THREE.MathUtils.clamp(elapsed / Math.max(0.001, duration), 0, 1);
    const inK = THREE.MathUtils.smoothstep(p, 0, Math.min(0.16, 0.35 / Math.max(duration, 0.8)));
    const outK = this.journey
      ? journeyK
      : 1 - THREE.MathUtils.smoothstep(p, Math.max(0.72, 1 - 0.4 / Math.max(duration, 0.8)), 1);
    const k = Math.min(inK, outK) * journeyK;
    const style = motion.style ?? 'casual';

    if (motion.action === 'walk') {
      const hz = style === 'brisk' ? 2.05 : style === 'playful' ? 1.85 : 1.55;
      const amp = style === 'brisk' ? 0.48 : style === 'playful' ? 0.44 : 0.36;
      const a = elapsed * Math.PI * 2 * hz;
      const step = Math.sin(a),
        liftR = Math.max(0, -step),
        liftL = Math.max(0, step);
      const dir = motion.direction;
      const side = dir === 'left' ? 1 : dir === 'right' ? -1 : 0;
      const reverse = dir === 'back' ? -0.75 : 1;
      put('rightUpperLeg', step * amp * reverse * k, side * 0.08 * k, 0);
      put('leftUpperLeg', -step * amp * reverse * k, side * 0.08 * k, 0);
      put('rightLowerLeg', liftR * amp * 0.95 * k, 0, 0);
      put('leftLowerLeg', liftL * amp * 0.95 * k, 0, 0);
      put('rightFoot', -liftR * 0.18 * k, 0, 0);
      put('leftFoot', -liftL * 0.18 * k, 0, 0);
      put('rightUpperArm', -step * amp * 0.58 * k, 0, 0);
      put('leftUpperArm', step * amp * 0.58 * k, 0, 0);
      put('hips', 0, side * 0.1 * k, Math.sin(a * 0.5) * 0.035 * k);
      put('spine', -0.025 * k, side * 0.06 * k, 0);
      put('chest', 0, -side * 0.035 * k, 0);
      bobY = (Math.abs(Math.sin(a)) * 0.014 - 0.006) * k;
    } else if (motion.action === 'turn') {
      const dirSign = motion.direction === 'right' ? -1 : 1;
      const magnitude = motion.direction === 'back' ? 0.95 : 0.62;
      const arc = Math.sin(Math.PI * p) * k * dirSign * magnitude;
      const step = Math.sin(Math.PI * p * 2) * k;
      put('hips', 0, arc * 0.55, 0);
      put('spine', 0, arc * 0.44, 0);
      put('chest', 0, arc * 0.34, 0);
      put('head', 0, arc * 0.18, 0);
      put('rightUpperLeg', step * 0.16, -arc * 0.12, 0);
      put('leftUpperLeg', -step * 0.16, -arc * 0.12, 0);
    } else if (motion.action === 'dance') {
      const hz = style === 'brisk' ? 2.25 : style === 'playful' ? 1.8 : 1.55;
      const a = elapsed * Math.PI * 2 * hz;
      const s = Math.sin(a),
        c = Math.cos(a),
        half = Math.sin(a * 0.5);
      put('hips', c * 0.04 * k, half * 0.18 * k, s * 0.1 * k);
      put('spine', -0.035 * k, -half * 0.12 * k, -s * 0.05 * k);
      put('chest', 0.02 * c * k, half * 0.1 * k, s * 0.08 * k);
      put('rightUpperLeg', s * 0.3 * k, 0, 0);
      put('leftUpperLeg', -s * 0.3 * k, 0, 0);
      put('rightLowerLeg', Math.max(0, -s) * 0.34 * k, 0, 0);
      put('leftLowerLeg', Math.max(0, s) * 0.34 * k, 0, 0);
      put('rightUpperArm', -s * 0.42 * k, half * 0.16 * k, -0.22 * c * k);
      put('leftUpperArm', s * 0.42 * k, -half * 0.16 * k, 0.22 * c * k);
      put('rightLowerArm', 0.1 * c * k, 0, -0.18 * s * k);
      put('leftLowerArm', -0.1 * c * k, 0, 0.18 * s * k);
      bobY = Math.abs(s) * 0.012 * k;
    } else if (motion.action === 'stand_up' || motion.action === 'sit_down') {
      const q = p * p * (3 - 2 * p);
      const up = motion.action === 'stand_up' ? q : 1 - q;
      const bend = (1 - up) * k;
      rootY = 0.16 * up;
      put('hips', bend * 0.12, 0, 0);
      put('spine', bend * 0.18, 0, 0);
      put('chest', bend * 0.1, 0, 0);
      put('rightUpperLeg', -bend * 0.52, 0, 0);
      put('leftUpperLeg', -bend * 0.52, 0, 0);
      put('rightLowerLeg', bend * 0.78, 0, 0);
      put('leftLowerLeg', bend * 0.78, 0, 0);
    }

    return { bones, rootY, bobY };
  }

  // 用户的脸 → 世界坐标注视点：场景相机位置 + 视线方向（设备视场角换算的真实角度）× 估计距离。
  // 对视 = 眼睛锁在对方脸上：水平不叠"你看向别处"的偏移（会同向跟看，变成一起看东西而不是对视）；
  // 垂直保留——你低头打字她目光跟下去，这个方向没有镜像歧义。
  private userGazePoint(g: { x: number; y: number; dist: number; gx: number; gy: number }, out: THREE.Vector3) {
    const cam = this.camera;
    const f = VrmActorImpl._f,
      r = VrmActorImpl._r,
      u = VrmActorImpl._u;
    cam.getWorldDirection(f);
    r.crossVectors(f, cam.up).normalize();
    u.crossVectors(r, f).normalize();
    const d = THREE.MathUtils.clamp(g.dist, 0.25, 1.3);
    out
      .copy(f)
      .addScaledVector(r, Math.tan((g.x * CAM_HFOV) / 2))
      .addScaledVector(u, Math.tan((g.y * CAM_VFOV) / 2))
      .normalize()
      .multiplyScalar(d)
      .add(cam.position);
    out.addScaledVector(u, g.gy * 0.4 * d);
    return out;
  }

  private gazeTarget(_t: number): THREE.Vector3 {
    // 显式动作优先；无动作时即使正在思考，也继续跟随用户。
    const anchor = this.activeGesture?.gaze;
    if (anchor && anchor !== 'user') return VrmActorImpl.GAZE_POINTS[anchor];
    const g = eyeContact.gaze();
    if (g && !this.activeGesture) return this.userGazePoint(g, VrmActorImpl._gp);
    if (this.phase === 'thinking') return new THREE.Vector3(-0.5, 1.75, 0.9);
    return new THREE.Vector3(0.05, 1.35, 2.0);
  }

  tick(dt: number, t: number) {
    const vrm = this.vrm;
    const now = performance.now() / 1000;
    const em = vrm.expressionManager;
    if (!em) return;

    // --- 表情：目标权重 damp 平滑 ---
    const target = EMOTION_MAP[this.emotion] ?? EMOTION_MAP.neutral;
    for (const p of EXPRESSION_PRESETS) {
      const cur = this.exprWeights[p] ?? 0;
      const goal = target[p] ?? 0;
      const next = THREE.MathUtils.damp(cur, goal, 6, dt);
      this.exprWeights[p] = next;
      em.setValue(p, next);
    }

    // --- 眨眼 ---
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkPhase = 0.16;
      this.blinkTimer = this.phase === 'thinking' ? 4.5 + Math.random() * 2 : 2.6 + Math.random() * 3;
    }
    if (this.blinkPhase > 0) {
      this.blinkPhase -= dt;
      const k = this.blinkPhase > 0.08 ? 1 - (0.16 - this.blinkPhase) / 0.08 : this.blinkPhase / 0.08;
      em.setValue('blink', Math.min(1, k));
    } else em.setValue('blink', 0);

    // --- 口型：振幅 → aa，带 oh 尾韵 ---
    em.setValue('aa', this.mouth);
    em.setValue('oh', this.mouth * 0.35);

    // 动作到期先释放控制权，本帧即可恢复摄像头跟随。
    const actT = this.activeGesture ? now - this.gestureStart : 0;
    if (this.activeGesture && actT > this.gestureDur) this.clearGesture();
    const actK = this.activeGesture
      ? actT < 0.6
        ? actT / 0.6
        : actT > this.gestureDur - 0.8
          ? Math.max(0, (this.gestureDur - actT) / 0.8)
          : 1
      : 0;
    const motionPose = this.motionPose(now);

    // --- 视线和头部：默认跟随，显式动作期间让位 ---
    // 头骨驱动独立于 VRM 的眼球 lookAt 支持。
    const g = eyeContact.gaze();
    if (g && !this.gazeHead.has) this.blinkPhase = Math.max(this.blinkPhase, 0.16);
    this.gazeHead.has = !!g;
    const following = !!g && !this.activeGesture;
    // 头跟脸的位置走；gx 反向——你向左转，她转向"她的左"（画面右），像对面的人自然迎脸，
    // 而不是同向跟看（那读起来是"她在看你看的东西"，不是对视）。
    const lookX = g ? g.x - g.gx * 0.35 : 0;
    const lookY = g ? g.y + g.gy * 0.3 : 0;
    // 常见的半幅移动产生约 16° 转头，限幅防止大幅甩头。
    const hYaw = following ? THREE.MathUtils.clamp(lookX * 0.55, -0.55, 0.55) : 0;
    const hPitch = following ? THREE.MathUtils.clamp(-lookY * 0.4, -0.35, 0.35) : 0;
    this.gazeHead.yaw = THREE.MathUtils.damp(this.gazeHead.yaw, hYaw, 6, dt);
    this.gazeHead.pitch = THREE.MathUtils.damp(this.gazeHead.pitch, hPitch, 6, dt);
    if (vrm.lookAt) {
      const tgt = this.gazeTarget(t);
      this.gazeCur.x = THREE.MathUtils.damp(this.gazeCur.x, tgt.x, 7, dt);
      this.gazeCur.y = THREE.MathUtils.damp(this.gazeCur.y, tgt.y, 7, dt);
      this.gazeCur.z = THREE.MathUtils.damp(this.gazeCur.z, tgt.z, 7, dt);
      this.gazeObj.position.copy(this.gazeCur);
      this.gazeObj.updateMatrixWorld();
      vrm.lookAt.target = this.gazeObj;
    }

    // --- 音频驱动动作：说话能量 + 音节重音 → 点头/侧头/躯干律动 ---
    // 有骨骼目标的姿态播放中让位（留 20% 不致僵住）；纯视线 gesture 无骨骼目标不受影响。
    // 静音时 level/beat 自然归 0 → 弹簧自行回落，打断/说完都不需要显式停止。
    const speechGate = this.boneTarget.size > 0 ? 1 - actK * 0.8 : 1;
    const drive = this.speech.level * speechGate;
    this.phraseAcc =
      this.speech.level > 0.12 ? this.phraseAcc + this.speech.level * dt * 1.6 : Math.max(0, this.phraseAcc - dt * 0.8);
    let impulse = 0,
      strong = false;
    if (this.speech.beatId !== this.prevBeatId && this.speech.strength > 0.4 && now >= this.nextBeatAt) {
      impulse = this.speech.strength; // 用锁存强度，不吃 beat 的衰减
      this.prevBeatId = this.speech.beatId;
      this.nextBeatAt = now + 0.22;
    } else if (this.phraseAcc > 1.4 && now >= this.nextBeatAt) {
      impulse = Math.min(1, this.phraseAcc * 0.45); // 持续高能积累出的短语级顿挫
      strong = true;
      this.phraseAcc = 0;
      this.nextBeatAt = now + 0.4;
    }
    if (impulse > 0) {
      const k = strong ? 2.4 : 2.0;
      const r = Math.random();
      this.nodVel -= impulse * k * (0.8 + r * 0.8);
      this.yawVel += (Math.random() - 0.5) * impulse * k * 0.8;
      if (r > 0.68 || strong) this.tiltVel += (Math.random() - 0.5) * impulse * k * 1.1;
      // 防止连续脉冲叠加成甩头
      this.nodVel = THREE.MathUtils.clamp(this.nodVel, -3.5, 3.5);
      this.yawVel = THREE.MathUtils.clamp(this.yawVel, -2.5, 2.5);
      this.tiltVel = THREE.MathUtils.clamp(this.tiltVel, -2.5, 2.5);
    }
    this.nodVel += (-this.nod * 70 - this.nodVel * 10) * dt;
    this.nod += this.nodVel * dt;
    this.yawVel += (-this.yaw * 55 - this.yawVel * 9) * dt;
    this.yaw += this.yawVel * dt;
    this.tiltVel += (-this.tilt * 60 - this.tiltVel * 10) * dt;
    this.tilt += this.tiltVel * dt;
    const nodK = (0.25 + 0.75 * Math.min(1, drive * 2.4)) * speechGate;
    const bodyPulse = drive * (Math.sin(t * 6.1) * 0.03 + Math.sin(t * 2.3) * 0.018);
    const armPulse = drive * 0.09 * (0.5 + 0.5 * Math.sin(t * 3.1));

    const breathe = Math.sin(t * 1.9) * 0.012;
    const sway = Math.sin(t * 0.7) * 0.01;
    const lean = this.phase === 'listening' ? 0.05 : 0;

    for (const [name, home] of this.boneHome) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name as never);
      if (!bone) continue;
      const tgt = this.boneTarget.get(name);
      const mo = motionPose.bones.get(name);
      const mx = home.x + (mo?.x ?? 0),
        my = home.y + (mo?.y ?? 0),
        mz = home.z + (mo?.z ?? 0);
      // motion 先给全身基础动作；gesture 只覆盖自己声明的骨骼，未声明部位继续走/跳舞。
      const ex = tgt ? THREE.MathUtils.lerp(mx, home.x + tgt.x, actK) : mx;
      const ey = tgt ? THREE.MathUtils.lerp(my, home.y + tgt.y, actK) : my;
      const ez = tgt ? THREE.MathUtils.lerp(mz, home.z + tgt.z, actK) : mz;
      let addX = 0,
        addY = 0,
        addZ = 0;
      if (name === 'chest') addX = breathe * 0.6 + lean + bodyPulse;
      if (name === 'head') {
        addX =
          breathe * 0.4 +
          lean * 0.8 +
          (this.phase === 'thinking' ? -0.04 : 0) +
          this.nod * 0.7 * nodK +
          this.gazeHead.pitch;
        addY = this.yaw * 0.34 * nodK * this.tune.zSign + this.gazeHead.yaw;
        addZ = this.tilt * 0.26 * nodK * this.tune.zSign;
      }
      if (name === 'spine') addX = lean * 0.7 + bodyPulse * 0.6;
      if (name === 'hips') addX = sway * 0.4;
      if (name === 'rightLowerArm') addZ = armPulse * this.tune.zSign;
      if (name === 'leftLowerArm') addZ = -armPulse * this.tune.zSign;
      bone.rotation.x = THREE.MathUtils.damp(bone.rotation.x, ex + addX, 10, dt);
      bone.rotation.y = THREE.MathUtils.damp(bone.rotation.y, ey + addY, 10, dt);
      bone.rotation.z = THREE.MathUtils.damp(bone.rotation.z, ez + addZ, 10, dt);
    }

    // motion 维护可持续站/坐状态；gesture.posture 可以临时覆盖。
    const root = vrm.scene;
    const gestureY =
      this.activeGesture?.posture === 'stand' ? 0.16 : this.activeGesture?.posture === 'sit' ? 0 : undefined;
    const baseY = gestureY ?? motionPose.rootY;
    root.position.y = THREE.MathUtils.damp(root.position.y, baseY + motionPose.bobY + Math.sin(t * 1.9) * 0.004, 8, dt);

    vrm.update(dt);
  }
}

export function VrmActor({ actorRef }: { actorRef: React.MutableRefObject<CharacterActor | null> }) {
  const modelUrl = useMemo(() => new URLSearchParams(location.search).get('model') ?? '/assets/mira.vrm', []);
  const gltf = useLoader(GLTFLoader, modelUrl, (loader) => {
    loader.register((parser) => new VRMLoaderPlugin(parser));
  });
  const { camera } = useThree();
  const tune = useMemo(() => tuneFor(gltf), [gltf]);
  const vrm = useMemo(() => {
    const v = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(v.scene);
    VRMUtils.combineSkeletons(v.scene);
    // VRM 0.x 模型面向 -Z：朝向翻转到下方 primitive 的 rotation 里合成
    v.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.frustumCulled = false;
        const m = o as THREE.Mesh;
        m.castShadow = m.receiveShadow = false;
        if (tune.hide?.test(o.name)) o.visible = false;
      }
    });
    return v;
  }, [gltf, tune]);

  // 程序化星星发夹：金色五角星别在头侧
  const star = useMemo(() => {
    const shape = new THREE.Shape();
    const R = 0.045,
      r = 0.02;
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? R : r;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * rad,
        y = Math.sin(a) * rad;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false });
    const mat = new THREE.MeshStandardMaterial({
      color: '#e8c46a',
      metalness: 0.85,
      roughness: 0.3,
      emissive: '#a06a1e',
      emissiveIntensity: 0.45,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // 贴在她左侧刘海发根（head 局部系，+x 左 +y 上 +z 前）
    mesh.position.set(0.085, 0.085, 0.055);
    mesh.rotation.set(-0.1, -0.85, 0.5);
    mesh.visible = false;
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    mesh.name = 'mira-star';
    const previous = head?.getObjectByName('mira-star');
    if (previous) head?.remove(previous);
    head?.add(mesh);
    return mesh;
  }, [vrm]);

  const impl = useMemo(() => new VrmActorImpl(vrm, star, tune, camera), [vrm, star, tune, camera]);
  useImageLighting(vrm);

  useEffect(() => {
    actorRef.current = impl;
    (window as unknown as { __actor?: unknown }).__actor = impl;
    useStore.setState({ modelReady: true });
    return () => {
      actorRef.current = null;
      useStore.setState({ modelReady: false });
    };
  }, [impl, actorRef]);

  // 接触阴影：软圆斑压在脚下，把她"放"在地面上而不是飘在底图上
  const shadowMat = useRef<THREE.MeshBasicMaterial>(null);
  const shadowTex = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.9)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.45)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  const placement = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const emotion = useStore((s) => s.emotion);
  const motion = useStore((s) => s.motion);
  const gesture = useStore((s) => s.gesture);
  const phase = useStore((s) => s.phase);
  const bgKey = useStore((s) => s.bgKey);
  const journey = useStore((s) => s.sceneTransition?.phase);
  useEffect(() => {
    impl.setJourney(journey ?? null);
    if (journey === 'departing' || journey === 'arriving') impl.clearGesture();
  }, [journey, impl]);
  useEffect(() => impl.setSceneStanding(stagingFor(bgKey).standing), [bgKey, impl]);
  useEffect(() => impl.setEmotion(emotion as Emotion), [emotion, impl]);
  useEffect(() => {
    if (motion) {
      impl.playMotion(motion);
      useStore.setState({ motion: null });
    }
  }, [motion, impl]);
  useEffect(() => {
    if (gesture) {
      impl.playGesture(gesture);
      useStore.setState({ gesture: null });
    }
  }, [gesture, impl]);
  useEffect(() => impl.setState(phase), [phase, impl]);

  useFrame((_, dt) => {
    const w = window as unknown as {
      __mouth?: () => number;
      __speech?: () => { level: number; beat: number; beatId: number; strength: number };
    };
    impl.setMouthOpen(w.__mouth?.() ?? 0);
    impl.setSpeech(w.__speech?.() ?? { level: 0, beat: 0, beatId: 0, strength: 0 });
    impl.tick(Math.min(dt, 0.05), performance.now() / 1000);
    const state = useStore.getState(),
      group = placement.current;
    if (group) {
      const st = stagingFor(state.bgKey);
      group.rotation.y = 0;
      group.position.set(0, st.groundY, 0);
      if (shadow.current && shadowMat.current) {
        shadow.current.position.y = isStagedScene(state.bgUrl) ? 0.16 : -0.055 + (st.standing ? 0.16 : 0);
        shadowMat.current.opacity = st.shadow;
      }
    }
  });

  // Mira 站位：中轴偏左，面向镜头；脚下垫一圈软阴影
  return (
    <group name="mira-placement" ref={placement} position={[0, -0.26, 0]}>
      <primitive object={vrm.scene} position={[-0.02, 0, 0]} rotation={[0, Math.PI * 0.02 + tune.yaw, 0]} />
      <mesh ref={shadow} position={[-0.02, -0.055, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-1}>
        <planeGeometry args={[0.62, 0.4]} />
        <meshBasicMaterial ref={shadowMat} map={shadowTex} transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}
