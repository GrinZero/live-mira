import { SessionTrace, traceOperation } from './telemetry.js';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { worldStore, drawVisitedRegions } from './world/runtime.js';
import type { WorldLocation } from '../../shared/world.js';
import { DuplexClient, parseDirective, showsPhoto, stripStage } from './duplex.js';
import { Director } from './director.js';
import { InjectTts } from './inject-tts.js';
import { SpeechGate } from './speech-gate.js';
import { createGenImg } from './genimg.js';
import { loadContent } from './content.js';
import { config } from './config.js';
import { log } from './log.js';
import type { DownMessage, MediaEvent, UpMessage } from '../../shared/protocol.js';
import type { Decide } from './decisions.js';
import type { PhotoJudge } from './semantic/photo.js';

// 一个浏览器连接 = 一场戏。Session 桥接：浏览器 WS ⇄ Duplex WS，
// 内含导演 agent、生图管线、事件池、打断、会话恢复、录制回放。

const content = loadContent();
const sessions = new Map<string, ClientSession>();
const liveSessions = new Set<ClientSession>();

export function getSession(id: string) {
  return sessions.get(id);
}
export function getOwnedSession(token?: string) {
  return [...liveSessions].find((s) => s.owns(token));
}
export function liveSessionCount() {
  return liveSessions.size;
}

export interface SessionSemanticDeps {
  decide?: Decide | null;
  photoJudge?: PhotoJudge | null;
}

export class ClientSession {
  private _trace?: SessionTrace;
  get trace() {
    return (this._trace ??= new SessionTrace());
  }
  private worldId = '';
  private mapOpen = false;
  private restoredWorld = false;
  private savedMemory = '';
  private travel?: { id: string; originId: string; target: WorldLocation; event?: MediaEvent; intentId: string };
  private travelTimer?: NodeJS.Timeout;
  private travelIntents = new Set<string>();
  private worldError = false;

  private ws?: WebSocket;
  private duplex?: DuplexClient;
  private director: Director;
  private genimg: ReturnType<typeof createGenImg>;
  private miraText = '';
  private speechGate = new SpeechGate();
  private scriptedSpeech = false;
  private stagedPhoto?: {
    toolResponseId: string;
    contextId: string;
    subject: string;
    caption: string;
    timer: NodeJS.Timeout;
    terminal?: MediaEvent;
  };
  private blockedPhotoContexts = new Set<string>();
  private settlingPhotoContexts = new Set<string>();
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
  private injectTts = new InjectTts(); // 打字→话音注入（真回合）；懒连接，复用第二条 duplex WS
  private injectedUntil = 0; // 注入音频的 ASR 回声抑制窗：窗口内的转写事件不回显、不重复登记

  constructor(
    private clientTag: string,
    semantic: SessionSemanticDeps = {},
  ) {
    this.director = new Director(
      content,
      {
        injectNarration: (t) => this.duplex?.injectNarration(t),
        speak: (line) => this.speakLine(line),
        sendDirective: (d) => this.send({ type: 'directive', directive: d }),
        genimg: (kind, theme, opts) => {
          // overlay = 在当前底图上做 i2i 编辑：基底锚定正在显示的场景，TTL 兜底寿命
          if (kind === 'overlay' && !opts?.overlay) {
            const u = new URL(this.currentSceneUrl, 'http://local');
            const file = this.worldId ? worldStore().assetFile(u.pathname, u.searchParams.get('access') || '') : null;
            opts = {
              ...opts,
              overlay: {
                base: this.director.sceneKey,
                url: this.currentSceneUrl,
                file: file || undefined,
                ttlMs: 90000,
              },
            };
          }
          if (kind === 'scene' && this.worldId) {
            this.cancelTravel();
            this.director.invalidate();
          }
          this.genimg.generate(kind, theme, opts);
        },
        injectAssistant: (t) => this.duplex?.injectAssistant(t),
        injectTurnPair: (u, m) => this.duplex?.injectTurnPair(u, m),
        narrateToClient: (t) => this.send({ type: 'narration', text: t }),
        story: (story) => this.send({ type: 'story', story }),
        worldContext: () => {
          if (!this.worldId) return undefined;
          const w = worldStore().read(this.worldId);
          return {
            current_location_id: w.currentLocationId,
            locations: w.locations.map((l) => ({
              id: l.id,
              name: l.name,
              description: l.description,
              environment: l.environment,
            })),
            carried_objects: w.objects
              .filter((o) => o.owner.kind === 'character')
              .map((o) => ({ id: o.id, kind: o.kind, caption: o.caption })),
            travelling: !!this.travel,
          };
        },
        available: () =>
          this.alive &&
          !this.mapOpen &&
          !this.travel &&
          !this.worldError &&
          !!this.duplex?.connected &&
          this.entered &&
          this.ws?.readyState === WebSocket.OPEN &&
          !this.speaking &&
          Date.now() > this.playingUntil &&
          !this.isUserSpeaking(),
      },
      undefined,
      semantic.decide ?? null,
      semantic.photoJudge ?? null,
    );
    liveSessions.add(this);
    this.genimg = createGenImg({
      styleTemplate: content.styleTemplate,
      sceneBodies: content.sceneBodies,
      sendMedia: (e) => this.onGeneratedMedia(e),
      onDegrade: (reason) => this.director.degradeFor(reason),
    });
  }

