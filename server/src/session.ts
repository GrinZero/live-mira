import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { DuplexClient, parseDirective, showsPhoto, stripStage } from './duplex.js';
import { Director } from './director.js';
import { createGenImg } from './genimg.js';
import { loadContent } from './content.js';
import { config } from './config.js';
import { log } from './log.js';
import type { DownMessage, MediaEvent, UpMessage } from '../../shared/protocol.js';

// 一个浏览器连接 = 一场戏。Session 桥接：浏览器 WS ⇄ Duplex WS，
// 内含导演 agent、生图管线、事件池、打断、会话恢复、录制回放。

const content = loadContent();
const sessions = new Map<string, ClientSession>();
const liveSessions = new Set<ClientSession>();

export function getSession(id: string) {
  return sessions.get(id);
}
export function liveSessionCount() {
  return liveSessions.size;
}

export class ClientSession {
  private ws?: WebSocket;
  private duplex?: DuplexClient;
  private director: Director;
  private genimg: ReturnType<typeof createGenImg>;
  private miraText = '';
  private pendingVoiceUser = '';
  private curResponseId = '';
  private cancelledRids = new Set<string>();
  private endedAudio = new Set<string>(); // output_audio.done 已到的 rid；响应仍开着时上游补的尾音一律丢弃
  private lateLogged = new Set<string>(); // 每个 rid 只记一条日志，防刷屏
  private speaking = false;
  private entered = false;
  private userSpeaking = false;
  private userSpeakingAt = 0; // 幻影 transcription.started（无 completed）会把闸门焊死：靠时间戳自愈
  private sentUserPartial = false; // 本轮是否给客户端发过非空转写；空 final 据此决定发不发
  private playingUntil = 0;
  private currentSceneUrl = '/assets/bg/cafe_interior.jpg';
  private currentFgUrl?: string; // 当前场景的前景板（含 self-band 兜底），随场景切换清掉
  private latestSceneRequest = '';
  private latestMomentRequest = '';
  private stagedScene?: MediaEvent;
  private alive = true;
  private reconnects = 0;
  private tickTimer?: NodeJS.Timeout;
  private recStream?: fs.WriteStream;
  private recAudio?: fs.WriteStream;
  private recT0 = 0;
  private seenFirstAudio = false;
  private tSpeechEnd = 0;
  private tFirstAudio = 0;
  private lastAudioEndAt = 0; // done 到达时间；音频突发下发，客户端还在播 → 打断宽限窗
  private graceTimer?: NodeJS.Timeout;
  private clientToken = ''; // hello 绑定的会话令牌：reattach 必须持同令牌，sid 本身不是凭据
  private textRate = { n: 0, reset: 0 };
  private lastBufWarn = 0;

  constructor(private clientTag: string) {
    this.director = new Director(content, {
      injectNarration: (t) => this.duplex?.injectNarration(t),
      speak: (line) => this.speakLine(line),
      sendDirective: (d) => this.send({ type: 'directive', directive: d }),
      genimg: (kind, theme, opts) => {
        // overlay = 在当前底图上做 i2i 编辑：基底锚定正在显示的场景，TTL 兜底寿命
        if (kind === 'overlay' && !opts?.overlay) {
          opts = { ...opts, overlay: { base: this.director.sceneKey, url: this.currentSceneUrl, ttlMs: 90000 } };
        }
        this.genimg.generate(kind, theme, opts);
      },
      injectAssistant: (t) => this.duplex?.injectAssistant(t),
      injectTurnPair: (u, m) => this.duplex?.injectTurnPair(u, m),
      narrateToClient: (t) => this.send({ type: 'narration', text: t }),
      story: (story) => this.send({ type: 'story', story }),
      available: () =>
        this.alive &&
        !!this.duplex?.connected &&
        this.entered &&
        this.ws?.readyState === WebSocket.OPEN &&
        !this.speaking &&
        Date.now() > this.playingUntil &&
        !this.isUserSpeaking(),
    });
    liveSessions.add(this);
    this.genimg = createGenImg({
      styleTemplate: content.styleTemplate,
      sceneBodies: content.sceneBodies,
      sendMedia: (e) => {
        if (!this.alive) return;
        const request = e.context_id ?? e.id;
        if (e.kind === 'scene') {
          if (e.status === 'generating') this.latestSceneRequest = request;
          else if (this.latestSceneRequest && this.latestSceneRequest !== request) {
            this.director.onMediaSettled(e.context_id);
            return;
          } else this.latestSceneRequest = request;
        }
        if (e.purpose === 'moment') {
          if (e.status === 'generating') this.latestMomentRequest = request;
          else if (this.latestMomentRequest && this.latestMomentRequest !== request) {
            this.director.onMediaSettled(e.context_id);
            return;
          } else this.latestMomentRequest = request;
        }
        if (e.status !== 'generating') this.director.onMediaSettled(e.context_id);
        if (e.kind === 'scene' && e.status === 'ready' && e.scene_key && e.url) {
          this.stagedScene = e; // Commit the location only once the browser can display it.
        }
        if (e.kind === 'foreground' && e.status === 'ready' && e.url && e.scene_key === this.director.sceneKey) {
          this.currentFgUrl = e.url;
        }
        if (e.kind === 'scene' && e.status === 'failed') this.director.sceneFailed();
        this.send({ type: 'media.event', event: e });
      },
      onDegrade: (reason) => this.director.degradeFor(reason),
    });
  }

