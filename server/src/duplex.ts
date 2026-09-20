import { traceEvent } from './telemetry.js';
import WebSocket from 'ws';
import { config } from './config.js';
import { log } from './log.js';
import { stripStage } from '../../shared/spoken-text.js';
export { stripStage } from '../../shared/spoken-text.js';
import {
  gestureForLegacy,
  type Action,
  type Gesture,
  type Motion,
  type StageDirective,
} from '../../shared/protocol.js';

// 豆包端到端全双工 Duplex 客户端（纯 JSON 帧协议）
// 协议纪律（探针实测）：
//  - 上行 PCM16k mono，严格 20ms/640B 实时节奏 → 这里用自校正节拍器统一调速
//  - 关麦必须 input_audio_mute.commit，否则超时无响应
//  - 优雅关闭：session.close 收到回复再断连
//  - session.id 可续接历史

export const TOOLS = [
  {
    type: 'function',
    name: 'stage_directive',
    description:
      '驱动画面演出的舞台指令。每轮开口说话前必须调用一次；说话途中情绪/画面需要变化时可再次调用。motion 是持续的全身动作（走路、转身、跳舞、起身、坐下）；gesture 是叠在其上的局部姿态（手、躯干、头、视线、道具）。用户要求走路/跳舞等明确身体行为时必须使用 motion，不要用 gesture 假装。emotion/camera/fx 只能填枚举值。服务端会校正不合理参数，校正明细随工具回执返回。台词用嘴说，不要把参数念出来。',
    parameters: {
      type: 'object',
      properties: {
        emotion: {
          type: 'string',
          enum: ['neutral', 'soft_smile', 'wistful', 'surprised', 'warm', 'guarded'],
          description: '表情情绪，只能填枚举值',
        },
        motion: {
          type: 'object',
          description: '持续全身动作。walk/dance/turn 等行为放这里；gesture 只负责局部姿态。',
          properties: {
            action: {
              type: 'string',
              enum: ['idle', 'walk', 'turn', 'dance', 'stand_up', 'sit_down'],
              description: '全身动作类型',
            },
            direction: {
              type: 'string',
              enum: ['left', 'right', 'forward', 'back'],
              description: 'walk/turn 的方向；不需要时省略',
            },
            style: { type: 'string', enum: ['casual', 'brisk', 'playful'], description: '动作风格；默认 casual' },
            duration_ms: { type: 'number', description: '动作持续毫秒数，800-12000；不填按动作使用默认值' },
          },
          required: ['action'],
        },
        gesture: {
          type: 'object',
          description: '原子姿态，全部可选。不是"动作名"，只描述身体各部位的空间目标，含义靠组合。',
          properties: {
            posture: { type: 'string', enum: ['sit', 'stand'], description: '坐/站' },
            hand_r: {
              type: 'string',
              enum: ['rest', 'head_side', 'face', 'chest', 'lap', 'table', 'forward_low', 'forward_eye'],
              description:
                '右手空间锚点：rest垂放 head_side头侧 face脸旁 chest胸前 lap腿上 table桌面 forward_low向前低举 forward_eye向前平举',
            },
            hand_l: {
              type: 'string',
              enum: ['rest', 'head_side', 'face', 'chest', 'lap', 'table', 'forward_low', 'forward_eye'],
              description: '左手空间锚点，同上',
            },
            hands: {
              type: 'string',
              enum: ['hold_center'],
              description: '双手共位：在胸前汇合（拿杯/捧物）。给出时覆盖单手',
            },
            prop: {
              type: 'string',
              enum: ['none', 'cup', 'photo', 'phone'],
              description: '手里的道具；需配合手部锚点，forward_* 是"递/展示"，chest/lap 是"握着/收着"',
            },
            torso: {
              type: 'object',
              properties: {
                lean: { type: 'number', description: '-1..1，正=前倾，负=后仰' },
                turn: { type: 'number', description: '-1..1，正=左转，负=右转' },
              },
            },
            head: {
              type: 'object',
              properties: {
                pitch: { type: 'number', description: '-1..1，正=抬头，负=低头' },
                tilt: { type: 'number', description: '-1..1，头的侧倾' },
              },
            },
            gaze: {
              type: 'string',
              enum: ['user', 'door', 'window', 'down', 'prop', 'away'],
              description: '视线锚点：user对面的人 door门口 window窗外 down低垂 prop手中物 away移开',
            },
            hold_ms: { type: 'number', description: '姿态保持毫秒数，800-8000，默认3500，到期自动回位' },
          },
        },
        camera: {
          type: 'string',
          enum: ['none', 'idle_drift', 'slow_push', 'close_up', 'pull_back', 'pan_door'],
          description: '运镜，只能填枚举值',
        },
        fx: {
          type: 'string',
          enum: ['none', 'rain_heavy', 'lightning', 'lights_dim', 'rain_stop'],
          description: '环境特效，只能填枚举值',
        },
      },
    },
  },
  {
    type: 'function',
    name: 'scene_event',
    description: '剧情到达转场节点时调用：切换到新场景背景（服务端实时生成画面）。theme 用英文短词描述场景内容。',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: '场景主题，如 street_outside / hospital_corridor / 或具体描述' },
      },
      required: ['theme'],
    },
  },
  {
    type: 'function',
    name: 'show_photo',
    description:
      'Mira 掏出照片给对方看的剧情节点调用。subject 描述照片内容（与刚才的对话相关），caption 是她在照片背后写的一句短话。',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: '照片画面内容' },
        caption: { type: 'string', description: '照片背面的一句话' },
      },
      required: ['subject', 'caption'],
    },
  },
];

