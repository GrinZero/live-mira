import { seamlessLoop } from './loop';
// 音频引擎：采集（worklet→PCM16k 20ms帧+RMS）、播放（PCM24k 调度+Analyser）、环境声
export class AudioEngine {
  ctx!: AudioContext;
  private micStream?: MediaStream;
  private worklet?: AudioWorkletNode;
  private micSource?: MediaStreamAudioSourceNode;
  // playback
  private playGain!: GainNode;
  private analyser!: AnalyserNode;
  private nextStart = 0;
  private active = new Map<AudioBufferSourceNode, GainNode>();
  // ambience：drizzle 常态层 + heavy 暴雨层（按雨强交叉），语音时自动闪避
  private rainGain!: GainNode;
  private rainHeavyGain!: GainNode;
  private ambGain!: GainNode;
  private musicGain!: GainNode;
  private musicDuck!: GainNode;
  private rainVolume = 0.7;
  private musicVolume = 0.18;
  private ducked = false;
  private ambienceSources: AudioBufferSourceNode[] = [];
  private analyserBuf?: Uint8Array;
  private _mouth = 0;
  private _micRms = 0;
  // 语音驱动信号：level=能量包络，beat=音节重音脉冲，beatId/strength=锁存的重音事件
  private _level = 0;
  private _beat = 0;
  private _beatId = 0;
  private _beatStrength = 0;
  private _rmsAvg = 0.004;
  private _lastBeat = -1;
  private _prevT = -1;
  micOnFrame?: (pcm: ArrayBuffer, rms: number) => void;

