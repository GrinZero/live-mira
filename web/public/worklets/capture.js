// 采集 AudioWorklet：native rate → 16k Int16 320-sample(20ms) 帧 + RMS
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // worklet 全局 sampleRate
    this.pos = 0;
    this.inBuf = new Float32Array(0);
    this.out = new Int16Array(320);
    this.outN = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;
    // 拼到输入缓冲
    const merged = new Float32Array(this.inBuf.length + ch.length);
    merged.set(this.inBuf);
    merged.set(ch, this.inBuf.length);
    let sum = 0;
    while (this.pos + 1 < merged.length) {
      const a = merged[Math.floor(this.pos)];
      const b = merged[Math.floor(this.pos) + 1];
      const s = a + (b - a) * (this.pos % 1);
      sum += s * s;
      this.out[this.outN++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
      this.pos += this.ratio;
      if (this.outN === 320) {
        const frame = this.out.slice(0);
        this.port.postMessage({ type: 'frame', frame: frame.buffer, rms: Math.sqrt(sum / 320) }, [frame.buffer]);
        this.outN = 0;
        sum = 0;
      }
    }
    // 保留未消费输入尾部
    const used = Math.floor(this.pos);
    this.inBuf = merged.slice(used);
    this.pos -= used;
    return true;
  }
}
registerProcessor('capture', CaptureProcessor);