export interface DuplexEvents {
  onEvent: (evt: Record<string, unknown>) => void; // 所有下行事件（原样）
  onClose: (code: number, reason: string) => void;
}

const FRAME_MS = 20;
const FRAME_BYTES = 640; // PCM16k mono 20ms

export class DuplexClient {
  private ws?: WebSocket;
  private audioQueue: Buffer[] = [];
  private injectQueue: Buffer[] = []; // 注入音频帧（cue/打字 TTS），优先于麦克风帧
  private paceTimer?: NodeJS.Timeout;
  private nextTick = 0;
  private muted = true; // 用户期望的麦克风状态：默认关麦，等客户端 enter
  private serverMuted: boolean | undefined; // 已向服务端 commit 的实际静音状态
  private closedByUs = false;
  sessionId = '';
  connected = false;

  constructor(private ev: DuplexEvents) {}

  async connect(opts: { instructions: string; resumeSessionId?: string }): Promise<void> {
    this.closedByUs = false;
    this.serverMuted = undefined;
    this.ws = new WebSocket(config.duplexUrl, {
      headers: { 'X-Api-Key': config.doubaoApiKey },
      maxPayload: 64 * 1024 * 1024,
    });
    this.ws.binaryType = 'nodebuffer';
    this.ws.on('message', (raw: Buffer | string) => {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        log('duplex', `non-json frame ${raw.length}B`);
        return;
      }
      const t = String(evt.type ?? '');
      if (t === 'session.created' || t === 'session.updated') {
        const sess = evt.session as Record<string, unknown> | undefined;
        const sid = String(sess?.id ?? evt.session_id ?? '');
        if (sid) this.sessionId = sid;
        this.connected = true;
        this.commitMute(this.muted);
      }
      if (t !== 'response.output_audio.delta') {
        log('duplex', `← ${t}`, Object.fromEntries(Object.entries(evt).filter(([k]) => k !== 'delta')));
      }
      this.ev.onEvent(evt);
    });
    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this.stopPacer();
      log('duplex', `closed code=${code} byUs=${this.closedByUs} reason=${reason.toString().slice(0, 200)}`);
      this.ev.onClose(code, reason.toString());
    });
    this.ws.on('error', (e) => log('duplex', `error ${e.message}`));

    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('duplex open timeout')), 10000);
      this.ws!.once('open', () => {
        clearTimeout(to);
        resolve();
      });
      this.ws!.once('error', (e) => {
        clearTimeout(to);
        reject(e);
      });
    });

    const session: Record<string, unknown> = {
      model: config.duplexModel,
      instructions: opts.instructions,
      audio: {
        input: { format: { type: 'pcm', rate: 16000 } },
        output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: config.voice },
      },
      tools: TOOLS,
    };
    if (opts.resumeSessionId) session.id = opts.resumeSessionId;
    this.send({
      type: 'session.create',
      session,
      extension: {
        // Filter narration before synthesis upstream; never buffer a whole reply locally.
        // Doubao Duplex API recommends 0–100. Longer parentheticals can still be spoken.
        tts: { extra: { max_length_to_filter_parenthesis: 100 } },
        ...(config.vadSmoothMs
          ? {
              asr: {
                extra: {
                  end_smooth_window_ms: config.vadSmoothMs,
                  enable_custom_vad: true,
                },
              },
            }
          : {}),
      },
    });
    this.startPacer();
    log('duplex', 'session.create sent', {
      model: config.duplexModel,
      voice: config.voice,
      resume: opts.resumeSessionId,
    });
  }

  // ---- 上行音频：20ms 节拍器统一调速 ----
  enqueueAudio(pcm: Buffer) {
    // 拆成 640B 帧入队；队列积压 >2s 时丢旧帧保实时性
    for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
      this.audioQueue.push(pcm.subarray(i, i + FRAME_BYTES));
    }
    const tail = pcm.length % FRAME_BYTES;
    if (tail) this.audioQueue.push(Buffer.concat([pcm.subarray(pcm.length - tail), Buffer.alloc(FRAME_BYTES - tail)]));
    if (this.audioQueue.length > 100) this.audioQueue.splice(0, this.audioQueue.length - 100);
  }

  private startPacer() {
    this.nextTick = Date.now() + FRAME_MS;
    const tick = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.injectQueue.length) {
        const frame = this.injectQueue.shift()!;
        this.send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
        // 注入（cue/poke/打字话音）独占声道：积压的麦克风帧丢掉——混不进去，事后再放也只会
        // 被 injectWindows 当注入回声压掉，或变成延迟几秒的幽灵语音
        this.audioQueue.length = 0;
        if (!this.injectQueue.length && this.muted !== this.serverMuted) this.commitMute(this.muted);
      } else if (!this.muted) {
        const frame = this.audioQueue.shift() ?? Buffer.alloc(FRAME_BYTES);
        this.send({ type: 'input_audio_buffer.append', audio: frame.toString('base64') });
      }
      this.nextTick += FRAME_MS;
      const delay = Math.max(1, this.nextTick - Date.now());
      if (delay > FRAME_MS * 2) this.nextTick = Date.now() + FRAME_MS; // 落后太多则重置
      this.paceTimer = setTimeout(tick, delay);
    };
    this.paceTimer = setTimeout(tick, FRAME_MS);
  }

  private stopPacer() {
    if (this.paceTimer) clearTimeout(this.paceTimer);
  }

  private commitMute(muted: boolean) {
    if (muted === this.serverMuted) return;
    this.serverMuted = muted;
    this.send({ type: muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' });
  }

  setMuted(muted: boolean) {
    if (muted === this.muted) return;
    this.muted = muted;
    if (!this.injectQueue.length) this.commitMute(muted);
    if (!muted) this.audioQueue.length = 0;
    log('duplex', muted ? 'mic muted (mute.commit)' : 'mic open (unmute.commit)');
  }

  // ---- 注入音频：服务端产出的 PCM16k，当"现场声音/用户话音"喂给演员触发真回合 ----
  injectAudio(pcm: Buffer) {
    for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
      this.injectQueue.push(pcm.subarray(i, i + FRAME_BYTES));
    }
    const tail = pcm.length % FRAME_BYTES;
    if (tail) this.injectQueue.push(Buffer.concat([pcm.subarray(pcm.length - tail), Buffer.alloc(FRAME_BYTES - tail)]));
    if (this.serverMuted) this.commitMute(false); // 用户关麦时注入音也要能进：临时开闸
  }

  get injectMs() {
    return this.injectQueue.length * FRAME_MS;
  }
  clearInject() {
    this.injectQueue.length = 0;
  }

  // ---- 导演通道 ----
  speak(text: string) {
    const clean = stripStage(text);
    if (!clean) {
      log('duplex', `speak skip (empty after strip): ${text.slice(0, 50)}`);
      return;
    }
    log('duplex', `speak: ${clean.slice(0, 60)}`);
    this.send({ type: 'speech_text_buffer.commit', text: clean });
  }

  injectItems(items: unknown[]) {
    this.send({ type: 'conversation.item.create', items });
  }

  injectNarration(text: string) {
    this.injectItems([{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }]);
  }

  injectAssistant(text: string) {
    this.injectItems([{ type: 'message', role: 'assistant', content: [{ type: 'input_text', text }] }]);
  }

  injectTurnPair(userText: string, assistantText: string) {
    this.injectItems([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: assistantText }] },
    ]);
  }

  returnToolResults(calls: { call_id: string; result: unknown }[]) {
    this.injectItems(
      calls.map((c) => ({
        call_id: c.call_id,
        role: 'tool',
        content: [{ type: 'input_text', text: JSON.stringify(c.result) }],
      })),
    );
  }

  cancelResponse() {
    this.send({ type: 'response.cancel' });
  }

  send(obj: unknown) {
    if ((obj as { type?: string })?.type !== 'input_audio_buffer.append')
      traceEvent('duplex.send', { message: obj, delivered: this.ws?.readyState === WebSocket.OPEN });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async close() {
    this.closedByUs = true;
    this.stopPacer();
    try {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const ws = this.ws;
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            ws.off('message', onMessage);
            ws.off('close', done);
            resolve();
          };
          const onMessage = (raw: WebSocket.RawData) => {
            try {
              if (JSON.parse(raw.toString()).type === 'session.closed') done();
            } catch {
              /* ignore non-JSON frames */
            }
          };
          const timer = setTimeout(done, 800);
          ws.on('message', onMessage);
          ws.once('close', done);
          this.send({ type: 'session.close' });
        });
      }
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}

