// 浏览器 ⇄ 我方服务端 协议（JSON over WebSocket，音频帧用二进制）
// 下行 = server→client；上行 = client→server
import type { WorldView } from './world';

export type Emotion = 'neutral' | 'soft_smile' | 'wistful' | 'surprised' | 'warm' | 'guarded';
export type CameraMove = 'none' | 'idle_drift' | 'slow_push' | 'close_up' | 'pull_back' | 'pan_door';
export type Fx = 'none' | 'rain_heavy' | 'lightning' | 'lights_dim' | 'rain_stop';

// 旧枚举动作（保留只为回放老录制；新指令一律走 gesture）
export type Action = 'none' | 'hug_cup' | 'glance_door' | 'show_photo' | 'tuck_hair' | 'stand_up';

// 原子姿态：手到空间锚点、躯干/头连续量、视线锚点、手持物、持续时间。
// 槽位只管"身体在哪"，含义由调用方组合产生；服务端按物理规则校正怪组合。
export type HandAnchor = 'rest' | 'head_side' | 'face' | 'chest' | 'lap' | 'table' | 'forward_low' | 'forward_eye';
export type Prop = 'none' | 'cup' | 'photo' | 'phone';
export type GazeTarget = 'user' | 'door' | 'window' | 'down' | 'prop' | 'away';

// 持续的全身动作层。gesture 负责“身体各部位摆到哪里”，motion 负责“整个人正在做什么”。
// 后续接入 VRMA/Mixamo 时保持这层协议不变，只替换客户端的动作实现。
export type MotionAction = 'idle' | 'walk' | 'turn' | 'dance' | 'stand_up' | 'sit_down';
export type MotionDirection = 'left' | 'right' | 'forward' | 'back';
export type MotionStyle = 'casual' | 'brisk' | 'playful';

export interface Motion {
  action: MotionAction;
  direction?: MotionDirection;
  style?: MotionStyle;
  duration_ms?: number; // 800-12000；未填时按动作给默认时长
}

export interface Gesture {
  posture?: 'sit' | 'stand';
  hand_r?: HandAnchor;
  hand_l?: HandAnchor;
  hands?: 'hold_center'; // 双手在胸前汇合（与单手写互斥，双手优先）
  prop?: Prop;
  torso?: { lean?: number; turn?: number }; // lean +前倾/-后仰，turn +左转/-右转，-1..1
  head?: { pitch?: number; tilt?: number }; // pitch +抬头/-低头，tilt 侧倾，-1..1
  gaze?: GazeTarget;
  hold_ms?: number; // 姿态保持时长，到期回 rest；默认 3500
}

// 老 action 枚举 → 等效原子姿态（录制回放与模型惯性输出共用）
export function gestureForLegacy(a: Action): Gesture | undefined {
  switch (a) {
    case 'hug_cup':
      return { hands: 'hold_center', prop: 'cup' };
    case 'glance_door':
      return { gaze: 'door', hold_ms: 2600 };
    case 'show_photo':
      return { hand_l: 'forward_eye', prop: 'photo', gaze: 'user', hold_ms: 5000 };
    case 'tuck_hair':
      return { hand_r: 'head_side', hold_ms: 3200 };
    case 'stand_up':
      return { posture: 'stand', torso: { lean: 0.15 }, hold_ms: 4000 };
    default:
      return undefined;
  }
}

export interface StageDirective {
  emotion?: Emotion;
  motion?: Motion;
  gesture?: Gesture;
  action?: Action; // 旧录制回放兼容字段；服务端新指令不再下发
  camera?: CameraMove;
  fx?: Fx;
}

export type ClientPhase = 'boot' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'reconnecting';

// ---------- 上行 client → server ----------
export type UpMessage =
  | { type: 'hello'; session_id?: string; client?: string; client_token?: string; fresh_world?: boolean } // client_token：会话所有权凭据，reattach 需匹配
  | { type: 'diagnostics.client'; name: string; data?: unknown }
  | { type: 'debug' } // 订阅服务端日志流（默认不广播；日志含对话内容）
  | { type: 'enter' } // 用户"轻触进入"：开场白
  | { type: 'mic'; muted: boolean }
  | { type: 'text'; text: string }
  | { type: 'user.activity' } // Local speech/typing cancels a pending continuation
  | { type: 'choice'; id: string }
  | { type: 'scene.presented'; id: string; ok: boolean }
  | { type: 'travel.request'; locationId: string; intentId: string }
  | { type: 'travel.cancel'; id: string }
  | { type: 'map.open'; open: boolean }
  | { type: 'playback'; response_id: string; remaining_ms: number }
  | { type: 'interrupt' } // 本地 VAD 判定的打断
  | { type: 'reset' } // 整场重来：服务端销毁当前会话并在同一连接上重建
  | { type: 'client.state'; phase: ClientPhase }
  | { type: 'ping'; t: number };

// 音频上行：纯二进制帧 = PCM16k mono 20ms(640B)

// ---------- 下行 server → client ----------
export type DownMessage =
  | { type: 'session'; session_id: string; resumed: boolean; trace_id?: string }
  | { type: 'state'; phase: 'listening' | 'thinking' | 'speaking' | 'idle' }
  | { type: 'audio.begin'; response_id: string; sample_rate: number }
  | { type: 'audio.end'; response_id: string; interrupted?: boolean }
  | { type: 'transcript.user'; text: string; final: boolean }
  | { type: 'transcript.mira'; delta: string; response_id: string }
  | { type: 'transcript.mira.done'; response_id: string }
  | { type: 'directive'; directive: StageDirective; at?: number }
  | { type: 'media.event'; event: MediaEvent }
  | { type: 'interrupted' }
  | { type: 'story'; story: StoryView }
  | { type: 'world'; world: WorldView }
  | { type: 'travel.cancelled'; id: string }
  | { type: 'narration'; text: string } // 旁白事件（展示用，可选显示）
  | { type: 'log'; entry: LogEntry }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong'; t: number };

export interface MediaEvent {
  id: string;
  kind: 'scene' | 'photo' | 'overlay' | 'foreground';
  status: 'generating' | 'ready' | 'failed';
  scene_key?: string; // overlay/foreground 时 = 生成所基于的基底场景 key（用于转场后丢弃过期叠层）
  url?: string; // ready 时
  caption?: string; // photo 时
  subject?: string;
  reason?: string; // failed 时
  cached?: boolean;
  context_id?: string;
  purpose?: 'moment' | 'photo';
  ttl_ms?: number; // overlay 专用：叠入展示时长，到时自动淡出
  foreground_url?: string; // scene-ready: optional aligned RGBA PNG, prepared with the base
  self_band?: boolean; // foreground 专用：true = 前景层复用底图本身（未通过 i2i 校验的兜底）
  travel_id?: string; // prepared ACK -> durable world commit -> committed scene
  committed?: boolean;
}

export interface LogEntry {
  ts: number;
  cat: 'ws' | 'duplex' | 'director' | 'genimg' | 'audio' | 'session' | 'client' | 'tts';
  msg: string;
  data?: unknown;
}

// ---------- 服务端 ⇄ 豆包 Duplex（JSON 帧，摘关键型） ----------
export interface DuplexToolCall {
  call_id: string;
  name: string;
  arguments: string; // JSON string
}

export interface StoryView {
  revision: number;
  phase: 'arrival' | 'invitation' | 'together' | 'farewell';
  title: string;
  prop: string;
  event?: string;
  consequence: string;
  choices: { id: string; label: string }[];
}
