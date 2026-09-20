import { rememberTrace } from './diagnostics';
import type { DownMessage, UpMessage } from '../../../shared/protocol';

// 传输层抽象：真实 WS 或 MockTransport（录制回放）实现同一接口
export interface Transport {
  connect(): Promise<void>;
  send(msg: UpMessage): void;
  sendAudio(pcm: ArrayBuffer): void;
  close(): void;
  report?(name: string, data: unknown): void;
  onMessage: (msg: DownMessage) => void;
  onAudio: (pcm: ArrayBuffer) => void;
  onClose?: () => void;
}

export class RealTransport implements Transport {
  private ws?: WebSocket;
  onMessage: (m: DownMessage) => void = () => {};
  onAudio: (b: ArrayBuffer) => void = () => {};
  onClose?: () => void;

  connect(): Promise<void> {
    this.close();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      let opened = false;
      const fail = (message: string) => {
        clearTimeout(to);
        if (this.ws === ws) this.close();
        reject(new Error(message));
      };
      const to = setTimeout(() => fail('ws open timeout'), 8000);
      ws.onopen = () => {
        clearTimeout(to);
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        if (!opened) fail('ws error');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data) as DownMessage;
            if (msg.type === 'session' && msg.trace_id) rememberTrace(msg.trace_id);
            if (msg.type !== 'log' && msg.type !== 'pong')
              this.send({
                type: 'diagnostics.client',
                name: 'received',
                data: { type: msg.type, ...(msg.type === 'media.event' ? { event: msg.event } : {}) },
              });
            this.onMessage(msg);
          } catch (error) {
            this.report('handler.error', { message: String(error) });
          }
        } else {
          this.onAudio(ev.data as ArrayBuffer);
        }
      };
      ws.onclose = () => {
        if (!opened) fail('ws closed before opening');
        else this.onClose?.();
      };
    });
  }

  report(name: string, data: unknown) {
    this.send({ type: 'diagnostics.client', name, data });
  }
  send(msg: UpMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
  sendAudio(pcm: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm);
  }
  close() {
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.onerror = null;
      this.ws.close();
    }
  }
}