// speech_text_buffer 是口播文本：剥掉括号/书名号包裹的舞台提示，避免被念出来

// 宽容解析：模型偶尔写枚举外的中文描述，按关键词归一到最近枚举
const KW = {
  emotion: [
    [/惊喜|惊讶|吃惊|愣/, 'surprised'],
    [/警惕|防备|戒备|紧绷|紧张/, 'guarded'],
    [/温柔|暖|开心|高兴|雀跃|期待|好奇|轻松|笑/, 'warm'],
    [/微笑|浅笑/, 'soft_smile'],
    [/伤|怅|郁|忧|落寞|若有所思|悠远|怀念|平静|沉浸|放空/, 'wistful'],
  ],
  action: [
    [/杯|抱杯|捧/, 'hug_cup'],
    [/门|门口|门外/, 'glance_door'],
    [/照片|屏幕|展示|举.*给你看/, 'show_photo'],
    [/头发|发夹|撩|拨/, 'tuck_hair'],
    [/站|起身|起来/, 'stand_up'],
  ],
  camera: [
    [/门/, 'pan_door'],
    [/特写|近|推|聚焦/, 'close_up'],
    [/拉远|远|退/, 'pull_back'],
    [/缓推|靠近/, 'slow_push'],
  ],
  fx: [
    [/雷|闪|停电|灯.*灭|灭.*灯/, 'lightning'],
    [/雨.*大|暴雨|雨.*强/, 'rain_heavy'],
    [/雨.*小|雨停|雨.*弱|雨.*远/, 'rain_stop'],
    [/灯.*暗|暗.*灯|关灯|打烊/, 'lights_dim'],
  ],
} as const;