  async init() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyserBuf = new Uint8Array(this.analyser.fftSize);
    this.playGain = this.ctx.createGain();
    this.playGain.gain.value = 1;
    this.playGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.ambGain = this.ctx.createGain();
    this.ambGain.gain.value = 0.5;
    this.ambGain.connect(this.ctx.destination);
    this.rainGain = this.ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainGain.connect(this.ambGain);
    this.rainHeavyGain = this.ctx.createGain();
    this.rainHeavyGain.gain.value = 0;
    this.rainHeavyGain.connect(this.ambGain);
    this.musicDuck = this.ctx.createGain();
    this.musicDuck.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.musicDuck);
    // Resume inside the entry gesture; loading must not consume user activation.
    await this.ctx.resume();
    await this.loadAmbience();
  }

  async dispose() {
    this.stopMic();
    this.stopPlayback();
    this.micOnFrame = undefined;
    for (const source of this.ambienceSources) {
      source.stop();
      source.disconnect();
    }
    this.ambienceSources = [];
    if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close();
  }

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  private async pick(urlOgg: string, urlM4a: string): Promise<ArrayBuffer> {
    const ogg = typeof Audio !== 'undefined' && new Audio().canPlayType('audio/ogg; codecs="opus"');
    const url = ogg ? urlOgg : urlM4a;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ambience ${res.status}`);
    return res.arrayBuffer();
  }

  private async loadAmbience() {
    // A missing optional track must never silence the rain.
    await Promise.allSettled([
      ...(
        [
          ['rain_loop', this.rainGain, 4, 0],
          ['rain_heavy', this.rainHeavyGain, 4, 43],
          ['cafe_bgm', this.musicGain, 8, 0],
        ] as const
      ).map(async ([name, gain, fade, offset]) => {
        try {
          const bytes = await this.pick(`/assets/audio/${name}.ogg?v=2`, `/assets/audio/${name}.m4a?v=2`);
          const decoded = await this.ctx.decodeAudioData(bytes);
          const src = this.ctx.createBufferSource();
          src.buffer = seamlessLoop(this.ctx, decoded, fade);
          src.loop = true;
          src.connect(gain);
          src.start(0, offset % src.buffer.duration);
          this.ambienceSources.push(src);
          if (name === 'cafe_bgm') gain.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 2);
        } catch (e) {
          console.warn(`ambience ${name} load fail`, e);
        }
      }),
    ]);
  }

  setRainVolume(value: number) {
    this.rainVolume = Math.max(0, Math.min(1, value));
    this.ambGain?.gain.setTargetAtTime(this.rainVolume * (this.ducked ? 0.82 : 1), this.ctx.currentTime, 0.4);
  }

  setMusicVolume(value: number) {
    this.musicVolume = Math.max(0, Math.min(1, value));
    this.musicGain?.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.5);
  }

  /** Keep the rain bed continuous; let the second, offset layer add density. */
  setRainLevel(v: number) {
    if (!this.ctx) return;
    const strength = Math.max(0, Math.min(1.6, v));
    const heavy = Math.max(0, (strength - 0.9) / 0.7);
    this.rainGain.gain.setTargetAtTime(0.65 * Math.min(1, strength), this.ctx.currentTime, 0.8);
    this.rainHeavyGain.gain.setTargetAtTime(heavy * 0.42, this.ctx.currentTime, 1.2);
    this.setRainVolume(this.rainVolume);
  }

  private updateDucking() {
    if (!this.ctx || this.ctx.state === 'closed' || !this.musicDuck) return;
    const speaking = this.playbackRemainingMs() > 0;
    if (speaking === this.ducked) return;
    this.ducked = speaking;
    const now = this.ctx.currentTime;
    this.ambGain.gain.setTargetAtTime(this.rainVolume * (speaking ? 0.82 : 1), now, speaking ? 0.5 : 1.8);
    this.musicDuck.gain.setTargetAtTime(speaking ? 0.35 : 1, now, speaking ? 0.3 : 1.8);
  }

  // ---------- 采集 ----------
  get hasMic() {
    return !!this.micStream?.active;
  }

  async startMic(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.ctx.audioWorklet.addModule('/worklets/capture.js');
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.worklet = new AudioWorkletNode(this.ctx, 'capture');
    this.worklet.port.onmessage = (ev) => {
      const d = ev.data as { type: string; frame: ArrayBuffer; rms: number };
      if (d.type === 'frame') {
        this._micRms = d.rms;
        this.micOnFrame?.(d.frame, d.rms);
      }
    };
    this.micSource.connect(this.worklet);
    // 不接 destination：不回放自己的声音（AEC 由系统处理）
  }

  stopMic() {
    this.worklet?.disconnect();
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.worklet = undefined;
  }

  get micRms() {
    return this._micRms;
  }

  // ---------- 播放 ----------
  playPcm(buf: ArrayBuffer, sampleRate = 24000) {
    if (!this.ctx || this.ctx.state === 'closed') return;
    if (buf.byteLength % 2) buf = buf.slice(0, buf.byteLength - 1);
    if (!buf.byteLength) return;
    const s16 = new Int16Array(buf);
    const f32 = new Float32Array(s16.length);
    for (let i = 0; i < s16.length; i++) f32[i] = s16[i] / 32768;
    const ab = this.ctx.createBuffer(1, f32.length, sampleRate);
    ab.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    // 每段独立包络：打断淡出、重锚淡入，不再让波形在中点突变
    const env = this.ctx.createGain();
    src.connect(env);
    env.connect(this.playGain);
    const now = this.ctx.currentTime;
    const start = Math.max(now + 0.03, this.nextStart);
    if (start > this.nextStart) {
      // 段首或欠载重锚：8ms 淡入，消掉从静音跳到波形中点的爆音
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(1, start + 0.008);
    }
    src.start(start);
    this.nextStart = start + ab.duration;
    this.active.set(src, env);
    this.updateDucking();
    src.onended = () => {
      this.active.delete(src);
      env.disconnect();
      this.updateDucking();
    };
  }

  stopPlayback() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.active.clear();
      this.nextStart = 0;
      return;
    }
    const t = this.ctx.currentTime;
    // 45ms 淡出再停：直接 stop() 在波形中点截断，打断瞬间会"咔/滴"一声
    for (const [s, env] of this.active) {
      try {
        env.gain.cancelScheduledValues(t);
        env.gain.setValueAtTime(env.gain.value, t);
        env.gain.linearRampToValueAtTime(0, t + 0.045);
        s.stop(t + 0.045);
      } catch {
        /* noop */
      }
    }
    this.active.clear();
    this.nextStart = 0;
    this.updateDucking();
  }

  /** 已缓冲未播完的剩余时长（ms）——音频突发到达早于真实语速，靠它判断"还在说" */
  playbackRemainingMs(): number {
    if (!this.ctx) return 0;
    return Math.max(0, (this.nextStart - this.ctx.currentTime) * 1000);
  }

  private readRms(): number {
    if (!this.analyser || !this.analyserBuf) return 0;
    this.analyser.getByteTimeDomainData(this.analyserBuf as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.analyserBuf.length; i++) {
      const v = (this.analyserBuf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.analyserBuf.length);
  }

  /** 下行音频振幅 → mouthOpen */
  mouthLevel(): number {
    const rms = this.readRms();
    const target = Math.min(1, rms * 4.2);
    this._mouth += (target - this._mouth) * 0.35;
    return this._mouth;
  }

  /**
   * 语音驱动信号（角色动作用）：
   * level    = 能量包络 0..1（短语强度，平滑）；
   * beat     = 音节重音脉冲 0..1（onset：RMS 突增超过慢包络 ~1.9x 触发，按时间衰减）；
   * beatId   = 重音事件序号（每次 onset +1，消费侧用它做边沿检测）；
   * strength = 本次 onset 的锁存强度（不随时间衰减，下一次 onset 才更新），
   *            避免消费侧读到衰减后的残值导致动作打折。
   * 最小间隔 220ms 防抖。静音时 level/beat 趋 0，自带"停顿即安静"语义。
   */
  speechDrive(): { level: number; beat: number; beatId: number; strength: number } {
    if (!this.ctx || !this.analyser) return { level: 0, beat: 0, beatId: this._beatId, strength: 0 };
    const now = this.ctx.currentTime;
    const dt = this._prevT < 0 ? 0.016 : Math.min(0.12, Math.max(0.001, now - this._prevT));
    this._prevT = now;
    const rms = this.readRms();
    const target = Math.min(1, rms * 4.2);
    this._level += (target - this._level) * Math.min(1, dt * 7);
    this._rmsAvg += (rms - this._rmsAvg) * Math.min(1, dt * 1.1);
    this._beat *= Math.exp(-dt * 7);
    if (rms > this._rmsAvg * 1.9 + 0.012 && rms > 0.03 && now - this._lastBeat > 0.22) {
      this._beat = Math.min(1, 0.5 + (rms / (this._rmsAvg + 1e-4) - 1.9) * 0.6);
      this._beatStrength = this._beat;
      this._beatId++;
      this._lastBeat = now;
    }
    return { level: this._level, beat: this._beat, beatId: this._beatId, strength: this._beatStrength };
  }
}