  // ---------- 生命周期 ----------
  // 会话令牌：hello 上行时绑定；reattach 必须持同令牌，sid 本身不是凭据
  owns(token?: string) {
    // 失败即关闭：无令牌会话（老客户端/异常路径）拒绝一切 reattach，宁可丢会话不可被接管
    return this.clientToken !== '' && this.clientToken === token;
  }

  async start(ws: WebSocket, hello?: { session_id?: string; client_token?: string }) {
    this.ws = ws;
    this.clientToken = hello?.client_token ?? '';
    // Only sessions found in the local map are resumed. An unknown upstream id
    // would restore the actor without its world/memory, creating split context.
    const resumeSid = undefined;
    if (config.record) this.openRecorder();

    this.duplex = new DuplexClient({
      onEvent: (e) => this.onDuplexEvent(e),
      onClose: (code, reason) => this.onDuplexClose(code, reason),
    });
    try {
      await this.duplex.connect({ instructions: this.director.instructions, resumeSessionId: resumeSid });
    } catch (e) {
      log('session', `duplex connect fail: ${(e as Error).message}`);
      this.send({ type: 'error', code: 'duplex_connect', message: '语音服务连接失败，请重试' });
      return;
    }
    this.tickTimer = setInterval(() => this.tick(), 250);
  }