  private onGeneratedMedia(e: MediaEvent) {
    this.trace.event('media.generated', { event: e, alive: this.alive, latestSceneRequest: this.latestSceneRequest });
    if (!this.alive) return;
    const request = e.context_id ?? e.id;
    if (e.kind === 'photo' && e.context_id) {
      const staged = this.stagedPhoto?.contextId === e.context_id;
      if (staged) {
        if (e.status !== 'generating') this.stagedPhoto!.terminal = e;
        return; // 后台生图，等最终台词确认后再决定是否下发
      }
      if (this.blockedPhotoContexts.has(e.context_id)) {
        if (e.status !== 'generating') this.blockedPhotoContexts.delete(e.context_id);
        return; // 已被最终台词否决，迟到的 ready/failed 也不能复活它
      }
    }
    if (e.kind === 'scene') {
      if (e.status === 'generating') {
        this.cancelTravel();
        this.latestSceneRequest = request;
        if (this.worldId) {
          const w = worldStore().read(this.worldId);
          this.travel = {
            id: e.id,
            originId: w.currentLocationId,
            intentId: request,
            target: {
              id: randomUUID(),
              key: e.scene_key || e.id,
              name: this.locationName(e.subject || '新的地方'),
              description: e.subject || '新的地方',
              url: '',
              firstVisitedAt: 0,
              lastVisitedAt: 0,
              visits: 0,
              x: 0,
              y: 0,
              mapStatus: 'pending',
              environment: { rain: 1, dim: 0 },
            },
          };
          this.armTravelTimeout();
          this.publishWorld();
        }
      } else if (this.latestSceneRequest && this.latestSceneRequest !== request) {
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
      if (this.worldId && this.travel?.id === e.id) {
        try {
          const url = worldStore().promote(this.worldId, e.url);
          e = { ...e, url, travel_id: this.travel.id };
          this.travel.target = {
            ...this.travel.target,
            key: e.scene_key!,
            url,
            description: e.subject || this.travel.target.description,
            fgUrl: undefined,
          };
          this.travel.event = e;
          this.publishWorld();
        } catch {
          this.failWorld('场景还没有保存好，我们留在原处。');
          this.cancelTravel();
          return;
        }
      }
      this.stagedScene = e; // Browser preparation precedes durable arrival.
    }
    if (e.kind === 'foreground' && e.status === 'ready' && e.url && e.scene_key === this.director.sceneKey) {
      this.currentFgUrl = e.url;
      if (this.worldId) {
        try {
          const url = worldStore().promote(this.worldId, e.url);
          e = { ...e, url };
          this.currentFgUrl = url;
          worldStore().update(this.worldId, e.id, 'foreground', (w) => {
            const l = w.locations.find((l) => l.id === w.currentLocationId)!;
            l.fgUrl = url;
          });
        } catch {
          /* Optional foreground leaves the durable base intact. */
        }
      }
    }
    if (e.kind === 'photo') {
      this.forwardPhotoEvent(e);
      return;
    }
    if (e.kind === 'scene' && e.status === 'failed') {
      this.director.sceneFailed();
      this.cancelTravel();
    }
    this.send({ type: 'media.event', event: e });
  }

  private forwardPhotoEvent(e: MediaEvent) {
    if (e.status === 'ready' && e.url && this.worldId) {
      try {
        const url = worldStore().promote(this.worldId, e.url);
        e = { ...e, url };
        worldStore().update(this.worldId, e.id, 'photo', (w) => {
          w.objects.push({
            id: e.id,
            kind: 'photo',
            url,
            caption: e.caption,
            owner: { kind: 'character', hand: 'left' },
          });
        });
      } catch {
        this.send({ type: 'error', code: 'photo_save', message: '照片暂时无法保存，请稍后再试。' });
        return;
      }
    }
    if (e.status !== 'generating') this.director.onMediaSettled(e.context_id);
    this.send({ type: 'media.event', event: e });
  }

  private handleTravelWords(text: string): boolean {
    if (!this.worldId) return false;
    if (this.travel && /^(算了|不去了|先不去|别走了|取消|不用去了)[吧了。！!\s]*$/.test(text.trim())) {
      this.cancelTravel();
      this.handleInterrupt('client');
      this.send({ type: 'state', phase: 'listening' });
      return true;
    }
    if (!/(回到|回去|返回|回刚才|再去|回.*咖啡)/.test(text) || /[?？]|要不要|能不能|想不想|不要|别回/.test(text))
      return false;
    const w = worldStore().read(this.worldId);
    const matches = w.locations.filter(
      (l) => text.includes(l.name) || (l.key === 'cafe_interior' && /咖啡馆/.test(text)),
    );
    if (matches.length !== 1) return false;
    this.returnTo(matches[0].id, randomUUID());
    return true;
  }
  private locationName(description: string) {
    const destination = description.match(/目的地（([^）]+)）/)?.[1];
    return (destination || description.split(/[。！\n]/)[0]).slice(0, 24);
  }
  private failWorld(message: string) {
    this.worldError = true;
    this.send({ type: 'error', code: 'world_storage', message });
  }
  private publishWorld() {
    if (!this.worldId) return;
    const world = worldStore().view(this.worldId);
    if (this.travel)
      world.travel = {
        id: this.travel.id,
        targetId: this.travel.target.id,
        status: this.travel.event ? 'ready' : 'preparing',
      };
    this.send({ type: 'world', world });
  }
  private checkpointWorld() {
    if (!this.worldId || !this.entered) return;
    const memory = JSON.stringify(this.director.turns);
    if (memory === this.savedMemory) return;
    try {
      worldStore().update(this.worldId, randomUUID(), 'memory', (w) => {
        w.memory = this.director.turns.slice(-80);
      });
      this.savedMemory = memory;
      this.worldError = false;
    } catch {
      if (!this.worldError) this.failWorld('对话暂时无法保存，请检查连接后重试。');
    }
  }
  private sendForeground(url: string, key: string) {
    this.send({
      type: 'media.event',
      event: { id: 'restore-fg', kind: 'foreground', status: 'ready', scene_key: key, url },
    });
  }
  private restoreScene() {
    this.publishWorld();
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
    if (this.currentFgUrl) this.sendForeground(this.currentFgUrl, this.director.sceneKey);
  }
  private armTravelTimeout() {
    if (this.travelTimer) clearTimeout(this.travelTimer);
    this.travelTimer = setTimeout(() => {
      this.cancelTravel();
      this.send({ type: 'error', code: 'travel_timeout', message: '新地点还没准备好，我们留在原处。' });
    }, 120000);
  }
  private cancelTravel() {
    if (!this.travel) return;
    const id = this.travel.id;
    this.latestSceneRequest = `cancelled:${id}`;
    this.director.onMediaSettled(this.travel.event?.context_id || this.travel.intentId);
    this.travel = undefined;
    this.stagedScene = undefined;
    if (this.travelTimer) clearTimeout(this.travelTimer);
    this.director.sceneFailed();
    this.send({ type: 'travel.cancelled', id });
    this.publishWorld();
  }
  private returnTo(locationId: string, intentId: string) {
    if (!this.worldId || !this.entered || this.worldError || this.travelIntents.has(intentId)) return;
    const w = worldStore().read(this.worldId);
    const target = w.locations.find((l) => l.id === locationId);
    if (!target || target.id === w.currentLocationId) {
      this.send({
        type: 'error',
        code: 'travel_unavailable',
        message: target ? '我们已经在这里。' : '这个地方还没有去过。',
      });
      return;
    }
    this.travelIntents.add(intentId);
    if (this.travelIntents.size > 100) this.travelIntents.delete(this.travelIntents.values().next().value!);
    this.handleInterrupt('client');
    this.director.noteUserActivity();
    this.cancelTravel();
    const id = randomUUID();
    const event: MediaEvent = {
      id,
      kind: 'scene',
      status: 'ready',
      url: target.url,
      scene_key: target.key,
      subject: target.description,
      travel_id: id,
    };
    this.travel = { id, originId: w.currentLocationId, target, intentId, event };
    this.stagedScene = event;
    this.latestSceneRequest = id;
    this.armTravelTimeout();
    this.publishWorld();
    this.send({ type: 'state', phase: 'listening' });
    this.send({ type: 'media.event', event: { ...event, status: 'generating' } });
    this.send({ type: 'media.event', event });
  }

  // ---------- 生命周期 ----------
  // 会话令牌：hello 上行时绑定；reattach 必须持同令牌，sid 本身不是凭据
  owns(token?: string) {
    // 失败即关闭：无令牌会话（老客户端/异常路径）拒绝一切 reattach，宁可丢会话不可被接管
    return this.clientToken !== '' && this.clientToken === token;
  }

  async start(ws: WebSocket, hello?: { session_id?: string; client_token?: string }, freshWorld = false) {
    return this.trace.run(() => this.startTraced(ws, hello, freshWorld));
  }

  private async startTraced(ws: WebSocket, hello?: { session_id?: string; client_token?: string }, freshWorld = false) {
    this.ws = ws;
    this.clientToken = hello?.client_token || randomUUID();
    this.trace.bind(this.clientToken);
    this.trace.event('session.start', {
      freshWorld,
      models: {
        director: config.directorModel,
        image: config.genimgModel,
        duplex: config.duplexModel,
        semantic: config.typesafeModel,
      },
    });
    try {
      const w = worldStore().open(this.clientToken, freshWorld);
      this.worldId = w.id;
      this.restoredWorld = w.entered;
      const l = w.locations.find((l) => l.id === w.currentLocationId)!;
      this.currentSceneUrl = l.url;
      this.currentFgUrl = l.fgUrl;
      this.director.restore(l.key, l.description, w.memory);
      this.savedMemory = JSON.stringify(this.director.turns);
    } catch {
      this.failWorld('无法打开相遇存档，请重试。');
      throw new Error('world storage unavailable');
    }
    // Only sessions found in the local map are resumed. An unknown upstream id
    // would restore the actor without its world/memory, creating split context.
    const resumeSid = undefined;
    if (config.record) this.openRecorder();

    this.duplex = new DuplexClient({
      onEvent: (e) => this.trace.run(() => this.onDuplexEvent(e)),
      onClose: (code, reason) => this.trace.run(() => this.onDuplexClose(code, reason)),
    });
    try {
      await this.duplex.connect({ instructions: this.director.instructions, resumeSessionId: resumeSid });
    } catch (e) {
      log('session', `duplex connect fail: ${(e as Error).message}`);
      this.send({ type: 'error', code: 'duplex_connect', message: '语音服务连接失败，请重试' });
      await this.destroy();
      return;
    }
    this.restoreScene();
    this.director.syncContext();
    this.tickTimer = setInterval(() => this.trace.run(() => this.tick()), 250);
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
    if (Buffer.isBuffer(msg)) return this.handleClientMessage(msg);
    if (msg.type === 'diagnostics.client') {
      if (typeof msg.name === 'string' && msg.name.length <= 80 && JSON.stringify(msg.data ?? null).length <= 65536)
        this.trace.event('browser.' + msg.name, msg.data);
      return;
    }
    return this.trace.operation(
      `client.${msg.type}`,
      {
        message: msg,
        state: {
          alive: this.alive,
          entered: this.entered,
          worldError: this.worldError,
          travelId: this.travel?.id,
          latestSceneRequest: this.latestSceneRequest,
          scene: this.director.sceneKey,
        },
      },
      () => this.handleClientMessage(msg),
    );
  }

  private async handleClientMessage(msg: UpMessage | Buffer) {
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
        if (this.worldId) {
          try {
            const w = worldStore().read(this.worldId);
            if (!w.entered) {
              const url = worldStore().promote(w.id, this.currentSceneUrl);
              const mapUrl = w.locations[0].mapUrl ? worldStore().promote(w.id, w.locations[0].mapUrl) : undefined;
              worldStore().update(w.id, 'enter', 'enter', (w) => {
                w.entered = true;
                w.locations[0].url = url;
                if (mapUrl) w.locations[0].mapUrl = mapUrl;
              });
              this.currentSceneUrl = url;
            }
            this.publishWorld();
            drawVisitedRegions(this.worldId, () => {
              if (this.alive) this.publishWorld();
            });
          } catch {
            this.entered = false;
            this.failWorld('这次相遇暂时无法保存，请重试。');
            break;
          }
        }
        if (this.restoredWorld) {
          this.director.syncContext();
          this.send({ type: 'state', phase: 'listening' });
          break;
        }
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
        this.cancelStagedPhoto('user activity');
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
      case 'map.open':
        this.mapOpen = msg.open === true;
        this.director.noteUserActivity();
        if (this.mapOpen) {
          this.publishWorld();
          if (this.worldId)
            drawVisitedRegions(
              this.worldId,
              () => {
                if (this.alive) this.publishWorld();
              },
              true,
            );
        }
        break;
      case 'travel.request':
        if (typeof msg.locationId === 'string' && typeof msg.intentId === 'string' && msg.intentId.length <= 100)
          this.returnTo(msg.locationId, msg.intentId);
        break;
      case 'travel.cancel':
        if (msg.id === this.travel?.id) this.cancelTravel();
        break;
      case 'scene.presented': {
        const scene = this.stagedScene;
        if (!scene || scene.id !== msg.id) break;
        if (!msg.ok) {
          this.cancelTravel();
          this.director.sceneFailed();
          break;
        }
        if (this.travel && scene.travel_id === this.travel.id) {
          const travel = this.travel;
          try {
            worldStore().arrive(this.worldId, travel.id, travel.originId, travel.target);
            this.stagedScene = undefined;
            this.travel = undefined;
            if (this.travelTimer) clearTimeout(this.travelTimer);
            this.currentSceneUrl = travel.target.url;
            this.currentFgUrl = travel.target.fgUrl;
            this.director.sceneReady(travel.target.key, travel.target.description);
            this.publishWorld();
            this.send({ type: 'media.event', event: { ...scene, committed: true } });
            if (travel.target.fgUrl) this.sendForeground(travel.target.fgUrl, travel.target.key);
            // The base is durable. Never pay to regenerate on return.
            drawVisitedRegions(this.worldId, () => {
              if (this.alive) this.publishWorld();
            });
          } catch {
            this.failWorld('到达状态未能保存，我们还在原处。');
            this.cancelTravel();
          }
        }
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
        // 每条文字回合都是付费调用：按会话限速防刷（choice 经内部 text 也计数）
        if (this.textThrottled()) {
          this.send({ type: 'error', code: 'rate_limited', message: '慢一点，我还在消化刚才的话。' });
          break;
        }
        this.handleInterrupt('client');
        this.cancelStagedPhoto('new typed turn');
        this.send({ type: 'state', phase: 'thinking' });
        await this.handleTypedTurn(msg.text);
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
    audioDone?: boolean;
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
    if (this.cancelledRids.has(p.rid) || this.userSpeaking) {
      log('session', `held response dropped before promotion rid=${p.rid} userSpeaking=${this.userSpeaking}`);
      return;
    }
    this.beginResponse(p.rid);
    for (const b of p.pcm) {
      this.recAudio?.write(b);
      this.rec('audio.pcm', {}, b.length);
      this.sendBinary(b);
    }
    for (const delta of p.text) this.send({ type: 'transcript.mira', delta, response_id: p.rid });
    if (p.textDone) this.handleTextDone(p.textDone);
    if (p.audioDone) this.finishOutputAudio(p.rid);
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

  // show_photo 可能先于演员最终台词到达。立即后台生图，但把媒体事件暂存，
  // 等这一轮真正说完后再决定是否下发，避免“工具说展示、台词却说没有”。
  private stagePhoto(toolResponseId: string, subject: string, caption: string) {
    if (this.stagedPhoto) clearTimeout(this.stagedPhoto.timer);
    const timer = setTimeout(() => this.cancelStagedPhoto('final reply timeout'), 12000);
    const contextId = `photo_${randomUUID()}`;
    this.stagedPhoto = { toolResponseId, contextId, subject, caption, timer };
    this.director.pendingMedia = true;
    this.genimg.generate('photo', subject, { caption, contextId });
  }

  private async settleStagedPhoto(responseId: string, reply: string) {
    const staged = this.stagedPhoto;
    if (!staged || !reply.trim()) return;
    if (this.settlingPhotoContexts.has(staged.contextId)) return;
    this.settlingPhotoContexts.add(staged.contextId);
    const verdict = this.director.photoReplyRejected(reply);
    if (typeof verdict !== 'boolean') {
      void verdict
        .then((rejected) => this.finishStagedPhoto(responseId, staged, rejected))
        .catch((error) => {
          log('session', `photo semantic judge failed closed: ${(error as Error).message}`);
          this.finishStagedPhoto(responseId, staged, true);
        });
      return;
    }
    this.finishStagedPhoto(responseId, staged, verdict);
  }

  private finishStagedPhoto(responseId: string, staged: NonNullable<ClientSession['stagedPhoto']>, rejected: boolean) {
    if (this.stagedPhoto !== staged) {
      this.settlingPhotoContexts.delete(staged.contextId);
      return;
    }
    clearTimeout(staged.timer);
    this.stagedPhoto = undefined;
    this.director.clearPhoto();
    this.settlingPhotoContexts.delete(staged.contextId);
    if (rejected) {
      this.blockedPhotoContexts.add(staged.contextId);
      if (this.blockedPhotoContexts.size > 64)
        this.blockedPhotoContexts.delete(this.blockedPhotoContexts.values().next().value!);
      this.director.pendingMedia = false;
      log('session', `photo display rejected by final reply rid=${responseId}`);
      return;
    }
    if (staged.terminal) this.forwardPhotoEvent(staged.terminal);
  }

  private cancelStagedPhoto(reason: string) {
    const staged = this.stagedPhoto;
    if (!staged) return;
    clearTimeout(staged.timer);
    this.stagedPhoto = undefined;
    this.blockedPhotoContexts.add(staged.contextId);
    if (this.blockedPhotoContexts.size > 64)
      this.blockedPhotoContexts.delete(this.blockedPhotoContexts.values().next().value!);
    this.director.clearPhoto();
    this.director.pendingMedia = false;
    log('session', `staged photo dropped (${reason})`);
  }

  private async preparePhotoForReply(reply: string) {
    try {
      await this.director.armPhotoFromSpeech(reply);
      const photo = this.director.consumeArmedPhoto();
      if (photo) this.genimg.generate('photo', photo.subject, { caption: photo.caption, contextId: photo.contextId });
    } catch (error) {
      log('session', `photo semantic judge unavailable: ${(error as Error).message}`);
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

  private finishOutputAudio(rid: string) {
    this.lastAudioEndAt = Date.now();
    this.send({ type: 'audio.end', response_id: rid });
    if (this.cancelledRids.has(rid)) return;
    this.speaking = false;
    // The browser owns audible completion and reports playback remaining.
    if (this.miraText.trim()) this.director.noteMira(this.miraText);
    const reply = this.miraText;
    void this.settleStagedPhoto(rid, reply);
    void this.preparePhotoForReply(reply); // 台词里递了照片却漏调 show_photo → 语义兜底
    this.miraText = '';
    void this.director.prepareContinuation();
    const photo = this.director.consumeArmedPhoto();
    if (photo) this.genimg.generate('photo', photo.subject, { caption: photo.caption, contextId: photo.contextId });
  }

  handleInterrupt(source: 'client' | 'server_vad') {
    this.speechGate.clear();
    this.scriptedSpeech = false;
    // 音频突发下发：output_audio.done 后客户端仍有几秒在播 → 宽限窗内仍受理打断
    this.director.invalidate();
    if (!this.speaking && Date.now() > this.playingUntil && Date.now() - this.lastAudioEndAt > 6000) return;
    this.speaking = false;
    this.playingUntil = 0;
    this.director.interrupted();
    this.discardPending('interrupt');
    this.cancelStagedPhoto('interrupt');
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
    if (!String(evt.type).includes('audio.delta')) this.trace.event('duplex.raw', evt);
    if (!this.alive) return;
    const type = String(evt.type ?? '');
    const rid = String(evt.response_id ?? '');
    if (this.cancelledRids.has(rid)) return;
    if (this.scriptedSpeech && /^response\.output_(audio|text)\./.test(type)) {
      this.processDuplexEvent(evt);
      if (type === 'response.output_audio.done') this.scriptedSpeech = false;
      return;
    }
    const result = this.speechGate.accept(evt);
    for (const event of result.events) this.processDuplexEvent(event);
  }

  private processDuplexEvent(evt: Record<string, unknown>) {
    if (!String(evt.type).includes('audio.delta')) this.trace.event('duplex.event', evt);
    if (!this.alive) return;
    const t = String(evt.type ?? '');
    this.rec(t, evt.type === 'response.output_audio.delta' ? { n: String(evt.delta ?? '').length } : evt);

    if (t === 'session.created' || t === 'session.updated') {
      const sess = evt.session as Record<string, unknown> | undefined;
      const sid = String(sess?.id ?? evt.session_id ?? '');
      if (sid) {
        sessions.set(sid, this);
        this.send({ type: 'session', session_id: sid, resumed: this.restoredWorld });
        this.restoreScene();
      }
      return;
    }

    // 用户语音转写流（服务端 VAD 产出）。注入的打字话音也会被 ASR 转写——
    // 那是回声：客户端已回显原文、context 已按原文登记，这里不回显不重复记。
    if (t.includes('transcription')) {
      const text = String(evt.text ?? evt.transcript ?? evt.delta ?? '');
      const echo = Date.now() < this.injectedUntil;
      this.director.noteUserActivity(); // 真实用户语音活动：重置静默钟，压住进行中的 cue/poke 注入
      if (t.endsWith('started')) {
        if (!echo) this.pendingVoiceUser = ''; // 回声窗内保留打字原文给 handleVoiceWorld
        this.userSpeaking = true;
        this.userSpeakingAt = Date.now();
        if (!echo) this.cancelStagedPhoto('new user speech');
        if (text.trim() && !echo) {
          this.send({ type: 'transcript.user', text, final: false });
          this.sentUserPartial = true;
        }
        if (this.speaking || Date.now() < this.playingUntil)
          this.handleInterrupt('server_vad'); // 服务端打断信号
        else this.send({ type: 'state', phase: 'listening' });
      } else if (t.endsWith('completed') || t.endsWith('done')) {
        this.userSpeaking = false;
        if (echo) {
          this.injectedUntil = 0;
          this.sentUserPartial = false;
          this.discardPending('user turn');
          this.cancelStagedPhoto('user turn');
          if (text.trim()) {
            this.send({ type: 'state', phase: 'thinking' });
            this.tSpeechEnd = Date.now();
            this.seenFirstAudio = false;
          }
          return;
        }
        if (text.trim() || this.sentUserPartial) this.send({ type: 'transcript.user', text, final: true });
        this.sentUserPartial = false;
        if (text.trim()) {
          this.discardPending('user turn'); // 用户新一轮输入取代暂扣中的可疑响应
          this.cancelStagedPhoto('user turn');
          this.pendingVoiceUser = this.director.noteUser(text);
          if (this.handleTravelWords(text)) {
            this.pendingVoiceUser = '';
            return;
          }
          this.send({ type: 'state', phase: 'thinking' });
          this.tSpeechEnd = Date.now();
          this.seenFirstAudio = false;
        }
      } else {
        this.userSpeakingAt = Date.now(); // 转写增量也算说话活动，续命自愈窗
        if (text.trim() && !echo) {
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
        if (this.pending && rid === this.pending.rid) {
          this.pending.audioDone = true;
          break; // 暂扣响应即使已生成完，也要等观察窗确认没有新的用户说话
        }
        if (this.cancelledRids.has(rid)) break;
        this.finishOutputAudio(rid);
        if (evt.stage_filtered_empty) this.send({ type: 'state', phase: 'listening' });
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
        void this.settleStagedPhoto(String(evt.response_id ?? this.curResponseId), this.miraText);
        if (this.stagedPhoto && String(evt.response_id ?? this.curResponseId) !== this.stagedPhoto.toolResponseId)
          this.cancelStagedPhoto('response ended without spoken confirmation');
        if (this.pending) {
          if (this.pending.audioDone) break;
          this.discardPending('response.done');
        }
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
        if (!this.director.notePhotoDispatched()) {
          results.push({ call_id: callId, result: { ok: true, status: 'photo_already_dispatched' } });
          continue;
        }
        this.stagePhoto(String(evt.response_id ?? this.curResponseId ?? ''), subject, caption);
        results.push({ call_id: callId, result: { ok: true, status: 'photo_staged_until_final_reply' } });
      } else {
        results.push({ call_id: callId, result: { ok: true } });
      }
    }
    // 立即回传工具结果，模型续说
    if (results.length) this.duplex?.returnToolResults(results);
  }

  // ---------- 导演 tick：静默驱动 ----------
  private tick() {
    this.checkpointWorld();
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
    this.director.advanceReaction();
    // Long silences still belong to the environment director.
    if (s > 10) void this.director.evaluate('tick').then((d) => this.director.apply(d));
  }

  // ---------- 重连 ----------
  private async onDuplexClose(code: number, _reason: string) {
    this.speechGate.clear();
    this.scriptedSpeech = false;
    if (!this.alive) return;
    this.director.invalidate();
    this.discardPending('duplex close');
    this.cancelStagedPhoto('duplex close');
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
        onEvent: (e) => this.trace.run(() => this.onDuplexEvent(e)),
        onClose: (c, r) => this.trace.run(() => this.onDuplexClose(c, r)),
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

  // 文字回合走真回合：把用户打字 TTS 成话音喂进她的耳朵，她自己组织回答——
  // 和开口说话同一条心智，不再是 ark 代笔念稿。TTS/链路失败退回代笔兜底。
  private async handleTypedTurn(text: string) {
    const utterance = this.director.noteUser(text, true);
    if (this.handleTravelWords(text)) return;
    try {
      if (!this.duplex?.connected) throw new Error('duplex not connected');
      const pcm = await traceOperation('speech.inject_tts', { text: utterance, voice: config.injectVoice }, () =>
        this.injectTts.synthesize(utterance),
      );
      if (!this.alive || !this.duplex?.connected) return;
      // pendingVoiceUser 记原文（不记 ASR 回声）：handleTextDone → handleVoiceWorld 走与语音相同的世界更新
      this.pendingVoiceUser = utterance;
      this.injectedUntil = Date.now() + Math.round((pcm.length / 640) * 20) + 6000;
      this.duplex.injectAudio(pcm);
      log('session', `typed turn injected as voice (${Math.round((pcm.length / 640) * 20)}ms)`);
    } catch (e) {
      log('session', `tts inject failed, ghost-writer fallback: ${(e as Error).message}`);
      await this.director.handleTextTurn(text, utterance);
    }
  }

  // ---------- 注入通道：提示/打字 → TTS → 演员耳朵（触发真回合，她自己组织台词） ----------
  private speakLine(line: string) {
    const clean = stripStage(line);
    if (!clean) return;
    this.scriptedSpeech = true;
    this.duplex?.speak(clean);
    // 递词/文字回合不经过模型工具调用：台词做了"递照片"表达就当场补生成
    void this.preparePhotoForReply(line);
    // speech_text_buffer 不产生 output_text 流 —— 字幕由服务端直发
    if (clean) this.send({ type: 'transcript.mira', delta: clean, response_id: `speak_${Date.now()}` });
  }

  // ---------- 发送 ----------
  send(msg: DownMessage) {
    if (msg.type !== 'log' && msg.type !== 'pong')
      this.trace.event('server.send', {
        message: msg,
        delivered: this.alive && this.ws?.readyState === WebSocket.OPEN,
      });
    if (msg.type === 'session') msg = { ...msg, trace_id: this.trace.traceId };
    if (!this.alive) return;
    if (msg.type === 'directive') this.director.noteStageDirective(msg.directive);
    // 录制客户端可见事件流（mock 回放用）——与 audio.pcm 字节流同时间轴
    this.rec(msg.type, msg);
    if (msg.type === 'directive' && msg.directive.fx && this.worldId && this.entered) {
      const fx = msg.directive.fx;
      if (['rain_stop', 'rain_heavy', 'lights_dim'].includes(fx)) {
        try {
          worldStore().update(this.worldId, randomUUID(), 'environment', (w) => {
            const l = w.locations.find((l) => l.id === w.currentLocationId)!;
            if (fx === 'rain_stop') l.environment.rain = 0;
            if (fx === 'rain_heavy') l.environment.rain = 1.6;
            if (fx === 'lights_dim') l.environment.dim = 1;
          });
        } catch {
          this.failWorld('环境状态未能保存，请稍后重试。');
        }
      }
    }
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
    this.trace.event('session.attach');
    // 接管即踢前主：同一时刻只允许一个控制端；旧 ws 的 close 由 detach(ws) 的身份校验挡掉
    const prev = this.ws;
    this.ws = ws;
    this.cancelTravel();
    this.mapOpen = false;
    if (prev && prev !== ws && prev.readyState === WebSocket.OPEN) prev.close(4000, 'session moved');
    this.publishWorld();
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
    this.trace.event('session.detach', { controlling: this.ws === ws });
    // 只有当前控制端的 close 才启动宽限销毁；被踢旧连接的迟到 close 不得误杀会话
    if (this.ws !== ws) return;
    this.cancelTravel();
    this.mapOpen = false;
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
    if (!this.alive) return;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.checkpointWorld();
    if (this.travelTimer) clearTimeout(this.travelTimer);
    this.cancelStagedPhoto('destroy');
    this.alive = false;
    liveSessions.delete(this);
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.recStream?.end();
    this.recAudio?.end();
    this.director.invalidate();
    await this.duplex?.close();
    await this.injectTts.close();
    await this.trace.flush(true).catch((e) => console.error(e));
    // 摘除所有历史 sid（重连可能换过上游会话）：陈旧 sid 不允许再 attach 进尸体
    for (const [sid, s] of sessions) if (s === this) sessions.delete(sid);
  }
}
