import type { DownMessage, UpMessage } from '../../../shared/protocol';

// 传输层抽象：真实 WS 或 MockTransport（录制回放）实现同一接口
export interface Transport {
  connect(): Promise<void>;
  send(msg: UpMessage): void;
  sendAudio(pcm: ArrayBuffer): void;
  close(): void;
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
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.binaryType = 'arraybuffer';
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('ws open timeout')), 8000);
      this.ws!.onopen = () => {
        clearTimeout(to);
        resolve();
      };
      this.ws!.onerror = () => {
        clearTimeout(to);
        reject(new Error('ws error'));
      };
      this.ws!.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            this.onMessage(JSON.parse(ev.data) as DownMessage);
          } catch {
            /* noop */
          }
        } else {
          this.onAudio(ev.data as ArrayBuffer);
        }
      };
      this.ws!.onclose = () => this.onClose?.();
    });
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
      this.ws.close();
    }
  }
}
