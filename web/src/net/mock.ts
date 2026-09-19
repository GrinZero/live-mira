import type { DownMessage, MediaEvent, UpMessage } from '../../../shared/protocol';
import type { WorldLocation, WorldView } from '../../../shared/world';
import type { Transport } from './transport';

// MockTransport：录制回放模式。加载 /mock/session.json（事件时间轴）
// + /mock/audio.pcm（下行音频裸流）。行为：
//  - 'enter' 后播放开场段；
//  - 用户说完一段话（本地 VAD 判停）或发出文字 → 播放下一段响应；
//  - 打断随时生效：停当前段，等下一次输入推进。
// 保留录制的音频/旧事件；场景使用内存中的 world 与到达握手，不保存或生成资产。

interface RecEvent {
  t: number;
  type: string;
  payload?: Record<string, unknown>;
  audio?: number;
}
interface MockScript {
  events: RecEvent[];
  audioFile: string;
  sampleRate: number;
}

export class MockTransport implements Transport {
  onMessage: (m: DownMessage) => void = () => {};
  onAudio: (b: ArrayBuffer) => void = () => {};
  private script?: MockScript;
  private audio?: ArrayBuffer;
  private audioCursor = 0; // 已播音频字节
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private playing = false;
  private segs: [number, number][] = []; // 每段 [startIdx, endIdx)
  private segIdx = 0;
  private closed = false;
  private readonly instanceId = `mock-${crypto.randomUUID()}`;
  private sequence = 0;
  private world?: WorldView;
  // 只索引录制中可用的 scene；索引不代表已经到访。
  private destinations = new Map<string, WorldLocation>();
  private replayScenes = new Map<string, { id: string; cancelled: boolean }>();
  private travelIntents = new Set<string>();
  private travel?: { id: string; target: WorldLocation; event?: MediaEvent };