// ---------- 姿态校正引擎 ----------
// AI 一次传完整 gesture；这里按"clamp → 硬冲突 → 能量预算 → 兜底"顺序强制校正，
// 校正明细随工具回执返回给模型，让它下一回合自行收敛。

export interface GestureCorrection {
  field: string;
  from: unknown;
  to: unknown;
  reason: string;
}
export interface ParsedDirective {
  directive: StageDirective;
  corrections: GestureCorrection[];
}

const HAND_ANCHORS = ['rest', 'head_side', 'face', 'chest', 'lap', 'table', 'forward_low', 'forward_eye'] as const;
const PROPS = ['none', 'cup', 'photo', 'phone'] as const;
const GAZES = ['user', 'door', 'window', 'down', 'prop', 'away'] as const;
const MOTION_ACTIONS = ['idle', 'walk', 'turn', 'dance', 'stand_up', 'sit_down'] as const;
const MOTION_DIRECTIONS = ['left', 'right', 'forward', 'back'] as const;
const MOTION_STYLES = ['casual', 'brisk', 'playful'] as const;
const FORWARD_HANDS = new Set(['table', 'forward_low', 'forward_eye']);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))
      ? Number(v)
      : undefined;

// gesture 是否是"她把照片递到眼前"：道具 photo + 手举到 forward_*（chest/lap 是收着不算展示）
export function showsPhoto(g: Gesture | undefined): boolean {
  if (!g || g.prop !== 'photo') return false;
  const SHOWING = new Set(['forward_low', 'forward_eye']);
  return SHOWING.has(g.hand_r ?? '') || SHOWING.has(g.hand_l ?? '');
}