  private openRecorder() {
    fs.mkdirSync(config.recordingsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.recStream = fs.createWriteStream(path.join(config.recordingsDir, `session-${stamp}.jsonl`));
    this.recAudio = fs.createWriteStream(path.join(config.recordingsDir, `session-${stamp}.pcm`));
    this.recT0 = Date.now();
    log('session', `recording → recordings/session-${stamp}.*`);
  }

  private rec(type: string, payload: unknown, audioBytes = 0) {
    if (!this.recStream) return;
    this.recStream.write(JSON.stringify({ t: Date.now() - this.recT0, type, payload, audio: audioBytes }) + '\n');
  }

  // 滑动窗口限速：15 条/分钟。语音回合按字节流不进此路径
  private textThrottled(): boolean {
    const now = Date.now();
    if (now > this.textRate.reset) this.textRate = { n: 0, reset: now + 60_000 };
    return ++this.textRate.n > 15;
  }

  // 用户说话中压事件；但 started 之后 12s 没有新转写消息就当幻影自愈
  private isUserSpeaking() {
    if (this.userSpeaking && Date.now() - this.userSpeakingAt > 12000) {
      this.userSpeaking = false;
      log('session', 'stale userSpeaking cleared (phantom transcription.started)');
    }
    return this.userSpeaking;
  }

  // ---------- 上行：浏览器消息 ----------
  async onClientMessage(msg: UpMessage | Buffer) {
    if (Buffer.isBuffer(msg)) {
      // 二进制帧 = PCM16k 音频
      this.duplex?.enqueueAudio(msg);
      return;
    }
    switch (msg.type) {
      case 'hello':
        /* handled in index via session map */ break;
      case 'enter': {
        // 开场：轻触进入 → 开麦 + 开场白（导演递词）+ 初始 directive
        if (this.entered) break;
        this.entered = true;
        this.send({ type: 'story', story: this.director.story.view() });
        const line = content.openingLines[Math.floor(Math.random() * content.openingLines.length)];
        this.send({ type: 'directive', directive: { emotion: 'guarded', camera: 'idle_drift', fx: 'rain_heavy' } });
        this.duplex?.injectAssistant(line);
        this.speakLine(line);
        this.director.noteMira(line);
        this.send({ type: 'state', phase: 'speaking' });
        log('session', 'enter → opening line');
        break;
      }
      case 'user.activity':
        this.director.noteUserActivity();
        break;
      case 'mic':
        this.duplex?.setMuted(msg.muted);
        break;
      case 'choice': {
        const text = this.director.choose(msg.id);
        if (text) {
          this.send({ type: 'transcript.user', text, final: true });
          await this.onClientMessage({ type: 'text', text });
        }
        break;
      }
      case 'scene.presented': {
        const scene = this.stagedScene;
        if (!scene || scene.id !== msg.id) break;
        this.stagedScene = undefined;
        if (msg.ok && scene.url && scene.scene_key) {
          this.currentSceneUrl = scene.url;
          this.currentFgUrl = undefined;
          this.director.sceneReady(scene.scene_key, scene.subject ?? scene.scene_key);
          // 前景板：地点落定后补一层 i2i 近景（锚定刚上屏的这张底图，生成期间前景淡出浮现）
          if (scene.scene_key !== 'cafe_interior') {
            const file = scene.url.startsWith('/media/')
              ? path.join(config.cacheDir, 'media', path.basename(scene.url))
              : scene.url.startsWith('/assets/bg/')
                ? path.join(config.assetsDir, 'bg', path.basename(scene.url))
                : undefined;
            this.genimg.generate('foreground', scene.subject ?? scene.scene_key, {
              sceneKey: scene.scene_key,
              overlay: { base: scene.scene_key, file: file && fs.existsSync(file) ? file : undefined, url: scene.url },
            });
          }
        } else this.director.sceneFailed();
        break;
      }
      case 'playback': {
        if (msg.response_id !== this.curResponseId || this.cancelledRids.has(msg.response_id)) break;
        const remaining = Number.isFinite(msg.remaining_ms) ? Math.max(0, Math.min(120000, msg.remaining_ms)) : 0;
        this.playingUntil = Date.now() + remaining;
        if (!remaining) this.director.played();
        break;
      }
      case 'text': {
        // 每条文字回合都是付费 LLM 调用：按会话限速防刷（choice 经内部 text 也计数）
        if (this.textThrottled()) {
          this.send({ type: 'error', code: 'rate_limited', message: '慢一点，我还在消化刚才的话。' });
          break;
        }
        this.handleInterrupt('client');
        this.send({ type: 'state', phase: 'thinking' });
        await this.director.handleTextTurn(msg.text); // 注入音频→真回合；之后状态由下行音频事件驱动
        break;
      }
      case 'interrupt':
        this.handleInterrupt('client');
        break;
      case 'client.state':
        break;
      case 'ping':
        this.send({ type: 'pong', t: msg.t });
        break;
    }
  }

  // ---------- 打断 ----------
  private dropAudio = false; // 打断后丢弃迟到音频，直到下一个 audio.started
  // 打断余波/用户说话中到达的 started 多半会被上游掐死：暂扣音频一个观察窗，
  // 存活才放行播放；被砍则整段丢弃——客户端连 audio.begin 都收不到，避免"嘟"残片
  private pending?: {
    rid: string;
    pcm: Buffer[];
    text: string[];
    textDone?: Record<string, unknown>;
    timer: NodeJS.Timeout;
  };

  private holdResponse(rid: string) {
    this.discardPending('superseded');
    this.curResponseId = rid; // 让打断能 cancel 到它
    this.pending = { rid, pcm: [], text: [], timer: setTimeout(() => this.promotePending(), 400) };
    log('session', `response held (suspect) rid=${rid}`);
  }

  private promotePending() {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = undefined;
    if (this.cancelledRids.has(p.rid)) return;
    this.beginResponse(p.rid);
    for (const b of p.pcm) {
      this.recAudio?.write(b);
      this.rec('audio.pcm', {}, b.length);
      this.sendBinary(b);
    }
    for (const delta of p.text) this.send({ type: 'transcript.mira', delta, response_id: p.rid });
    if (p.textDone) this.handleTextDone(p.textDone);
  }

  private discardPending(reason: string) {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    log('session', `held response dropped (${reason}) rid=${this.pending.rid} heldPcm=${this.pending.pcm.length}`);
    this.pending = undefined;
  }

  // 迟到的 audio.delta：audio.done 之后上游仍可能在开着的响应里补发几帧（无 audio.begin、
  // 无字幕、无日志的裸 PCM——直达客户端就是一声无源怪响）；非当前响应的散帧同理丢弃。
  private dropLateAudio(rid: string, bytes: number) {
    this.rec('audio.late', { rid, n: bytes }, bytes);
    if (this.lateLogged.has(rid)) return;
    this.lateLogged.add(rid);
    if (this.lateLogged.size > 64) this.lateLogged.delete(this.lateLogged.values().next().value!);
    log('session', `late audio dropped rid=${rid} n=${bytes}B`);
  }

  private closeAudio(rid: string) {
    this.endedAudio.add(rid);
    if (this.endedAudio.size > 64) this.endedAudio.delete(this.endedAudio.values().next().value!);
  }

  private handleTextDone(evt: Record<string, unknown>) {
    const user = this.pendingVoiceUser;
    this.pendingVoiceUser = '';
    const reply = String(evt.text ?? this.miraText);
    if (user && reply.trim()) {
      this.director.noteMira(reply);
      void this.director.handleVoiceWorld(user, reply);
    }
  }

  private beginResponse(rid: string) {
    this.dropAudio = false;
    this.curResponseId = rid;
    this.speaking = true;
    this.send({ type: 'audio.begin', response_id: rid, sample_rate: 24000 });
    this.send({ type: 'state', phase: 'speaking' });
    if (!this.seenFirstAudio && this.tSpeechEnd) {
      this.tFirstAudio = Date.now();
      log('session', `first-audio latency ≈ ${this.tFirstAudio - this.tSpeechEnd}ms`);
      this.seenFirstAudio = true;
    }
  }

  handleInterrupt(source: 'client' | 'server_vad') {
    // 音频突发下发：output_audio.done 后客户端仍有几秒在播 → 宽限窗内仍受理打断
    this.director.invalidate();
    if (!this.speaking && Date.now() > this.playingUntil && Date.now() - this.lastAudioEndAt > 6000) return;
    this.speaking = false;
    this.playingUntil = 0;
    this.director.interrupted();
    this.discardPending('interrupt');
    this.dropAudio = true;
    if (this.curResponseId) this.cancelledRids.add(this.curResponseId);
    this.duplex?.cancelResponse();
    this.duplex?.clearInject();
    this.miraText = ''; // 被砍回合的残留文本不带入下一条 noteMira
    this.send({ type: 'interrupted' });
    this.send({ type: 'audio.end', response_id: this.curResponseId, interrupted: true });
    this.send({ type: 'state', phase: 'listening' });
    this.director.lastSpeechEnd = Date.now();
    this.director.lastUserAt = Date.now(); // 打断本身即用户活动
    log('session', `interrupt (${source}) rid=${this.curResponseId}`);
  }

  // ---------- 下行：Duplex 事件 ----------
  private onDuplexEvent(evt: Record<string, unknown>) {
    const t = String(evt.type ?? '');
    this.rec(t, evt.type === 'response.output_audio.delta' ? { n: String(evt.delta ?? '').length } : evt);

    if (t === 'session.created' || t === 'session.updated') {
      const sess = evt.session as Record<string, unknown> | undefined;
      const sid = String(sess?.id ?? evt.session_id ?? '');
      if (sid) {
        sessions.set(sid, this);
        this.send({ type: 'session', session_id: sid, resumed: false });
      }
      return;
    }

    // 用户语音转写流（服务端 VAD 产出）
    if (t.includes('transcription')) {
      const text = String(evt.text ?? evt.transcript ?? evt.delta ?? '');
      this.director.noteUserActivity(); // 真实用户语音活动：重置静默钟，压住进行中的 cue/poke 注入
      if (t.endsWith('started')) {
        this.pendingVoiceUser = '';
        this.userSpeaking = true;
        this.userSpeakingAt = Date.now();
        if (text.trim()) {
          this.send({ type: 'transcript.user', text, final: false });
          this.sentUserPartial = true;
        }
        if (this.speaking || Date.now() < this.playingUntil)
          this.handleInterrupt('server_vad'); // 服务端打断信号
        else this.send({ type: 'state', phase: 'listening' });
      } else if (t.endsWith('completed') || t.endsWith('done')) {
        this.userSpeaking = false;
        if (text.trim() || this.sentUserPartial) this.send({ type: 'transcript.user', text, final: true });
        this.sentUserPartial = false;
        if (text.trim()) {
          this.discardPending('user turn'); // 用户新一轮输入取代暂扣中的可疑响应
          this.pendingVoiceUser = this.director.noteUser(text);
          this.send({ type: 'state', phase: 'thinking' });
          this.tSpeechEnd = Date.now();
          this.seenFirstAudio = false;
        }
      } else {
        this.userSpeakingAt = Date.now(); // 转写增量也算说话活动，续命自愈窗
        if (text.trim()) {
          this.send({ type: 'transcript.user', text, final: false });
          this.sentUserPartial = true;
        }
      }
      return;
    }

    switch (t) {
      case 'response.output_audio.started': {
        const rid = String(evt.response_id ?? evt.id ?? `r${Date.now()}`);
        this.endedAudio.delete(rid); // 同一 rid 重开音频段时放行
        if (this.cancelledRids.has(rid)) break;
        if (this.pending) this.promotePending(); // 串行协议：新 started 意味着上一个已存活
        if (this.dropAudio || this.userSpeaking) {
          this.holdResponse(rid);
          break;
        }
        this.beginResponse(rid);
        break;
      }
      case 'response.output_audio.delta': {
        const rid = String(evt.response_id ?? this.curResponseId ?? 'r');
        const pcm = Buffer.from(String(evt.delta ?? ''), 'base64');
        if (this.pending && rid === this.pending.rid) {
          this.pending.pcm.push(pcm);
          return;
        }
        if (this.dropAudio) return; // 打断后的迟到包直接丢弃
        if (this.cancelledRids.has(rid)) return; // epoch 守卫
        if (rid !== this.curResponseId || this.endedAudio.has(rid)) {
          this.dropLateAudio(rid, pcm.length);
          return;
        }
        this.recAudio?.write(pcm);
        this.rec('audio.pcm', {}, pcm.length);
        this.sendBinary(pcm);
        break;
      }
      case 'response.output_audio.done': {
        const rid = String(evt.response_id ?? this.curResponseId);
        this.closeAudio(rid);
        if (this.pending && rid === this.pending.rid) this.promotePending(); // 暂扣期内已交付完：整段放行
        if (this.cancelledRids.has(rid)) break;
        this.lastAudioEndAt = Date.now();
        this.send({ type: 'audio.end', response_id: rid });
        if (!this.cancelledRids.has(rid)) {
          this.speaking = false;
          // The browser owns audible completion and reports playback remaining.
          if (this.miraText.trim()) this.director.noteMira(this.miraText);
          this.director.armPhotoFromSpeech(this.miraText); // 台词里递了照片却漏调 show_photo → 兜底
          this.miraText = '';
          void this.director.prepareContinuation();
          const photo = this.director.consumeArmedPhoto();
          if (photo)
            this.genimg.generate('photo', photo.subject, { caption: photo.caption, contextId: photo.contextId });
        }
        break;
      }
      case 'response.output_text.delta': {
        const rid = String(evt.response_id ?? this.curResponseId ?? 'r');
        if (this.cancelledRids.has(rid)) return; // 与音频同 epoch 守卫：打断后迟到文本不上屏
        const delta = String(evt.delta ?? '');
        if (this.pending && rid === this.pending.rid) {
          this.miraText += delta;
          this.pending.text.push(delta);
          return;
        }
        this.miraText += delta;
        this.send({ type: 'transcript.mira', delta, response_id: rid });
        break;
      }
      case 'response.output_text.done': {
        const rid = String(evt.response_id ?? this.curResponseId);
        if (this.cancelledRids.has(rid)) break;
        if (this.pending && rid === this.pending.rid) {
          this.pending.textDone = evt;
          break;
        }
        this.handleTextDone(evt);
        break;
      }
      case 'response.function_call_arguments.done':
        this.onToolCalls(evt);
        break;
      case 'response.done':
        // 完整响应的顺序是 started→deltas→output_audio.done→response.done；
        // 暂扣期内见到 response.done = 上游已掐死（无 output_audio.done）→ 整段丢弃
        this.discardPending('response.done');
        break;
      case 'error':
      case 'session.error':
        log('session', `duplex error event`, evt);
        this.send({ type: 'error', code: String(evt.code ?? 'duplex'), message: JSON.stringify(evt).slice(0, 200) });
        break;
      default:
        if (t.includes('speech_started') || t.includes('input_audio_buffer.speech')) {
          this.director.noteUserActivity();
          if (this.speaking || Date.now() < this.playingUntil) this.handleInterrupt('server_vad');
        }
        break;
    }
  }

  // 指令随 tool call 到达即入队（客户端四队列消费）；每个 call 独立回执——
  // stage_directive 的回执带上姿态校正明细，让模型看到"被砍了什么"自行收敛
  private onToolCalls(evt: Record<string, unknown>) {
    const items = ((evt.items ?? evt.item) ? [evt.item] : []) as Record<string, unknown>[];
    const list = Array.isArray(evt.items) ? (evt.items as Record<string, unknown>[]) : items;
    const results: { call_id: string; result: unknown }[] = [];
    for (const it of list) {
      const name = String(it.name ?? '');
      const callId = String(it.call_id ?? it.id ?? '');
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(String(it.arguments ?? '{}'));
      } catch {
        /* noop */
      }
      log('session', `tool ${name}`, args);
      if (name === 'stage_directive') {
        const { directive, corrections } = parseDirective(args);
        if (showsPhoto(directive.gesture)) this.director.armPhotoFromSpeech('', true); // 她做了递照片的动作
        if (corrections.length) log('duplex', 'gesture corrected', corrections);
        this.send({ type: 'directive', directive });
        results.push({
          call_id: callId,
          result: {
            ok: true,
            ...(directive.motion ? { applied_motion: directive.motion } : {}),
            ...(directive.gesture ? { applied_gesture: directive.gesture } : {}),
            ...(corrections.length ? { corrections } : {}),
          },
        });
      } else if (name === 'scene_event') {
        // World updates, tied to the latest user action, own transitions.
        log('director', 'scene request deferred to user world update');
        results.push({ call_id: callId, result: { ok: false, status: 'wait_for_confirmed_world_update' } });
      } else if (name === 'show_photo') {
        const subject = String(args.subject ?? '一张旅途中的照片');
        const caption = String(args.caption ?? '');
        this.director.notePhotoDispatched(); // 演员自发调用 → 解除兜底并记时，防台词检测再叠一张
        this.director.pendingMedia = true;
        this.genimg.generate('photo', subject, { caption });
        results.push({ call_id: callId, result: { ok: true } });
      } else {
        results.push({ call_id: callId, result: { ok: true } });
      }
    }
    // 立即回传工具结果，模型续说
    if (results.length) this.duplex?.returnToolResults(results);
  }