  async connect() {
    const [meta, pcm] = await Promise.all([
      fetch('/mock/session.json').then((r) => r.json()) as Promise<MockScript>,
      fetch('/mock/audio.pcm').then((r) => r.arrayBuffer()),
    ]);
    if (this.closed) return;
    this.script = meta;
    this.audio = pcm;
    this.segs = [];
    for (const e of meta.events) {
      const media = e.payload?.event as MediaEvent | undefined;
      if (e.type !== 'media.event' || media?.kind !== 'scene' || media.status !== 'ready' || !media.url) continue;
      const key = media.scene_key || media.url;
      if (key === 'cafe_interior' || media.url === '/assets/bg/cafe_interior.jpg') continue;
      if (!this.destinations.has(key)) {
        const index = this.destinations.size + 1;
        const description = media.subject || media.caption || `录制场景 ${index}`;
        this.destinations.set(key, {
          id: `mock-location-${index}`,
          key,
          name: description.match(/目的地[（(]([^）)]+)[）)]/)?.[1] || media.caption || description,
          description,
          url: media.url,
          firstVisitedAt: 0,
          lastVisitedAt: 0,
          visits: 0,
          // 固定网格由录制顺序确定，不随到访顺序或重播改变。
          x: (index % 3) * 320,
          y: Math.floor(index / 3) * 260,
          mapStatus: 'failed',
          environment: { rain: 1, dim: 0 },
        });
      }
    }
    // 切段：每段 = 上一段结束 → 下一个 audio.end（含段间状态/字幕事件，时间偏移保留）
    const evs = meta.events;
    let from = 0;
    for (let i = 0; i < evs.length; i++) {
      if (evs[i].type === 'audio.end') {
        this.segs.push([from, i + 1]);
        from = i + 1;
      }
    }
    if (from < evs.length && this.segs.length) this.segs[this.segs.length - 1][1] = evs.length;
    this.onMessage({ type: 'session', session_id: 'mock-session', resumed: false });
  }

  send(msg: UpMessage) {
    if (this.closed) return;
    if (msg.type === 'enter') {
      if (!this.world) {
        const now = Date.now();
        this.world = {
          id: this.instanceId,
          revision: 0,
          currentLocationId: 'mock-cafe',
          sceneInstanceId: `${this.instanceId}-cafe`,
          locations: [
            {
              id: 'mock-cafe',
              key: 'cafe_interior',
              name: '雨夜咖啡馆',
              description: '雨夜咖啡馆，窗边的桌子',
              url: '/assets/bg/cafe_interior.jpg',
              firstVisitedAt: now,
              lastVisitedAt: now,
              visits: 1,
              x: 0,
              y: 0,
              mapStatus: 'ready',
              mapUrl: '/assets/bg/cafe_map.webp',
              environment: { rain: 1, dim: 0 },
            },
          ],
          connections: [],
        };
      }
      this.publishWorld();
      this.playNext();
    }
    if (msg.type === 'text') {
      this.onMessage({ type: 'transcript.user', text: msg.text, final: true });
      this.timers.add(setTimeout(() => this.playNext(), 500));
    }
    if (msg.type === 'map.open' && msg.open) this.publishWorld();
    if (msg.type === 'interrupt') this.stopCurrent();
    if (msg.type === 'scene.presented') this.presented(msg.id, msg.ok);
    if (msg.type === 'travel.cancel' && msg.id === this.travel?.id) this.cancelTravel();
    if (msg.type === 'travel.request' && this.world && !this.travelIntents.has(msg.intentId)) {
      const target = this.world.locations.find((l) => l.id === msg.locationId);
      if (!target || target.id === this.world.currentLocationId) {
        this.onMessage({
          type: 'error',
          code: 'travel_unavailable',
          message: target ? '我们已经在这里。' : '这个地方还没有去过。',
        });
        return;
      }
      this.travelIntents.add(msg.intentId);
      this.stopCurrent();
      const id = this.nextTravelId();
      const event: MediaEvent = {
        id,
        kind: 'scene',
        status: 'ready',
        url: target.url,
        scene_key: target.key,
        subject: target.description,
        travel_id: id,
      };
      this.travel = { id, target, event };
      this.publishWorld();
      this.onMessage({ type: 'state', phase: 'listening' });
      this.onMessage({ type: 'media.event', event: { ...event, status: 'generating' } });
      this.onMessage({ type: 'media.event', event });
    }
    // mic/audio 上行在 mock 中只驱动本地 VAD（client 侧处理）
  }

  /** 供客户端在用户语音停顿时调用 */
  notifyUserSpeechEnd() {
    this.playNext();
  }

  private playNext() {
    if (this.closed || !this.script || this.playing || !this.segs.length) return;
    if (this.segIdx >= this.segs.length) {
      // 没有更多段落：回绕最后一段（录制有限）
      this.segIdx = Math.max(0, this.segs.length - 1);
    }
    const [from, to] = this.segs[this.segIdx++];
    this.playing = true;
    const evs = this.script.events;
    const t0 = evs[from].t;
    for (let i = from; i < to; i++) {
      const e = evs[i];
      const delay = Math.min(e.t - t0, 60000);
      const timer = setTimeout(() => this.dispatch(e), delay);
      this.timers.add(timer);
    }
    // 段末标记播完
    const endTimer = setTimeout(
      () => {
        this.playing = false;
      },
      Math.min(evs[to - 1].t - t0 + 400, 61000),
    );
    this.timers.add(endTimer);
  }

  private dispatch(e: RecEvent) {
    if (this.closed) return;
    if (e.type === 'audio.pcm') {
      // 音频事件：payload 记录字节数 → 从 pcm 流切
      const n = e.audio ?? 0;
      if (this.audio && n > 0) {
        this.onAudio(this.audio.slice(this.audioCursor, this.audioCursor + n));
        this.audioCursor += n;
      }
      return;
    }
    // 录制的快照/取消不属于本次 mock 会话。
    if (e.type === 'world' || e.type === 'travel.cancelled') return;
    const media = e.payload?.event as MediaEvent | undefined;
    if (e.type === 'media.event' && media?.kind === 'scene' && media.purpose !== 'moment') {
      this.replayScene(media);
      return;
    }
    this.onMessage({ ...(e.payload as object), type: e.type } as DownMessage);
  }

  private nextTravelId() {
    return `${this.instanceId}-travel-${++this.sequence}`;
  }

  private publishWorld() {
    if (!this.world) return;
    const world = structuredClone(this.world);
    if (this.travel)
      world.travel = {
        id: this.travel.id,
        targetId: this.travel.target.id,
        status: this.travel.event ? 'ready' : 'preparing',
      };
    this.onMessage({ type: 'world', world });
  }

  private cancelTravel() {
    if (!this.travel) return;
    const id = this.travel.id;
    for (const replay of this.replayScenes.values()) {
      if (replay.id === id) replay.cancelled = true;
    }
    this.travel = undefined;
    this.onMessage({ type: 'travel.cancelled', id });
    this.publishWorld();
  }

  private replayScene(media: MediaEvent) {
    if (!this.world) return;
    // 新录制可能同时包含 prepared 和 committed；只让本次 ACK 提交。
    if (media.committed) return;
    const ready =
      media.status === 'ready'
        ? media
        : this.script?.events
            .filter((e) => e.type === 'media.event')
            .map((e) => e.payload?.event as MediaEvent | undefined)
            .find((e) => e?.kind === 'scene' && e.id === media.id && e.status === 'ready' && e.url);
    const target =
      ready?.url === '/assets/bg/cafe_interior.jpg' || ready?.scene_key === 'cafe_interior'
        ? this.world.locations.find((l) => l.id === 'mock-cafe')
        : this.destinations.get(ready?.scene_key || ready?.url || '');
    let replay = this.replayScenes.get(media.id);
    if (media.status === 'generating' || !replay) {
      this.cancelTravel();
      replay = { id: this.nextTravelId(), cancelled: false };
      this.replayScenes.set(media.id, replay);
      if (target) this.travel = { id: replay.id, target };
    }
    if (replay.cancelled) return;
    const event = { ...media, id: replay.id, travel_id: replay.id, committed: false };
    if (media.status === 'failed' || (media.status === 'ready' && (!target || !media.url))) {
      this.onMessage({ type: 'media.event', event: { ...event, status: 'failed' } });
      this.cancelTravel();
      replay.cancelled = true;
      return;
    }
    if (media.status === 'ready') {
      if (this.travel?.id !== replay.id) return;
      this.travel.event = { ...event, scene_key: target!.key };
    }
    this.publishWorld();
    // ready-only 的旧录制也需要先建立客户端 latestScene。
    if (media.status === 'ready') this.onMessage({ type: 'media.event', event: { ...event, status: 'generating' } });
    this.onMessage({ type: 'media.event', event: this.travel?.event || event });
  }

  private presented(id: string, ok: boolean) {
    const travel = this.travel;
    if (!this.world || !travel?.event || travel.event.id !== id) return;
    if (!ok) {
      this.cancelTravel();
      return;
    }
    const origin = this.world.currentLocationId;
    const now = Date.now();
    let target = this.world.locations.find((l) => l.id === travel.target.id);
    if (!target) {
      target = structuredClone(travel.target);
      target.firstVisitedAt = now;
      this.world.locations.push(target);
    }
    target.visits++;
    target.lastVisitedAt = now;
    if (
      origin !== target.id &&
      !this.world.connections.some(
        (e) => (e.from === origin && e.to === target.id) || (e.from === target.id && e.to === origin),
      )
    )
      this.world.connections.push({ from: origin, to: target.id });
    this.world.currentLocationId = target.id;
    this.world.sceneInstanceId = travel.id;
    this.world.revision++;
    this.travel = undefined;
    this.publishWorld();
    this.onMessage({ type: 'media.event', event: { ...travel.event, committed: true } });
  }

  private stopCurrent() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.playing = false;
    this.cancelTravel();
    this.onMessage({ type: 'interrupted' });
  }

  sendAudio(_pcm: ArrayBuffer) {
    /* mock 不上行 */
  }
  close() {
    this.stopCurrent();
    this.closed = true;
  }
}