export function normalizeMotion(raw: unknown): { motion?: Motion; corrections: GestureCorrection[] } {
  const corrections: GestureCorrection[] = [];
  const fix = (field: string, from: unknown, to: unknown, reason: string) =>
    corrections.push({ field, from, to, reason });
  if (typeof raw !== 'object' || !raw) return { corrections };
  const src = raw as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
  const action = pick(src.action, MOTION_ACTIONS);
  if (!action) return { corrections };
  const motion: Motion = { action };
  const direction = pick(src.direction, MOTION_DIRECTIONS);
  const style = pick(src.style, MOTION_STYLES);
  if (direction && (action === 'walk' || action === 'turn')) motion.direction = direction;
  else if (direction) fix('motion.direction', direction, undefined, 'direction_not_used_by_action');
  if (style) motion.style = style;
  const duration = num(src.duration_ms);
  if (duration !== undefined) {
    const d = Math.min(12000, Math.max(800, duration));
    if (d !== duration) fix('motion.duration_ms', duration, d, 'clamped');
    motion.duration_ms = d;
  }
  return { motion, corrections };
}

export function normalizeGesture(raw: unknown): { gesture?: Gesture; corrections: GestureCorrection[] } {
  const corrections: GestureCorrection[] = [];
  const fix = (field: string, from: unknown, to: unknown, reason: string) =>
    corrections.push({ field, from, to, reason });
  if (typeof raw === 'string') {
    // 模型惯性输出旧枚举/中文：走老映射
    const g = legacyGestureString(raw);
    if (g) fix('gesture', raw, g, 'legacy_action_mapped');
    return { gesture: g, corrections };
  }
  if (typeof raw !== 'object' || !raw) return { corrections };
  const src = raw as Record<string, unknown>;
  const pickStr = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
    typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

  const g: Gesture = {};
  if (pickStr(src.posture, ['sit', 'stand'] as const)) g.posture = pickStr(src.posture, ['sit', 'stand'] as const);
  const hr = pickStr(src.hand_r, HAND_ANCHORS),
    hl = pickStr(src.hand_l, HAND_ANCHORS);
  if (hr && hr !== 'rest') g.hand_r = hr;
  if (hl && hl !== 'rest') g.hand_l = hl;
  if (pickStr(src.hands, ['hold_center'] as const)) g.hands = 'hold_center';
  const prop = pickStr(src.prop, PROPS);
  if (prop && prop !== 'none') g.prop = prop;
  const lean = num(src.torso && (src.torso as Record<string, unknown>).lean);
  const turn = num(src.torso && (src.torso as Record<string, unknown>).turn);
  const pitch = num(src.head && (src.head as Record<string, unknown>).pitch);
  const tilt = num(src.head && (src.head as Record<string, unknown>).tilt);
  const gaze = pickStr(src.gaze, GAZES);
  if (gaze && gaze !== 'user') g.gaze = gaze;
  const hold = num(src.hold_ms);

  // ① clamp：连续量物理范围（后仰比前倾限得紧——椅子有靠背）
  const clampN = (field: string, v: number | undefined, lo: number, hi: number) => {
    if (v === undefined) return undefined;
    const c = Math.min(hi, Math.max(lo, v));
    if (c !== v) fix(field, v, c, 'clamped');
    return c;
  };
  const cLean = clampN('torso.lean', lean, -0.5, 1);
  const cTurn = clampN('torso.turn', turn, -0.7, 0.7);
  const cPitch = clampN('head.pitch', pitch, -0.7, 0.4);
  const cTilt = clampN('head.tilt', tilt, -0.6, 0.6);
  if (cLean || cTurn) g.torso = { ...(cLean ? { lean: cLean } : {}), ...(cTurn ? { turn: cTurn } : {}) };
  if (cPitch || cTilt) g.head = { ...(cPitch ? { pitch: cPitch } : {}), ...(cTilt ? { tilt: cTilt } : {}) };
  if (hold !== undefined) {
    const h = Math.min(8000, Math.max(800, hold));
    if (h !== hold) fix('hold_ms', hold, h, 'clamped');
    g.hold_ms = h;
  }

  // ② 硬冲突：物理矛盾按规则改写，逐条可测
  if (g.hands && (g.hand_r || g.hand_l)) {
    fix('hand_r/hand_l', [g.hand_r, g.hand_l], undefined, 'hands_overrides_singles');
    delete g.hand_r;
    delete g.hand_l;
  }
  if (g.hand_r && g.hand_l && g.hand_r === g.hand_l) {
    fix('hand_l', g.hand_l, undefined, 'both_hands_same_anchor');
    delete g.hand_l;
  }
  const anyHand = () => !!(g.hand_r || g.hand_l || g.hands);
  if (g.prop && !anyHand()) {
    g.hand_r = 'forward_low';
    fix('hand_r', undefined, 'forward_low', 'prop_needs_hand');
  }
  if (g.gaze === 'prop' && !g.prop) {
    g.gaze = 'down';
    fix('gaze', 'prop', 'down', 'no_prop_to_watch');
  }
  if ((g.torso?.lean ?? 0) < -0.3) {
    const reaching = (g.hand_r && FORWARD_HANDS.has(g.hand_r)) || (g.hand_l && FORWARD_HANDS.has(g.hand_l));
    if (reaching) {
      fix('torso.lean', g.torso!.lean, -0.3, 'cant_reach_forward_leaning_back');
      g.torso = { ...g.torso, lean: -0.3 };
    }
  }
  if (Math.abs(g.torso?.turn ?? 0) > 0.5 && !g.gaze) {
    // 大幅转身却默认看着用户 → 收转身（看用户的优先级高于转身）
    const t = Math.sign(g.torso!.turn!) * 0.5;
    fix('torso.turn', g.torso!.turn, t, 'turn_limited_while_facing_user');
    g.torso = { ...g.torso, turn: t };
  }
  if ((g.head?.pitch ?? 0) < -0.5 && !g.gaze) {
    // 埋头时视线跟着下去，不强行抬头看人
    g.gaze = 'down';
    fix('gaze', undefined, 'down', 'gaze_follows_bowed_head');
  }

  // ③ 能量预算：偏离 rest 的总量有上限，超限先等比收缩连续量，再砍低位手
  const handEnergy =
    (g.hand_r ? 0.7 : 0) + (g.hand_l ? 0.7 : 0) + (g.hands ? 0.7 : 0) + (g.posture === 'stand' ? 0.5 : 0);
  let contEnergy =
    Math.abs(g.torso?.lean ?? 0) +
    Math.abs(g.torso?.turn ?? 0) +
    Math.abs(g.head?.pitch ?? 0) +
    Math.abs(g.head?.tilt ?? 0);
  const BUDGET = 2.6;
  if (handEnergy + contEnergy > BUDGET && contEnergy > 0) {
    const k = Math.max(0.3, (BUDGET - handEnergy) / contEnergy);
    const scale = (v?: number) => (v === undefined ? undefined : v * k);
    if (g.torso) g.torso = { lean: scale(g.torso.lean), turn: scale(g.torso.turn) };
    if (g.head) g.head = { pitch: scale(g.head.pitch), tilt: scale(g.head.tilt) };
    fix('torso/head', contEnergy, contEnergy * k, 'pose_energy_budget');
    contEnergy *= k;
  }
  if (handEnergy + contEnergy > BUDGET) {
    if (g.hand_l) {
      fix('hand_l', g.hand_l, undefined, 'pose_energy_budget');
      delete g.hand_l;
    } else if (g.hand_r) {
      fix('hand_r', g.hand_r, undefined, 'pose_energy_budget');
      if (g.prop) {
        fix('prop', g.prop, undefined, 'prop_lost_hand');
        delete g.prop;
      }
      delete g.hand_r;
    }
  }

  // ④ 兜底：校正后为空就不下发 gesture（保持当前姿态，不静默改成休息位）
  return { gesture: Object.keys(g).length ? g : undefined, corrections };
}

