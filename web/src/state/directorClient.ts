import { useStore } from './store';
import type { Transport } from '../net/transport';
import type { DownMessage, MediaEvent, StageDirective } from '../../../shared/protocol';
import { AudioEngine } from '../audio/engine';
import { MockTransport } from '../net/mock';
import { SCENE_ARRIVE_MS, SCENE_DEPART_MS } from './sceneTransition';

// 客户端导演：状态机 IDLE⇄LISTENING→THINKING→SPEAKING + 四队列调度 + 打断
// 队列：字幕流 / 舞台指令 / 媒体事件 / （特效合入指令）— 指令随到达即入队，epoch 守卫丢弃迟到包

// 会话所有权令牌：随 hello 上行；服务端只在令牌匹配时允许 sid 复用，
// 防止拿到 session_id 的第三方连接接管会话（sid 存在 localStorage，不算秘密）
function sessionToken(): string {
  try {
    let t = localStorage.getItem('mira.ct');
    if (!t) {
      t = crypto.randomUUID();
      localStorage.setItem('mira.ct', t);
    }
    return t;
  } catch {
    return ''; // localStorage 不可用（隐私模式/测试环境）：会话不可恢复
  }
}

export class ClientDirector {
  engine = new AudioEngine();
  private transport?: Transport;
  private epoch = 0;
  private vadFrames = 0;
  private speechFrames = 0; // mock 模式用户说话检测
  private silenceFrames = 0;
  private noiseFloor = 0.004;
  private pendingPhotoEpoch = 0;
  private started = false;
  private activeResponse = '';
  private outputCancelled = false;
  private audioOpen = false; // audio.begin→end 帧窗；窗外的裸 PCM 一律不播（无帧怪声防线）
  private latestScene = '';
  private latestPhoto = '';
  private overlayRevs = new Map<string, number>();
  private playbackTimer?: ReturnType<typeof setTimeout>;
  private resolveSession?: () => void;
  private rejectSession?: (e: Error) => void;
  private awaitingReset = false; // reset 换会话窗口：新 session 就位前的下行都是旧会话残影
  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private mediaTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private expiredMedia = new Set<string>();

  private clearMediaWaits() {
    for (const timer of this.mediaTimers.values()) clearTimeout(timer);
    this.mediaTimers.clear();
    this.overlayRevs.clear();
  }

  constructor(private isMock: boolean) {
    // 日志流按需订阅：调试面板打开时才请求服务端日志（服务端不主动广播）
    useStore.subscribe((s, prev) => {
      if (s.debugOpen && !prev.debugOpen) this.transport?.send({ type: 'debug' });
    });
  }

