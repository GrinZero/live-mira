import WebSocket from 'ws';
import { config } from './config.js';
import { log } from './log.js';

// 注入通道 TTS：第二条 duplex 连接只做"文本→PCM"合成。
// 产物重采样到 16k mono，由 DuplexClient.injectAudio 当输入音频喂给主会话——
// 协议没有 response.create，conversation.item.create 也不开回合；
// 唯一能让 Mira"自己开口"的手段是喂一段真音频触发 VAD。
// 导演的 cue / 用户打字都经这条路变成 Mira 听见的现场声音，词由她自己组织。

interface Pending {
  resolve: (b: Buffer) => void;
  reject: (e: Error) => void;
  chunks: Buffer[];
  timer: NodeJS.Timeout;
}

export class InjectTts {
  private ws?: WebSocket;
  private connecting?: Promise<void>;
  private pending?: Pending;

  /** 文本 → PCM16k mono。失败抛错，调用方走降级。 */
  async synthesize(text: string): Promise<Buffer> {
    await this.ensure();
    if (this.pending) throw new Error('tts busy');
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error('tts timeout'));
      }, 15000);
      this.pending = { resolve, reject, chunks: [], timer };
      this.send({ type: 'speech_text_buffer.commit', text });
    });
  }

  private ensure(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (!this.connecting) this.connecting = this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.duplexUrl, { headers: { 'X-Api-Key': config.doubaoApiKey } });
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('tts open timeout')), 10000);
      ws.on('open', () => {
        this.send({
          type: 'session.create',
          session: {
            model: config.duplexModel,
            instructions: '你是配音演员。只把给你的文字原样读出来，不要加任何别的话。',
            audio: {
              input: { format: { type: 'pcm', rate: 16000 } },
              output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: config.injectVoice },
            },
          },
        });
      });
      ws.on('message', (raw: Buffer) => {
        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(raw.toString('utf8'));
        } catch {
          return;
        }
        const t = String(evt.type ?? '');
        if (t === 'session.created' || t === 'session.updated') {
          clearTimeout(to);
          log('tts', 'inject session ready');
          resolve();
        } else if (t === 'response.output_audio.delta') {
          this.pending?.chunks.push(Buffer.from(String(evt.delta ?? ''), 'base64'));
        } else if (t === 'response.output_audio.done') {
          const p = this.pending;
          if (p) {
            this.pending = undefined;
            clearTimeout(p.timer);
            p.resolve(resampleTo16k(Buffer.concat(p.chunks)));
          }
        }
      });
      ws.on('close', () => {
        this.ws = undefined; // 10min 无交互会被服务端断连，下次 ensure() 重连
        const p = this.pending;
        if (p) {
          this.pending = undefined;
          clearTimeout(p.timer);
          p.reject(new Error('tts closed'));
        }
      });
      ws.on('error', (e) => {
        log('tts', `error ${e.message}`);
        clearTimeout(to);
        reject(e);
      });
    });
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  async close() {
    try {
      this.ws?.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      /* noop */
    }
    this.ws?.close();
    this.ws = undefined;
  }
}

// 24k → 16k 线性插值（2:3），注入音频只喂 VAD，听感要求低
function resampleTo16k(pcm24: Buffer): Buffer {
  const n = Math.floor(pcm24.length / 2);
  const outN = Math.floor(n / 1.5);
  const out = Buffer.alloc(outN * 2);
  for (let k = 0; k < outN; k++) {
    const s = k * 1.5;
    const i0 = Math.floor(s);
    const f = s - i0;
    const a = pcm24.readInt16LE(i0 * 2);
    const b = i0 + 1 < n ? pcm24.readInt16LE((i0 + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * f), k * 2);
  }
  return out;
}