// 旧枚举名/中文描述 → 原子姿态（模型惯性输出的兼容通道）
function legacyGestureString(v: string): Gesture | undefined {
  for (const part of v.split(/[|,，/、\s]+/)) {
    const g = gestureForLegacy(part as Action);
    if (g) return g;
  }
  for (const [re, val] of KW.action) {
    if (re.test(v)) return gestureForLegacy(val as Action);
  }
  return undefined;
}

export function parseDirective(args: Record<string, unknown>): ParsedDirective {
  const pick = <T extends string>(
    v: unknown,
    allowed: readonly T[],
    table: readonly (readonly [RegExp, string])[],
  ): T | undefined => {
    if (typeof v !== 'string' || !v) return undefined;
    // 模型偶尔输出 'a|b' 或 'a,b' —— 取第一个合法枚举
    for (const part of v.split(/[|,，/、\s]+/)) {
      if ((allowed as readonly string[]).includes(part)) return part as T;
    }
    for (const [re, val] of table) if (re.test(v)) return val as T;
    return undefined;
  };
  // 兼容旧字段：gesture 对象优先；action 字符串走老映射
  const g = normalizeGesture(args.gesture ?? args.action);
  const m = normalizeMotion(args.motion);
  return {
    directive: {
      emotion: pick(
        args.emotion,
        ['neutral', 'soft_smile', 'wistful', 'surprised', 'warm', 'guarded'] as const,
        KW.emotion,
      ),
      motion: m.motion,
      gesture: g.gesture,
      camera: pick(
        args.camera,
        ['none', 'idle_drift', 'slow_push', 'close_up', 'pull_back', 'pan_door'] as const,
        KW.camera,
      ),
      fx: pick(args.fx, ['none', 'rain_heavy', 'lightning', 'lights_dim', 'rain_stop'] as const, KW.fx),
    },
    corrections: [...g.corrections, ...m.corrections],
  };
}
