import type { DownMessage, UpMessage } from '../../../shared/protocol';
import type { Transport } from './transport';

// MockTransport：录制回放模式。加载 /mock/session.json（事件时间轴）
// + /mock/audio.pcm（下行音频裸流）。行为：
//  - 'enter' 后播放开场段；
//  - 用户说完一段话（本地 VAD 判停）或发出文字 → 播放下一段响应；
//  - 打断随时生效：停当前段，等下一次输入推进。
// 录制的真实事件流原样重放（含 tool call → media.event），保证 demo 保险。

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
  private cursor = 0; // 已播放到的事件下标
  private audioCursor = 0; // 已播音频字节
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private playing = false;
  private segs: [number, number][] = []; // 每段 [startIdx, endIdx)
  private segIdx = 0;
  private speakHook?: () => void;

  async connect() {
    const [meta, pcm] = await Promise.all([
      fetch('/mock/session.json').then((r) => r.json()) as Promise<MockScript>,
      fetch('/mock/audio.pcm').then((r) => r.arrayBuffer()),
    ]);
    this.script = meta;
    this.audio = pcm;
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
    if (msg.type === 'enter') this.playNext();
    if (msg.type === 'text') {
      this.onMessage({ type: 'transcript.user', text: msg.text, final: true });
      setTimeout(() => this.playNext(), 500);
    }
    if (msg.type === 'interrupt') this.stopCurrent();
    // mic/audio 上行在 mock 中只驱动本地 VAD（client 侧处理）
  }

  /** 供客户端在用户语音停顿时调用 */
  notifyUserSpeechEnd() {
    this.playNext();
  }

  private playNext() {
    if (!this.script || this.playing) return;
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
    if (e.type === 'audio.pcm') {
      // 音频事件：payload 记录字节数 → 从 pcm 流切
      const n = e.audio ?? 0;
      if (this.audio && n > 0) {
        this.onAudio(this.audio.slice(this.audioCursor, this.audioCursor + n));
        this.audioCursor += n;
      }
      return;
    }
    this.onMessage({ ...(e.payload as object), type: e.type } as DownMessage);
  }

  private stopCurrent() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.playing = false;
    this.onMessage({ type: 'interrupted' });
  }

  sendAudio(_pcm: ArrayBuffer) {
    /* mock 不上行 */
  }
  close() {
    this.stopCurrent();
  }
}