  // ---------- 导演 tick：静默驱动 ----------
  private tick() {
    if (!this.alive || !this.duplex?.connected) return;
    const s = this.director.quietSec();
    if (
      !this.entered ||
      this.ws?.readyState !== WebSocket.OPEN ||
      this.isUserSpeaking() ||
      this.speaking ||
      Date.now() < this.playingUntil ||
      this.director.pendingMedia
    )
      return;
    this.director.advanceConversation();
    // Long silences still belong to the environment director.
    if (s > 10) void this.director.evaluate('tick').then((d) => this.director.apply(d));
  }

  // ---------- 重连 ----------
  private async onDuplexClose(code: number, _reason: string) {
    if (!this.alive) return;
    this.director.invalidate();
    this.discardPending('duplex close');
    this.send({ type: 'error', code: `duplex_close_${code}`, message: '语音链路中断，重连中…' });
    if (this.reconnects >= 3) {
      this.send({ type: 'error', code: 'duplex_gone', message: '连接失败，请刷新重进' });
      return;
    }
    this.reconnects++;
    await new Promise((r) => setTimeout(r, 800 * this.reconnects));
    if (!this.alive) return;
    try {
      const oldSid = this.duplex?.sessionId;
      this.duplex = new DuplexClient({
        onEvent: (e) => this.onDuplexEvent(e),
        onClose: (c, r) => this.onDuplexClose(c, r),
      });
      await this.duplex.connect({ instructions: this.director.instructions, resumeSessionId: oldSid });
      this.reconnects = 0;
      this.send({ type: 'state', phase: 'listening' });
      log('session', `reconnected, resume=${oldSid}`);
      // 若上游开了新会话，补注最近对话保持连续
      if (this.duplex.sessionId && oldSid && this.duplex.sessionId !== oldSid) {
        const turns = this.director.turns.slice(-20).filter((t) => t.role !== 'narration');
        for (const turn of turns) {
          this.duplex.injectItems([
            {
              type: 'message',
              role: turn.role === 'mira' ? 'assistant' : 'user',
              content: [
                { type: 'input_text', text: turn.text + (turn.interrupted ? '（这句话被打断，未必听完）' : '') },
              ],
            },
          ]);
        }
      }
    } catch (e) {
      log('session', `reconnect fail: ${(e as Error).message}`);
      void this.onDuplexClose(code, 'reconnect failed');
    }
  }