  private waitForSession() {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.resolveSession = undefined;
        this.rejectSession = undefined;
        reject(new Error('语音会话连接超时，请重试'));
      }, 15000);
      this.resolveSession = () => {
        clearTimeout(timer);
        resolve();
      };
      this.rejectSession = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });
  }

  async start(freshWorld = false) {
    const st = useStore.getState();
    if (this.started) return;
    this.started = true;
    this.awaitingReset = false;
    st.set({ phase: this.reconnecting ? 'reconnecting' : 'boot', toast: '' });
    try {
      await this.engine.init();
      await this.engine.resume();
      try {
        await this.engine.startMic();
        st.set({ micMuted: false });
      } catch (e) {
        console.warn('mic denied', e);
        st.set({ toast: '麦克风不可用，仍可打字交流', micMuted: true });
      }
      this.engine.micOnFrame = (pcm, rms) => this.onMicFrame(pcm, rms);

      if (this.isMock) {
        const mt = new MockTransport();
        this.transport = mt;
        mt.onMessage = (m) => this.onMessage(m);
        mt.onAudio = this.onAudioFrame;
        await mt.connect();
        st.set({ sessionId: 'mock' });
      } else {
        const { RealTransport } = await import('../net/transport');
        const rt = new RealTransport();
        this.transport = rt;
        rt.onMessage = (m) => this.onMessage(m);
        rt.onAudio = this.onAudioFrame;
        rt.onClose = () => this.onTransportClose();
        await rt.connect();
        const sessionReady = this.waitForSession();
        rt.send({
          type: 'hello',
          session_id: st.sessionId || undefined,
          client_token: sessionToken(),
          fresh_world: freshWorld,
        });
        await sessionReady;
        rt.send({ type: 'mic', muted: useStore.getState().micMuted });
        // 调试面板开着时补订阅：重连后的新 ws 服务端不带日志订阅状态
        if (useStore.getState().debugOpen) rt.send({ type: 'debug' });
      }
    } catch (e) {
      this.resolveSession = undefined;
      this.rejectSession = undefined;
      this.started = false;
      this.transport?.close();
      await this.engine.dispose();
      throw e;
    }
  }

  setMapOpen(open: boolean) {
    useStore.getState().set({ mapOpen: open });
    this.transport?.send({ type: 'map.open', open });
  }
  travelTo(locationId: string) {
    const st = useStore.getState();
    if (!st.world?.locations.some((l) => l.id === locationId)) return;
    this.interrupt('manual');
    this.transport?.send({ type: 'travel.request', locationId, intentId: crypto.randomUUID() });
  }
  cancelTravel() {
    const id = useStore.getState().world?.travel?.id;
    if (id) this.transport?.send({ type: 'travel.cancel', id });
  }

  enter() {
    const st = useStore.getState();
    if (st.entered) return;
    st.set({ entered: true, phase: 'listening' });
    this.transport?.send({ type: 'enter' });
  }

  // 整场重来：画面/字幕/剧情/会话号全部回到开场，服务端同连接销毁并重建会话。
  // epoch++ 作废在途的指令延迟、照片弹出和转场提交；音频引擎保留（麦克风/雨声不重启）。
  async reset() {
    this.clearMediaWaits();
    this.expiredMedia.clear();
    this.epoch++;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.outputCancelled = true;
    this.audioOpen = false;
    this.engine.stopPlayback();
    this.engine.stopThunder();
    this.engine.setRainLevel(1);
    this.activeResponse = '';
    this.latestScene = '';
    this.latestPhoto = '';
    this.pendingPhotoEpoch = -1;
    this.overlayRevs.clear();
    this.vadFrames = 0;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    if (typeof localStorage !== 'undefined') localStorage.removeItem('mira.sid');
    useStore.getState().set({
      world: null,
      mapOpen: false,
      phase: 'boot',
      entered: false,
      sessionId: '',
      resumed: false,
      story: null,
      subtitles: [],
      sceneTransition: null,
      generating: [],
      photo: null,
      bgUrl: '/assets/bg/cafe_interior.jpg',
      bgKey: 'cafe_interior',
      overlay: null,
      fg: null,
      emotion: 'neutral',
      motion: null,
      gesture: null,
      camera: 'idle_drift',
      fx: { rain: 1, dim: 0, lightning: 0 },
      toast: '',
    });
    this.awaitingReset = true;
    if (this.isMock) {
      // 回放模式没有服务端会话：重建 MockTransport 即从头再播
      const mt = new MockTransport();
      this.transport?.close();
      this.transport = mt;
      mt.onMessage = (m) => this.onMessage(m);
      mt.onAudio = this.onAudioFrame;
      try {
        await mt.connect();
      } catch {
        useStore.getState().set({ toast: '回放重新加载失败' });
      }
      return;
    }
    const sessionReady = this.waitForSession();
    this.transport?.send({ type: 'reset' });
    try {
      await sessionReady;
      this.transport?.send({ type: 'mic', muted: useStore.getState().micMuted });
    } catch (e) {
      this.awaitingReset = false;
      this.started = false;
      this.transport?.close();
      await this.engine.dispose();
      throw e;
    }
  }

  noteInputActivity() {
    this.transport?.send({ type: 'user.activity' });
  }

  // 只在 audio.begin→end 帧窗内播放：窗外到达的裸 PCM（上游补发的尾音/迟到包）直接丢弃
  private onAudioFrame = (b: ArrayBuffer) => {
    if (!this.outputCancelled && this.audioOpen) this.engine.playPcm(b, 24000);
  };

  sendText(text: string) {
    if (useStore.getState().phase === 'reconnecting') return;
    if (!text.trim()) return;
    this.resumeConversation();
    this.interrupt('manual');
    const st = useStore.getState();
    st.updateUser(text, true);
    st.set({ phase: 'thinking' });
    this.transport?.send({ type: 'text', text });
  }

  choose(id: string) {
    if (useStore.getState().phase === 'reconnecting') return;
    this.resumeConversation();
    this.interrupt('manual');
    if (id !== 'dismiss') useStore.getState().set({ phase: 'thinking' });
    this.transport?.send({ type: 'choice', id });
  }

  async setMuted(muted: boolean) {
    if (!muted && !this.engine.hasMic) {
      try {
        await this.engine.startMic();
      } catch {
        useStore.getState().set({ micMuted: true, toast: '麦克风未开启。可以继续打字，或在浏览器设置中允许麦克风。' });
        return;
      }
    }
    useStore.getState().set({ micMuted: muted });
    this.transport?.send({ type: 'mic', muted });
  }

  private resumeConversation() {
    useStore.getState().set({ photo: null });
    this.latestPhoto = 'dismissed-by-conversation';
    this.pendingPhotoEpoch = -1;
  }

  // ---------- 本地 VAD（打断信号源 1）----------
  private onMicFrame(pcm: ArrayBuffer, rms: number) {
    const st = useStore.getState();
    if (st.micMuted || !st.entered) {
      this.vadFrames = 0;
      return;
    }
    // 上行：PCM16k 帧 → 服务端 → duplex（静音时不发，服务端另有 mute.commit 兜底）
    if (!st.micMuted) this.transport?.sendAudio(pcm);
    // 噪声地板自适应（非说话段）
    if (st.phase !== 'speaking') this.noiseFloor = this.noiseFloor * 0.98 + rms * 0.02;
    const thr = Math.max(0.012, this.noiseFloor * 3.5);

    // 跟踪用户语音活动（mock 推进 + 状态展示）
    if (rms > thr) {
      this.speechFrames++;
      this.silenceFrames = 0;
    } else {
      this.silenceFrames++;
      if (this.silenceFrames > 40) this.speechFrames = 0;
    }
    if (this.isMock && this.speechFrames > 5 && this.silenceFrames === 35 && this.transport) {
      (this.transport as MockTransport).notifyUserSpeechEnd();
    }

    if (st.phase !== 'speaking') {
      if (this.speechFrames === 6 && this.silenceFrames === 0) this.noteInputActivity();
      this.vadFrames = 0;
      return;
    }
    if (rms > thr) {
      this.vadFrames++;
      // >300ms 持续能量 → 打断
      if (this.vadFrames >= 15) this.interrupt('local_vad');
    } else {
      this.vadFrames = Math.max(0, this.vadFrames - 2);
    }
  }

  // ---------- 打断 ----------
  interrupt(source: 'local_vad' | 'server' | 'manual') {
    const st = useStore.getState();
    if (st.phase !== 'speaking') return;
    this.epoch++;
    this.outputCancelled = true;
    this.audioOpen = false;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.engine.stopPlayback();
    st.finalizeMira(true);
    st.set({
      phase: 'listening',
      photo: null, // 未播的媒体事件不再出现
      generating: st.generating.filter((g) => g.kind === 'scene'), // 场景可继续，照片丢弃
    });
    if (source !== 'server') this.transport?.send({ type: 'interrupt' });
    console.log(`[director] interrupt ${source} epoch=${this.epoch}`);
  }

  private onTransportClose() {
    this.rejectSession?.(new Error('连接中断，请重试'));
    if (this.reconnecting || !useStore.getState().entered) return;
    this.clearMediaWaits();
    this.latestScene = 'disconnected';
    this.latestPhoto = 'disconnected';
    this.pendingPhotoEpoch = -1;
    this.outputCancelled = true;
    this.audioOpen = false;
    this.engine.stopPlayback();
    this.epoch++;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    const st = useStore.getState();
    st.finalizeMira(true);
    st.set({ phase: 'reconnecting', toast: '连接断了…正在重连', generating: [], sceneTransition: null });
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.reconnect(), Math.min(1200 * 2 ** this.reconnectAttempt, 8000));
  }

  async reconnect() {
    if (this.reconnecting) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnecting = true;
    try {
      this.transport?.close();
    } catch {
      /* noop */
    }
    this.started = false;
    this.latestScene = '';
    useStore.getState().set({ sceneTransition: null });
    this.epoch++;
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    try {
      await this.engine.dispose();
      await this.start();
      const current = useStore.getState();
      if (!current.resumed && !current.world?.locations.length) {
        current.set({
          story: null,
          photo: null,
          generating: [],
          subtitles: [],
          bgUrl: '/assets/bg/cafe_interior.jpg',
          bgKey: 'cafe_interior',
          overlay: null,
          fg: null,
          motion: null,
          gesture: null,
          camera: 'idle_drift',
          phase: 'listening',
          entered: false,
        });
        this.enter();
      } else {
        current.set({ phase: 'listening', entered: false });
        this.enter();
      }
      current.set({ toast: '' });
      this.reconnectAttempt = 0;
    } catch {
      this.reconnectAttempt++;
      const retry = this.reconnectAttempt < 3;
      useStore
        .getState()
        .set({ phase: 'reconnecting', toast: retry ? '暂时还没连上，正在重试…' : '重连失败，点屏幕重试' });
      if (retry) this.scheduleReconnect();
      else this.reconnectAttempt = 0;
    } finally {
      this.reconnecting = false;
    }
  }

  // ---------- 下行消息 → 状态机 + 队列 ----------
  private onMessage(m: DownMessage) {
    const st = useStore.getState();
    st.pushLog?.({ ts: Date.now(), cat: 'client', msg: m.type });
    // reset 窗口：新 session 到来前，旧会话的迟到下行（场景/照片/台词）全部丢弃；错误放行提示
    if (this.awaitingReset) {
      if (m.type === 'session') this.awaitingReset = false;
      else if (m.type !== 'error') return;
    }
    switch (m.type) {
      case 'world': {
        if (st.world?.id === m.world.id && st.world.revision > m.world.revision) break;
        st.set({ world: m.world });
        break;
      }
      case 'travel.cancelled':
        if (this.latestScene === m.id || st.sceneTransition?.id === m.id) {
          this.latestScene = `cancelled:${m.id}`;
          st.set({
            sceneTransition: null,
            motion: null,
            gesture: null,
            generating: st.generating.filter((g) => g.id !== m.id),
          });
        }
        break;
      case 'session':
        this.resolveSession?.();
        this.resolveSession = undefined;
        this.rejectSession = undefined;
        st.set({ sessionId: m.session_id, resumed: m.resumed });
        if (typeof localStorage !== 'undefined') localStorage.setItem('mira.sid', m.session_id);
        break;
      case 'state':
        if ((m.phase === 'listening' || m.phase === 'idle') && this.engine.playbackRemainingMs() > 100) break;
        st.set({ phase: m.phase === 'idle' ? 'idle' : m.phase });
        break;
      case 'audio.begin':
        if (this.playbackTimer) clearTimeout(this.playbackTimer);
        this.activeResponse = m.response_id;
        this.outputCancelled = false;
        this.audioOpen = true;
        st.set({ phase: 'speaking' });
        break;
      case 'audio.end': {
        if (m.response_id !== this.activeResponse) break;
        this.audioOpen = false;
        if (m.interrupted) {
          this.interrupt('server');
          break;
        }
        const epoch = this.epoch;
        const rid = m.response_id;
        const check = () => {
          if (epoch !== this.epoch || rid !== this.activeResponse) return;
          const rem = this.engine.playbackRemainingMs();
          this.transport?.send({ type: 'playback', response_id: rid, remaining_ms: rem < 50 ? 0 : rem });
          if (rem >= 50) {
            this.playbackTimer = setTimeout(check, Math.min(rem + 30, 1000));
            return;
          }
          const current = useStore.getState();
          current.finalizeMira();
          if (current.phase === 'speaking') current.set({ phase: 'listening' });
        };
        check();
        break;
      }
      case 'story':
        // 剧情翻页（回应/新契机/告别）→ 属于上一拍的画面叠层退去
        st.set({
          story: m.story,
          ...(st.overlay?.purpose === 'moment' && st.overlay.rev !== undefined && st.overlay.rev !== m.story.revision
            ? { overlay: null }
            : {}),
        });
        break;
      case 'transcript.user':
        if (m.text.trim()) this.resumeConversation();
        st.updateUser(m.text, m.final);
        break;
      case 'transcript.mira':
        if (this.outputCancelled && m.response_id === this.activeResponse) break;
        st.appendMira(m.delta);
        break;
      case 'transcript.mira.done':
        st.finalizeMira();
        break;
      case 'directive':
        this.enqueueDirective(m.directive);
        break;
      case 'media.event':
        this.onMedia(m);
        break;
      case 'narration':
        st.pushSubtitle({ who: 'narration', text: m.text.replace(/^（旁白：|）$/g, ''), final: true });
        break;
      case 'interrupted':
        // 服务端确认打断（本地已处理则幂等）
        if (st.phase === 'speaking') this.interrupt('server');
        break;
      case 'log':
        st.pushLog(m.entry);
        break;
      case 'error':
        if (this.rejectSession && ['busy', 'duplex_connect', 'world_storage', 'duplex_gone'].includes(m.code)) {
          const reject = this.rejectSession;
          this.rejectSession = undefined;
          this.resolveSession = undefined;
          reject(new Error(m.message));
          break;
        }
        st.set({
          toast: m.message,
          ...(st.phase !== 'reconnecting' && this.engine.playbackRemainingMs() < 50
            ? { phase: 'listening' as const }
            : {}),
        });
        setTimeout(() => useStore.getState().set({ toast: '' }), 4000);
        break;
      case 'pong':
        break;
    }
  }

  // 指令队列：随到达即应用（演出指令轻量，先到先演）
  private enqueueDirective(d: StageDirective) {
    const epoch = this.epoch;
    // 微延迟对齐音频起播，未到播放时若被打断则丢弃
    setTimeout(() => {
      if (epoch !== this.epoch) return;
      useStore.getState().applyDirective(d);
      if (d.fx === 'lightning') this.engine.playThunder(crypto.randomUUID(), 0.8);
    }, 60);
  }

  private onMedia(m: Extract<DownMessage, { type: 'media.event' }>) {
    const st = useStore.getState();
    const e = m.event;
    if (this.expiredMedia.has(e.id)) return;
    if (e.status === 'generating' && (e.kind === 'photo' || e.kind === 'overlay')) {
      const old = this.mediaTimers.get(e.id);
      if (old) clearTimeout(old);
      const timer = setTimeout(() => {
        this.mediaTimers.delete(e.id);
        this.onMedia({ type: 'media.event', event: { ...e, status: 'failed', reason: 'client_timeout' } });
        this.expiredMedia.add(e.id);
        if (this.expiredMedia.size > 256) this.expiredMedia.delete(this.expiredMedia.values().next().value!);
      }, 300000);
      // Do not keep Node protocol tests alive solely for a UI watchdog.
      (timer as unknown as { unref?: () => void }).unref?.();
      this.mediaTimers.set(e.id, timer);
    } else if (e.status !== 'generating') {
      const timer = this.mediaTimers.get(e.id);
      if (timer) clearTimeout(timer);
      this.mediaTimers.delete(e.id);
    }
    // 前景板是配菜：不占生成提示、失败静默；渲染侧按 sceneKey 对底图，错位即不显示
    if (e.kind === 'foreground') {
      if (e.status === 'ready' && e.url)
        st.set({ fg: { url: e.url, sceneKey: e.scene_key ?? st.bgKey, selfBand: e.self_band } });
      return;
    }
    if (e.kind === 'overlay') {
      this.onOverlay(e);
      return;
    }
    if (e.purpose === 'moment') return; // 事件画面不再走独立近景图：直接叠进当前场景
    if (e.kind === 'photo' && e.status === 'generating') this.latestPhoto = e.id;
    if (e.kind === 'scene' && e.status === 'generating') {
      this.latestScene = e.id;
      st.set({ sceneTransition: { id: e.id, phase: 'preparing', startedAt: Date.now() }, photo: null });
    }
    if (e.status === 'generating') {
      if (e.kind === 'photo') this.pendingPhotoEpoch = this.epoch; // 记住本次照片请求的世代
      st.set({ generating: [...st.generating.filter((g) => g.id !== e.id), e] });
      return;
    }
    st.set({ generating: st.generating.filter((g) => g.id !== e.id) });
    if (e.status === 'failed') {
      if (e.kind === 'scene' && e.id === this.latestScene) st.set({ sceneTransition: null });
      st.set({
        toast:
          e.kind === 'scene'
            ? '画面暂时没准备好，我们还在原处。可以继续聊，或再试一次。'
            : '这张画面暂时没能显现，可以稍后再看。',
      });
      return;
    }
    if (e.status === 'ready' && e.url) {
      if (e.kind === 'scene') {
        if (e.travel_id) {
          if (this.latestScene && this.latestScene !== e.id) return;
          this.latestScene = e.id;
          const image = new Image();
          image.onerror = () => {
            if (this.latestScene !== e.id) return;
            if (!e.committed) this.transport?.send({ type: 'scene.presented', id: e.id, ok: false });
            useStore.getState().set({
              sceneTransition: null,
              toast: e.committed ? '已到达的场景暂时无法显示，请重新连接以恢复。' : '新画面暂时打不开，我们还在原处。',
            });
          };
          image.onload = () => {
            if (this.latestScene !== e.id) return;
            if (e.committed) {
              const current = useStore.getState();
              const l = current.world?.locations.find((l) => l.id === current.world?.currentLocationId);
              current.set({
                bgUrl: e.url!,
                bgKey: e.scene_key || current.bgKey,
                fg: l?.fgUrl ? { url: l.fgUrl, sceneKey: l.key } : null,
                overlay: null,
                photo: null,
                fx: { rain: l?.environment.rain ?? 1, dim: l?.environment.dim ?? 0, lightning: 0 },
                sceneTransition: { id: e.id, phase: 'arriving', startedAt: Date.now() },
              });
              setTimeout(() => {
                if (this.latestScene === e.id) useStore.getState().set({ sceneTransition: null });
              }, SCENE_ARRIVE_MS);
            } else {
              const depart = () => {
                if (this.latestScene !== e.id) return;
                const current = useStore.getState();
                if (current.phase === 'speaking' || current.phase === 'thinking') {
                  setTimeout(depart, 250);
                  return;
                }
                current.set({
                  motion: null,
                  gesture: null,
                  sceneTransition: { id: e.id, phase: 'departing', startedAt: Date.now() },
                });
                setTimeout(() => {
                  if (this.latestScene === e.id) this.transport?.send({ type: 'scene.presented', id: e.id, ok: true });
                }, SCENE_DEPART_MS);
              };
              depart();
            }
          };
          image.src = e.url;
          return;
        }
        if (e.id !== 'restore' && this.latestScene && this.latestScene !== e.id) return;
        this.latestScene = e.id;
        const preload = new Image();
        preload.onload = () => {
          if (this.latestScene !== e.id) return;
          const commit = () => {
            if (this.latestScene !== e.id) return;
            useStore.getState().set({
              bgUrl: e.url!,
              bgKey: e.scene_key ?? st.bgKey,
              overlay: null,
              fg:
                e.id === 'restore'
                  ? useStore.getState().fg?.sceneKey === e.scene_key
                    ? useStore.getState().fg
                    : (() => {
                        const l = useStore.getState().world?.locations.find((l) => l.key === e.scene_key);
                        return l?.fgUrl ? { url: l.fgUrl, sceneKey: l.key } : null;
                      })()
                  : null,
              fx: {
                ...useStore.getState().fx,
                ...(useStore
                  .getState()
                  .world?.locations.find((l) => l.id === useStore.getState().world?.currentLocationId)?.environment ||
                  {}),
              },
              sceneTransition: e.id === 'restore' ? null : { id: e.id, phase: 'arriving', startedAt: Date.now() },
            });
            if (e.id === 'restore') return;
            setTimeout(() => {
              if (this.latestScene !== e.id) return;
              useStore.getState().set({ sceneTransition: null });
              this.transport?.send({ type: 'scene.presented', id: e.id, ok: true });
            }, SCENE_ARRIVE_MS);
          };
          if (e.id === 'restore') {
            commit();
            return;
          }
          const depart = () => {
            if (this.latestScene !== e.id) return;
            const current = useStore.getState();
            // Finish the spoken preparation before changing the place beneath it.
            if (current.phase === 'speaking' || current.phase === 'thinking') {
              setTimeout(depart, 250);
              return;
            }
            current.set({
              sceneTransition: { id: e.id, phase: 'departing', startedAt: Date.now() },
              motion: null,
              gesture: null,
            });
            setTimeout(commit, SCENE_DEPART_MS);
          };
          depart();
        };
        preload.onerror = () => {
          if (this.latestScene !== e.id) return;
          useStore.getState().set({ sceneTransition: null });
          this.transport?.send({ type: 'scene.presented', id: e.id, ok: false });
          useStore.getState().set({ toast: '新画面暂时打不开，我们还在原处。' });
        };
        preload.src = e.url;
      } else {
        // photo：若已被打断（epoch 变化）则不再弹出
        if (this.pendingPhotoEpoch !== this.epoch || (this.latestPhoto && this.latestPhoto !== e.id)) return;
        st.set({ photo: { url: e.url, caption: e.caption ?? '' } });
      }
    }
  }

  // overlay = 当前底图的 i2i 编辑（事件直接发生在画面里）：先 preload 再上屏。
  // 生成期间转场（scene_key 不符）或剧情翻页（moment 的 revision 对不上）就不再浮现。
  private onOverlay(e: MediaEvent) {
    const epoch = this.epoch;
    const st = useStore.getState();
    if (e.status === 'generating') {
      if (e.purpose === 'moment') this.overlayRevs.set(e.id, st.story?.revision ?? -1);
      st.set({ generating: [...st.generating.filter((g) => g.id !== e.id), e] });
      return;
    }
    st.set({ generating: st.generating.filter((g) => g.id !== e.id) });
    const rev = this.overlayRevs.get(e.id);
    this.overlayRevs.delete(e.id);
    if (e.status !== 'ready' || !e.url) return;
    if (e.scene_key && e.scene_key !== st.bgKey) return;
    const ttl = e.ttl_ms ?? 60000;
    const preload = new Image();
    preload.onload = () => {
      if (epoch !== this.epoch) return;
      const cur = useStore.getState();
      if (e.scene_key && e.scene_key !== cur.bgKey) return;
      if (e.purpose === 'moment' && rev !== undefined && (cur.story?.revision ?? -1) !== rev) return;
      cur.set({
        overlay: { url: e.url!, sceneKey: e.scene_key ?? cur.bgKey, until: Date.now() + ttl, purpose: e.purpose, rev },
      });
    };
    preload.src = e.url;
  }
}
