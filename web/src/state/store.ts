import { create } from 'zustand';
import {
  gestureForLegacy,
  type ClientPhase,
  type Gesture,
  type LogEntry,
  type MediaEvent,
  type Motion,
  type StageDirective,
  type StoryView,
} from '../../../shared/protocol';

export interface Subtitle {
  id: number;
  who: 'user' | 'mira' | 'narration';
  text: string;
  final: boolean;
  interrupted?: boolean;
}

interface Store {
  phase: ClientPhase;
  sceneTransition: { id: string; phase: 'preparing' | 'departing' | 'arriving'; startedAt: number } | null;
  story: StoryView | null;
  sessionId: string;
  resumed: boolean;
  entered: boolean;
  modelReady: boolean;
  micMuted: boolean;
  eye: 'off' | 'starting' | 'on' | 'denied' | 'unsupported' | 'error';
  eyeTracking: boolean;
  subtitles: Subtitle[];
  // 场景呈现状态（指令队列消费后的"当前画面"）
  emotion: string;
  motion: Motion | null; // 一次性消费：VrmActor 接管持续时间和混合
  gesture: Gesture | null; // 一次性消费：VrmActor 播放后置 null
  camera: string;
  fx: { rain: number; dim: number; lightning: number };
  bgUrl: string;
  bgKey: string;
  // 生成式变体叠层：事件直接编辑在当前底图上（i2i）；until 到期或所属剧情 revision 变化即淡出
  overlay: { url: string; sceneKey: string; until: number; purpose?: 'moment' | 'photo'; rev?: number } | null;
  // 前景板：当前场景的近景层（i2i 校验通过 或 self-band 兜底复用底图）；sceneKey 不匹配即不渲染
  fg: { url: string; sceneKey: string; selfBand?: boolean } | null;
  generating: MediaEvent[];
  photo: { url: string; caption: string } | null;
  latency: { lastFirstAudio?: number };
  logs: LogEntry[];
  debugOpen: boolean;
  toast: string;

  set: (p: Partial<Store>) => void;
  pushSubtitle: (s: Omit<Subtitle, 'id'>) => void;
  appendMira: (delta: string) => void;
  finalizeMira: (interrupted?: boolean) => void;
  updateUser: (text: string, final: boolean) => void;
  pushLog: (e: LogEntry) => void;
  applyDirective: (d: StageDirective) => void;
}

let sid = 0;
const nextId = () => ++sid;

export const useStore = create<Store>((set, _get) => ({
  phase: 'boot',
  sceneTransition: null,
  story: null,
  sessionId: typeof localStorage !== 'undefined' ? (localStorage.getItem('mira.sid') ?? '') : '',
  resumed: false,
  entered: false,
  modelReady: false,
  micMuted: false,
  eye: 'off',
  eyeTracking: false,
  subtitles: [],
  emotion: 'neutral',
  motion: null,
  gesture: null,
  camera: 'idle_drift',
  fx: { rain: 1, dim: 0, lightning: 0 },
  bgUrl: '/assets/bg/cafe_interior.jpg',
  bgKey: 'cafe_interior',
  overlay: null,
  fg: null,
  generating: [],
  photo: null,
  latency: {},
  logs: [],
  debugOpen: false,
  toast: '',

  set: (p) => set(p),

  pushSubtitle: (s) => set((st) => ({ subtitles: [...st.subtitles.slice(-6), { ...s, id: nextId() }] })),

  appendMira: (delta) =>
    set((st) => {
      const subs = [...st.subtitles];
      const last = subs[subs.length - 1];
      if (last && last.who === 'mira' && !last.final) {
        subs[subs.length - 1] = { ...last, text: last.text + delta };
      } else {
        subs.push({ id: nextId(), who: 'mira', text: delta, final: false });
      }
      return { subtitles: subs.slice(-6) };
    }),

  finalizeMira: (interrupted) =>
    set((st) => {
      const subs = [...st.subtitles];
      const last = subs[subs.length - 1];
      if (last && last.who === 'mira' && !last.final) {
        subs[subs.length - 1] = { ...last, final: true, interrupted, text: interrupted ? last.text + ' …' : last.text };
      }
      return { subtitles: subs };
    }),

  updateUser: (text, final) =>
    set((st) => {
      const subs = [...st.subtitles];
      const last = subs[subs.length - 1];
      // 幻影转写收尾：空的 final 把未完的"…"占位撤掉，没出现过就不产生任何字幕
      if (final && !text.trim()) {
        if (last && last.who === 'user' && !last.final) subs.pop();
        return { subtitles: subs };
      }
      if (last && last.who === 'user' && !last.final) {
        subs[subs.length - 1] = { ...last, text, final };
      } else {
        subs.push({ id: nextId(), who: 'user', text, final });
      }
      return { subtitles: subs.slice(-6) };
    }),

  pushLog: (e) => set((st) => ({ logs: [...st.logs.slice(-199), e] })),

  applyDirective: (d) =>
    set((st) => {
      const fx = { ...st.fx };
      if (d.fx === 'rain_heavy') fx.rain = 1.6;
      if (d.fx === 'rain_stop') fx.rain = 0.12;
      if (d.fx === 'lights_dim') fx.dim = 1;
      if (d.fx === 'lightning') fx.lightning = 1;
      // gesture 对象优先；老录制里的 action 枚举走兼容映射
      const gesture = d.gesture ?? (d.action ? (gestureForLegacy(d.action) ?? null) : st.gesture);
      return {
        emotion: d.emotion ?? st.emotion,
        motion: d.motion ?? st.motion,
        gesture,
        camera: d.camera && d.camera !== 'none' ? d.camera : st.camera,
        fx,
      };
    }),
}));

// 调试钩子（__actor / __eye 同款）：测试脚本经它切 entered/phase
if (typeof window !== 'undefined') (window as unknown as { __store?: typeof useStore }).__store = useStore;