  // ---------- 注入通道：提示/打字 → TTS → 演员耳朵（触发真回合，她自己组织台词） ----------
  private speakLine(line: string) {
    this.duplex?.speak(line);
    // 递词/文字回合不经过模型工具调用：台词做了"递照片"表达就当场补生成
    this.director.armPhotoFromSpeech(line);
    const photo = this.director.consumeArmedPhoto();
    if (photo) this.genimg.generate('photo', photo.subject, { caption: photo.caption, contextId: photo.contextId });
    // speech_text_buffer 不产生 output_text 流 —— 字幕由服务端直发
    const clean = stripStage(line);
    if (clean) this.send({ type: 'transcript.mira', delta: clean, response_id: `speak_${Date.now()}` });
  }

  // ---------- 发送 ----------
  send(msg: DownMessage) {
    if (!this.alive) return;
    // 录制客户端可见事件流（mock 回放用）——与 audio.pcm 字节流同时间轴
    this.rec(msg.type, msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  private sendBinary(buf: Buffer) {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    // 客户端消费跟不上时丢帧保实时性；不能让 PCM 在发送缓冲里无界堆积
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      const now = Date.now();
      if (now - this.lastBufWarn > 5000) {
        this.lastBufWarn = now;
        log('session', `slow socket, audio dropped buffered=${(ws.bufferedAmount / 1048576).toFixed(1)}MB`);
      }
      return;
    }
    ws.send(buf);
  }

  attach(ws: WebSocket) {
    // 接管即踢前主：同一时刻只允许一个控制端；旧 ws 的 close 由 detach(ws) 的身份校验挡掉
    const prev = this.ws;
    this.ws = ws;
    if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) prev.close(4000, 'session moved');
    this.send({ type: 'story', story: this.director.story.view() });
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    const sid = this.duplex?.sessionId ?? '';
    if (sid) this.send({ type: 'session', session_id: sid, resumed: true });
    // 回放现场状态：当前场景 + 最近台词尾
    this.send({
      type: 'media.event',
      event: {
        id: 'restore',
        kind: 'scene',
        status: 'ready',
        scene_key: this.director.sceneKey,
        url: this.currentSceneUrl,
      },
    });
    if (this.currentFgUrl)
      this.send({
        type: 'media.event',
        event: {
          id: 'restore-fg',
          kind: 'foreground',
          status: 'ready',
          scene_key: this.director.sceneKey,
          url: this.currentFgUrl,
        },
      });
    const lastMira = [...this.director.turns].reverse().find((t) => t.role === 'mira');
    if (lastMira) this.send({ type: 'transcript.mira', delta: lastMira.text, response_id: 'restore' });
    this.send({ type: 'state', phase: 'listening' });
  }

  detach(ws: WebSocket) {
    // 只有当前控制端的 close 才启动宽限销毁；被踢旧连接的迟到 close 不得误杀会话
    if (this.ws !== ws) return;
    this.ws = undefined;
    this.director.invalidate();
    // 宽限 8s 供重连续接；超时销毁
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      void this.destroy();
    }, 8000);
  }

  noteSceneChange(key: string) {
    this.director.sceneKey = key;
  }

  async destroy() {
    this.alive = false;
    liveSessions.delete(this);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.recStream?.end();
    this.recAudio?.end();
    this.director.invalidate();
    await this.duplex?.close();
    // 摘除所有历史 sid（重连可能换过上游会话）：陈旧 sid 不允许再 attach 进尸体
    for (const [sid, s] of sessions) if (s === this) sessions.delete(sid);
  }
}
