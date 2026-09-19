import { arkChat } from './ark.js';
import { log } from './log.js';
import { pick, type Decide } from './decisions.js';
import { stripStage } from './duplex.js';
import { Story, isWorldAction, isTravelAction, sceneDescription, environmentOnly, type WorldUpdate } from './story.js';
import type { Content } from './content.js';
import type { GenImgOpts } from './genimg.js';
import type { StageDirective, StoryView } from '../../shared/protocol.js';

export interface Turn {
  role: 'user' | 'mira' | 'narration';
  text: string;
  ts: number;
  interrupted?: boolean;
}
export interface DirectorDecision {
  action: 'none' | 'invite';
  world?: WorldUpdate;
  revision?: number;
  reason?: string;
  speech?: string;
}
export interface DirectorHooks {
  injectNarration: (text: string) => void;
  speak: (line: string) => void;
  sendDirective: (d: StageDirective) => void;
  genimg: (kind: 'scene' | 'photo' | 'overlay', theme: string, opts?: GenImgOpts) => void;
  injectTurnPair: (user: string, mira: string) => void;
  injectAssistant?: (text: string) => void;
  narrateToClient: (text: string) => void;
  story: (view: StoryView) => void;
  available: () => boolean;
  worldContext?: () => unknown;
}

export class Director {
  turns: Turn[] = [];
  sceneKey = 'cafe_interior';
  private sceneDescription = '雨夜咖啡馆，窗边的桌子';
  private pendingScene = '';
  private miraFacts: string[] = [];
  pendingMedia = false;
  photoArmed = false;
  private photoSubject = '';
  lastSpeechEnd = Date.now();
  lastUserAt = 0;
  readonly story: Story;
  private revision = 0;
  private evalInFlight = false;
  private lastEvalAt = 0;
  private topic = '';
  private pendingQuestion = '';
  private facts: string[] = []; // Exact user quotes only; never inferred biographical facts.
  private textInFlight = 0;
  private lastPhotoAt = 0;
  private nextEventDelayMs = 80000;
  private invites = 0;
  private startedAt = Date.now();
  private worldTask = 0;
  private mediaSerial = 0;
  private activeMedia = new Set<string>();
  private continuationUsed = true; // No unsolicited follow-up to the opening/event.
  private decisionAbort = new AbortController();
  private reactionTask?: Promise<void>;
  private quietPreference = false;
  private reaction?: { kind: string; revision: number; expires: number };
  private reactionBlockedUntil = 0;
  private lastReactionAt = 0;
  private sceneIntent = 'unknown';
  private cadence?: {
    revision: number;
    playedAt?: number;
    planning: boolean;
    mode: 'continue' | 'yield' | 'quiet';
    speech: string;
    pauseMs: number;
  };

  constructor(
    private content: Content,
    private hooks: DirectorHooks,
    private chat: typeof arkChat = arkChat,
    private decide: Decide | null = null,
  ) {
    this.story = new Story();
  }
  get instructions() {
    return this.content.personaInstructions;
  }
  restore(key: string, description: string, turns: Turn[]) {
    this.sceneKey = key;
    this.sceneDescription = description;
    this.turns = turns.slice(-80);
    this.facts = this.turns
      .filter((t) => t.role === 'user')
      .map((t) => t.text)
      .slice(-24);
    this.miraFacts = this.turns
      .filter((t) => t.role === 'mira' && !t.interrupted)
      .map((t) => t.text)
      .slice(-24);
    if (turns.length) this.story.phase = 'together';
    const last = this.turns.at(-1);
    this.pendingQuestion = last?.role === 'user' ? last.text : '';
  }
  get turnCount() {
    return this.turns.filter((t) => t.role === 'user').length;
  }
  silenceSec() {
    return this.quietSec();
  }
  quietSec() {
    return (Date.now() - Math.max(this.lastSpeechEnd, this.lastUserAt)) / 1000;
  }
  noteUserActivity() {
    this.lastUserAt = Date.now();
    this.continuationUsed = true;
    this.invalidate();
  }
  invalidate() {
    this.decisionAbort.abort();
    this.decisionAbort = new AbortController();
    this.reaction = undefined;
    this.revision++;
    this.cadence = undefined;
  }
  // Returns the effective current utterance: consecutive user fragments spoken
  // before Mira's turn are one turn — context, topic and world evidence all see
  // the combined intent rather than whichever fragment VAD happened to cut on.
  noteUser(text: string, fromText = false): string {
    this.noteUserActivity();
    this.continuationUsed = false;
    const last = this.turns.at(-1);
    const merged = last?.role === 'user' && Date.now() - last.ts < 15000;
    if (merged) {
      last!.text = `${last!.text} ${text}`;
      last!.ts = Date.now();
    } else this.turns.push({ role: 'user', text, ts: Date.now() });
    this.turns = this.turns.slice(-80);
    const utterance = merged ? last!.text : text;
    this.topic = utterance;
    this.pendingQuestion = utterance;
    this.story.hear(text);
    if (this.decide) {
      this.quietPreference ||= this.story.quiet;
      this.story.quiet = this.quietPreference;
      this.sceneIntent = 'unknown';
      this.reactionTask = this.classifyReaction(utterance);
    }
    this.hooks.story(this.story.view());
    // Corrections are kept verbatim and ordered; later statements override earlier ones.
    if (/(我叫|叫我|我的名字|我喜欢|我不喜欢|我住|我在|不是|说错|更正|记住|我今天|我明天)/.test(text)) {
      this.facts = [...this.facts, text].slice(-24);
    }
    this.syncContext();
    if (
      /(看看|看一下|给我看|展示).*(照片|拍的)|照片.*(看看|给我)/.test(text) &&
      !/(不要|别|不想)/.test(text) &&
      Date.now() - this.lastPhotoAt > 15000
    ) {
      this.lastPhotoAt = Date.now();
      this.photoSubject = `Mira 手机或钱包里的一张照片，画面内容由这句话指定：${text.slice(0, 150)}`;
      this.photoArmed = true;
      if (fromText) {
        const photo = this.consumeArmedPhoto()!;
        this.hooks.genimg('photo', photo.subject, { caption: photo.caption, contextId: photo.contextId });
      }
    }
    return utterance;
  }
  choose(id: string): string | null {
    if (id === 'dismiss') {
      this.story.dismiss();
      this.hooks.story(this.story.view());
      this.syncContext();
      return null;
    }
    const text = this.story.choice(id);
    if (text) {
      this.story.dismiss();
      this.hooks.story(this.story.view());
    }
    return text;
  }
  noteMira(text: string) {
    const clean = stripStage(text).trim();
    if (!clean) return;
    const last = this.turns.at(-1);
    if (last?.role !== 'mira' || last.text !== clean) this.turns.push({ role: 'mira', text: clean, ts: Date.now() });
    this.turns = this.turns.slice(-80);
    if (/(我|以前|去年|刚才|小时候)/.test(clean)) this.miraFacts = [...this.miraFacts, clean].slice(-24);
    this.lastSpeechEnd = Date.now();
  }
  played() {
    this.lastSpeechEnd = Date.now();
    this.pendingQuestion = '';
    if (this.cadence && this.cadence.playedAt === undefined) this.cadence.playedAt = Date.now();
  }
  // Explicit performance owns the body until its hold finishes; Jev only supplies
  // bounded, nonverbal attention cues when that channel is free.
  noteStageDirective(d: StageDirective) {
    if (d.gesture || d.motion) {
      this.reactionBlockedUntil = Math.max(
        this.reactionBlockedUntil,
        Date.now() +
          Math.max(d.gesture?.hold_ms ?? (d.gesture ? 3500 : 0), d.motion?.duration_ms ?? (d.motion ? 12000 : 0)),
      );
    }
  }
  private async classifyReaction(utterance: string) {
    const revision = this.revision;
    try {
      const answers = await this.decide!(
        'reaction',
        {
          latest_user: utterance,
          quiet_preference: this.quietPreference,
          scene: this.sceneDescription,
          recent_turns: this.turns.slice(-6),
        },
        this.decisionAbort.signal,
      );
      if (revision !== this.revision) return;
      this.sceneIntent = pick(answers, 'intent', 'unknown');
      const quiet = pick(answers, 'quiet', 'keep', 0.85);
      if (quiet === 'enter') this.quietPreference = true;
      if (quiet === 'resume' || (this.sceneIntent === 'question' && answers.intent!.confidence >= 0.9))
        this.quietPreference = false;
      // An explicit local quiet request wins over conflicting independent answers.
      const explicitQuiet = new Story();
      explicitQuiet.hear(utterance);
      if (explicitQuiet.quiet) this.quietPreference = true;
      this.story.quiet = this.quietPreference;
      const kind = pick(answers, 'reaction', 'none');
      if (kind !== 'none') this.reaction = { kind, revision, expires: Date.now() + 6000 };
      this.syncContext();
      this.advanceReaction();
    } catch {
      if (revision === this.revision) log('director', 'jev reaction unavailable; keeping current behavior');
    }
  }
  advanceReaction() {
    const r = this.reaction;
    if (!r) return;
    if (r.revision !== this.revision || Date.now() > r.expires) {
      this.reaction = undefined;
      return;
    }
    if (
      !this.hooks.available() ||
      this.pendingScene ||
      this.pendingMedia ||
      this.story.phase === 'farewell' ||
      Date.now() < this.reactionBlockedUntil ||
      Date.now() - this.lastReactionAt < 8000
    )
      return;
    this.reaction = undefined;
    this.lastReactionAt = Date.now();
    if (r.kind === 'window' && /窗/.test(this.sceneDescription)) {
      this.hooks.sendDirective({ gesture: { gaze: 'window', hold_ms: 3500 } });
    } else if (r.kind === 'attentive') {
      this.hooks.sendDirective({ gesture: { gaze: 'user', hold_ms: 1800 } });
    } else if (r.kind === 'soften') {
      this.hooks.sendDirective({ emotion: 'soft_smile' });
    }
  }
  // Plan while buffered audio is still playing. Only a browser playback ACK starts the pause.
  async prepareContinuation() {
    const last = this.turns.at(-1);
    if (
      this.continuationUsed ||
      this.cadence ||
      !last ||
      last.role !== 'mira' ||
      last.interrupted ||
      this.story.quiet ||
      this.story.phase === 'farewell' ||
      this.pendingMedia ||
      this.pendingScene
    )
      return;
    const c: NonNullable<Director['cadence']> = {
      revision: this.revision,
      planning: true,
      mode: 'yield' as 'continue' | 'yield' | 'quiet',
      speech: '',
      pauseMs: 1200,
      playedAt: undefined,
    };
    this.cadence = c;
    try {
      if (this.decide) {
        await this.reactionTask;
        if (this.cadence !== c || c.revision !== this.revision || this.story.quiet) return;
        // A direct question always yields, regardless of a model's confidence.
        if (/[？?][’”」』"']?\s*$/.test(last.text)) return;
        const answers = await this.decide(
          'cadence',
          {
            recent_turns: this.turns.slice(-8),
            just_spoken: last.text,
            quiet_preference: this.story.quiet,
            phase: this.story.phase,
            task: '用户已经被回应，只判断这句实际说完的台词之后是否需要一次自然补充。',
          },
          this.decisionAbort.signal,
        );
        if (this.cadence !== c || c.revision !== this.revision) return;
        const mode = pick(answers, 'cadence', 'yield', 0.85);
        if (mode !== 'continue') {
          c.mode = mode === 'quiet' ? 'quiet' : 'yield';
          return;
        }
      }
      const raw = await this.chat({
        system: `${this.instructions}\n${CADENCE_PROMPT}`,
        user: JSON.stringify({
          ...this.context(),
          unanswered_user_turn: '',
          just_spoken: last.text,
          task: '上一条用户发言已经回应。仅决定刚说完之后的节奏，不再回答一次。',
        }),
        temperature: 0.3,
        timeoutMs: 5000,
        maxTokens: 320,
      });
      if (this.cadence !== c || c.revision !== this.revision) return;
      const plan = parseObject(raw);
      if (plan?.mode === 'quiet') c.mode = 'quiet';
      if (plan?.mode === 'continue') {
        const speech = spokenLine(plan.speech);
        // A continuation grants no new permission for secrets, props or world changes.
        if (
          speech &&
          !/[？?][’”」』"']?\s*$/.test(last.text) &&
          speech.length <= 180 &&
          speech !== last.text &&
          !RELATIONSHIP_HINT.test(speech) &&
          !INDIRECT_HINT.test(speech) &&
          !PHOTO_OFFER.test(speech)
        ) {
          c.mode = 'continue';
          c.speech = speech;
          c.pauseMs = Number.isFinite(plan.pause_ms) ? Math.max(900, Math.min(2400, plan.pause_ms)) : 1200;
        }
      }
      log('director', `cadence → ${c.mode}${c.speech ? `: ${c.speech}` : ''}`);
    } catch {
      /* Failed planning yields the floor; never retry into a late interruption. */
    } finally {
      c.planning = false;
    }
  }
  advanceConversation() {
    const c = this.cadence;
    if (!c || c.revision !== this.revision || c.playedAt === undefined) return;
    const elapsed = Date.now() - c.playedAt;
    if (c.mode === 'continue' && elapsed > 8000) {
      this.cadence = undefined;
      return;
    }
    if (c.planning || c.mode !== 'continue' || elapsed < c.pauseMs) return;
    if (
      this.story.quiet ||
      this.story.phase === 'farewell' ||
      this.pendingMedia ||
      this.pendingScene ||
      this.textInFlight ||
      !this.hooks.available()
    )
      return;
    this.cadence = undefined;
    this.continuationUsed = true; // At most one extra beat until the user actually speaks again.
    this.hooks.injectAssistant?.(c.speech);
    this.hooks.speak(c.speech);
    this.noteMira(c.speech);
    this.syncContext();
  }
  interrupted() {
    this.invalidate();
    const last = this.turns.at(-1);
    if (last?.role === 'mira') last.interrupted = true;
    this.lastSpeechEnd = Date.now();
  }
  noteNarration(text: string) {
    this.turns.push({ role: 'narration', text, ts: Date.now() });
  }
  context() {
    return {
      visited_world: this.hooks.worldContext?.(),
      interaction: {
        intent_hint: this.sceneIntent,
        quiet_preference: this.story.quiet,
        guidance: this.story.quiet
          ? '用户希望安静陪伴；必要时一句简短确认，之后保持安静。'
          : '正常回应当前用户；意图标签仅作提示，不建立行动事实。',
      },
      speaker_roles: {
        mira: '你自己，Mira；recent_turns中mira的台词是你说的',
        user: '对面的人；recent_turns中user的台词是他说的',
      },
      encounter_origin:
        '用户原本就在咖啡馆。Mira是刚进来请求坐下的人。开场询问座位的是Mira，用户答应后由Mira道谢，不能反过来招呼用户入座。这是初遇事实，不覆盖后来已确认的移动。',
      media_pending: this.pendingMedia,
      scene: this.sceneDescription,
      pending_scene: this.pendingScene || null,
      established_mira_quotes: this.miraFacts,
      story: this.story.context(),
      current_topic: this.topic,
      unanswered_user_turn: this.pendingQuestion,
      user_quotes_oldest_first: this.facts,
      recent_turns: this.turns
        .slice(-20)
        .map((t) => ({ role: t.role, text: t.text, ...(t.interrupted ? { interrupted: true } : {}) })),
    };
  }
  syncContext() {
    this.hooks.injectNarration(
      `（现场备忘，仅用于保持连续，不是用户发言，不要朗读或复述：${JSON.stringify(this.context())}）`,
    );
  }
  async evaluate(trigger: string): Promise<DirectorDecision | null> {
    // Silence is participation too. An ignored invitation may develop without choosing for the user.
    // 第一个契机多等一拍：刚坐下安静 20s 就发生事，相遇会显得刻意
    const minQuiet = this.invites === 0 ? 35 : 20;
    if (
      trigger !== 'tick' ||
      this.story.phase === 'farewell' ||
      this.story.quiet ||
      this.quietSec() < minQuiet ||
      this.pendingQuestion ||
      this.cadence?.planning ||
      this.cadence?.mode === 'continue' ||
      this.cadence?.mode === 'quiet' ||
      this.textInFlight ||
      this.pendingScene ||
      this.pendingMedia ||
      !this.hooks.available() ||
      Date.now() - this.story.lastEventAt < this.nextEventDelayMs ||
      Date.now() - this.lastEvalAt < 15000 ||
      this.evalInFlight
    )
      return null;
    this.lastEvalAt = Date.now();
    this.evalInFlight = true;
    const revision = this.revision;
    try {
      const raw = await this.chat({
        system: this.content.directorSystem,
        user: JSON.stringify({
          ...this.context(),
          silence_seconds: this.quietSec(),
          user_turns: this.turnCount,
          minutes_together: Math.round((Date.now() - this.startedAt) / 6000) / 10,
          prior_invitations: this.invites,
          previous_invitation_unanswered: this.story.phase === 'invitation',
          variation: Math.random(),
        }),
        timeoutMs: 10000,
        maxTokens: 650,
      });
      const d = parseDecision(raw);
      return d ? { ...d, revision } : null;
    } catch {
      return null;
    } finally {
      // A failure is allowed to remain quiet.
      this.evalInFlight = false;
    }
  }
  async apply(d: DirectorDecision | null) {
    if (
      !d ||
      d.action !== 'invite' ||
      d.revision !== this.revision ||
      this.quietSec() < 20 ||
      this.pendingQuestion ||
      this.story.quiet ||
      !this.hooks.available()
    )
      return;
    if (
      !d.world ||
      this.pendingMedia ||
      this.pendingScene ||
      this.textInFlight ||
      this.story.phase === 'farewell' ||
      Date.now() - this.story.lastEventAt < this.nextEventDelayMs
    )
      return;
    // A proactive event cannot establish shared history, even after a long silence.
    // Reject the whole beat so its choices/image cannot leak what speech withheld.
    const visible = [
      d.speech,
      d.world.title,
      d.world.event,
      d.world.visual_prompt,
      ...(d.world.choices ?? []).flatMap((c) => [c.label, c.text]),
    ].join(' ');
    const early = this.turnCount < 6 || this.invites < 2;
    if (RELATIONSHIP_HINT.test(visible) || (early && INDIRECT_HINT.test(visible))) return;
    if (!this.story.offer(d.world, true)) return;
    this.invites++;
    this.nextEventDelayMs = 75000 + Math.random() * 30000;
    this.hooks.story(this.story.view());
    this.noteNarration(this.story.event);
    this.syncContext();
    this.hooks.sendDirective({ emotion: 'soft_smile', gesture: { gaze: 'door', hold_ms: 2600 } });
    if (d.speech) {
      this.hooks.speak(d.speech);
      this.noteMira(d.speech);
      this.syncContext();
    }
    if (d.world.visual_prompt) this.generateMoment(d.world.visual_prompt);
    log('director', `encounter → ${this.story.title}`);
  }
  // noted: 调用方已记过 user 回合（真回合注入路径）时传入合并后的话，避免重复登记
  async handleTextTurn(userText: string, noted?: string): Promise<void> {
    const utterance = noted ?? this.noteUser(userText, true);
    const revision = this.revision;
    this.textInFlight++;
    try {
      const raw = await this.chat({
        system: `${this.instructions}\n${WORLD_PROMPT}\n这是文字对话。输出 JSON：{"reply":"Mira的口语回应：只写她本人说出口的台词，不写环境叙述或他人台词；默认1-3短句，对方邀她展开（讲故事、问细节）时可以说一小段","world":上述世界更新或null}。先接住用户话语。没有世界变化就world=null。`,
        user: JSON.stringify(this.context()),
        maxTokens: 800,
        timeoutMs: 15000,
      });
      if (revision !== this.revision) return;
      const result = parseObject(raw);
      const line = spokenLine(result?.reply);
      if (line && result?.world) this.applyWorld(result.world, utterance, line);
      // Some dialogue models agree verbally but omit the world update. Reconcile an
      // explicit action in a focused pass, so 'let us go' cannot remain a cosmetic reply.
      if (line && (!result?.world || result.world.action === 'none') && explicitAction(utterance)) {
        await this.handleVoiceWorld(utterance, line);
        if (revision !== this.revision) return;
      }
      if (!line) throw new Error('empty reply');
      this.hooks.injectTurnPair(userText, line);
      this.hooks.speak(line);
      this.noteMira(line);
      this.hooks.sendDirective({ emotion: this.story.quiet ? 'warm' : 'soft_smile', camera: 'idle_drift' });
      log('director', `text reply: ${line.slice(0, 100)}`);
    } catch (e) {
      if (revision !== this.revision) return;
      const line = '刚才卡了一下，你这句话我还没接上。可以再说一次吗？';
      this.hooks.injectTurnPair(userText, line);
      this.hooks.speak(line);
      this.noteMira(line);
      log('director', `reply failed: ${(e as Error).message.slice(0, 120)}`);
    } finally {
      this.textInFlight--;
    }
  }
  private applyWorld(world: WorldUpdate, userText: string, miraReply = '') {
    world = {
      ...world,
      scene_prompt: environmentOnly(world.scene_prompt),
      visual_prompt: sceneDescription(world.visual_prompt),
    };
    if (this.story.phase === 'farewell') return;
    if (world.action === 'resolve' && !isWorldAction(userText)) return;
    if (
      world.scene_prompt &&
      (!isTravelAction(userText) ||
        /(不一起|不去了|不能去|不方便|你(先|自己|慢)走|我.*(留在|留这|还得))/.test(miraReply))
    )
      return;
    // A generated destination is only a proposal until the client prepares it and
    // Session commits arrival. Never turn a provider's past-tense claim into fact.
    if (world.scene_prompt) world = { ...world, consequence: '正在准备前往新的地点，尚未抵达。' };
    if (world.action === 'resolve' && this.story.resolve(world, userText)) {
      this.hooks.story(this.story.view());
      this.hooks.narrateToClient(this.story.consequence);
      this.syncContext();
      if (world.scene_prompt) {
        // A location change is staged only after the user's action is established.
        const id = this.newMedia();
        const destination = userText.match(/(?:走到|前往|去)([^，。]{1,16}?)(?:看看|走走|坐坐|吧|。|$)/)?.[1];
        this.pendingScene = world.scene_prompt;
        this.hooks.genimg(
          'scene',
          `目的地${destination ? `（${destination}）` : ''}的环境：${world.scene_prompt}。镜头已经位于目的地内部，直接看见目的地环境，不从此前地点的窗户或门框观看。延续时间天气：${this.sceneDescription.match(/雨夜|夜晚|雨后|白天|清晨|黄昏|晴天|傍晚/g)?.join('，') || '与此前保持一致'}。`,
          { contextId: id },
        );
      } else if (world.visual_prompt) this.generateMoment(world.visual_prompt);
    } else if (world.action === 'dismiss' && world.evidence === userText) {
      this.story.dismiss();
      this.hooks.story(this.story.view());
      this.syncContext();
    }
  }
  // Native speech keeps the low latency audio path; a separate world pass establishes
  // lasting effects with a revision guard, so old decisions cannot overwrite new speech.
  async handleVoiceWorld(userText: string, miraReply = '') {
    if (!isWorldAction(userText)) return;
    const revision = this.revision,
      task = ++this.worldTask;
    try {
      const raw = await this.chat({
        system: WORLD_PROMPT + '\n只输出世界更新JSON；没有变化输出{"action":"none"}。',
        user: JSON.stringify({ ...this.context(), actual_mira_reply: miraReply }),
        maxTokens: 650,
        timeoutMs: 12000,
      });
      if (revision !== this.revision || task !== this.worldTask) return;
      const result = parseObject(raw);
      if (result) this.applyWorld(result as unknown as WorldUpdate, userText, miraReply);
    } catch {
      /* No invented outcome on a failed request. */
    }
  }
  private newMedia() {
    const id = `world_${++this.mediaSerial}`;
    this.activeMedia.add(id);
    this.pendingMedia = true;
    return id;
  }
  // 事件的可见变化直接编辑进当前场景底图（i2i 叠层），不弹独立画面
  private generateMoment(prompt: string) {
    this.hooks.genimg('overlay', prompt, { contextId: this.newMedia(), purpose: 'moment', sceneKey: this.sceneKey });
  }
  sceneReady(key: string, description: string) {
    this.sceneKey = key;
    this.sceneDescription = description;
    this.pendingScene = '';
    this.story.consequence = '';
    this.story.title = '';
    this.hooks.story(this.story.view());
    this.syncContext();
  }
  sceneFailed() {
    this.pendingScene = '';
    this.story.consequence = '';
    this.story.title = '';
    this.hooks.story(this.story.view());
    this.syncContext();
  }
  onMediaSettled(id?: string) {
    if (id) this.activeMedia.delete(id);
    this.pendingMedia = this.activeMedia.size > 0;
  }
  consumeArmedPhoto(): { subject: string; caption: string; contextId: string } | null {
    if (!this.photoArmed) return null;
    this.photoArmed = false;
    return { subject: this.photoSubject, caption: '今晚，慢慢看。', contextId: this.newMedia() };
  }
  // "递照片"兜底：她的台词或 show_photo 动作表达了展示意图却没调工具时补上，
  // 避免她说了"喏，这张"而对面什么也没看见。主体尽量由她的原话指定。
  armPhotoFromSpeech(line = '', force = false) {
    const clean = stripStage(line).trim();
    const offered = PHOTO_OFFER.test(clean);
    if (this.photoArmed) {
      if (clean && offered) this.photoSubject = `Mira 照片里拍下的内容，画面由她这句台词指定：${clean.slice(0, 150)}`;
      return;
    }
    if (!force && !offered) return;
    if (this.pendingMedia || Date.now() - this.lastPhotoAt < 15000) return;
    this.lastPhotoAt = Date.now();
    this.photoSubject = clean
      ? `Mira 照片里拍下的内容，画面由她这句台词指定：${clean.slice(0, 150)}`
      : 'Mira 相机里的一张照片：旅途中拍下的一个瞬间，有故事感';
    this.photoArmed = true;
  }
  // 工具路径已生成照片：记下时间戳并解除兜底，本回合台词检测不再叠第二张
  notePhotoDispatched() {
    if (this.pendingMedia || (!this.photoArmed && Date.now() - this.lastPhotoAt < 15000)) return false;
    this.lastPhotoAt = Date.now();
    this.photoArmed = false;
    return true;
  }
  degradeFor(_kind: 'timeout' | 'bad') {
    this.pendingMedia = false;
  } // Media failures never steal the conversation.
}

const WORLD_PROMPT = `你维护开放的共同世界，没有预设剧情或固定结局。
世界更新格式：{"action":"resolve|dismiss|none","evidence":"最新用户原话，必须逐字一致","consequence":"已经发生的具体结果","scene_prompt":"仅双方确实去新地方时的新场景描述，否则省略","visual_prompt":"值得共同看见的局部结果或物件近景，否则省略"}。
你不是演员，不回答用户，不编写Mira的对白、动作表演、回忆或心理描写。consequence只能是1句简短的外部世界变化，禁止引号内台词和“她说”等转述。夸赞照片、评价、感谢、问经历、年龄、职业、感受等普通聊天必须none。未移动时省略scene_prompt，禁止填字符串“无”或“none”。scene_prompt仅是明确移动目的地的画面提示，绝不能填Mira的回答。
用户明确做了或同意了某件事才 resolve。接住自由提议，不限制在选项中。用户只是提问、猜想、举例、否定、拒绝或说以后再去，不得转场，不得把它当成已发生；none即可。需要询问对方才能成立的后果也不要擅自写成事实。
“我们现在出发吧”“我们一起推门出去”是明确行动，应resolve；不能口头答应却不更新世界。明确离开当前场景时必须提供scene_prompt。
actual_mira_reply是演员本回合实际说出的回应，优先级高于你的设想；她拒绝同行时不得写成双方出发。用户单独告别不转场，停留在告别画面。
只改变用户参与的事情，不额外添事故、人物关系或用户情绪。保持已有地点、人物事实、历史后果一致。用户改话题不用强行处理事件；明确说不参与可dismiss。场景未就绪时台词表达准备行动，不说已经抵达。生成图片可花时间，不声称用户已看见。`;

// 台词里"把照片递到眼前"的信号：展示语气词/给对方看/指示照片类扁平物
const PHOTO_OFFER = /(喏|诺|呐)|给(你|您)看|看看?这|这(一)?张|掏出|翻出|拿给|合照|旧照片|照片.{0,8}(给|看)/;

// Shared history belongs in answers to the user, never unsolicited director beats.
const RELATIONSHIP_HINT =
  /((?:第一次|初次).{0,4}(?:见面|相遇|相见)|初见|重逢|失忆|(?:那天|那晚|当时).{0,8}(?:我们|咱们)|(?:我们|咱们).{0,12}(?:那天|那晚|相识|见过|相遇|常听|常来)|你(们)?(还|也|真|难道|是不是)?[^，。]{0,6}(认识|认得|记得|想起|认出)|(认识|记得|记得住|认出)我|不记得|似曾相识|眼熟|面熟|(你|你们|我们|咱们|他)[^，。]{0,6}(以前|从前|过去|当年)|(以前|从前|过去|当年)[^，。]{0,4}(你|你们|我们|咱们)|老照片|旧照片|合照|女朋友|男朋友|恋人|情侣|前任)/;

// Even indirect clues wait until the encounter has room for them.
const INDIRECT_HINT = /以前有个|从前有个|那个人|问雨的记忆|旧物|旧歌|熟悉的歌|老板娘.{0,8}(认得|认识)|名字.{0,12}想起/;

function explicitAction(text: string) {
  return (
    /(我们|一起|现在|我|带|陪).*(去|走|出门|出去|出发|到|回|推门|拿起|打开|写下|放下|看看|逛逛)/.test(text) &&
    !/(如果|假如|假设|以后|改天|不要|不想|别|吗|？|\?)/.test(text)
  );
}

function parseObject(raw: string): Record<string, any> | null {
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}
export function parseDecision(raw: string): DirectorDecision | null {
  const d = parseObject(raw);
  if (!d || (d.action !== 'none' && d.action !== 'invite')) return null;
  if (d.action === 'invite' && (!d.world || typeof d.world.event !== 'string' || typeof d.world.title !== 'string'))
    return null;
  const speech = spokenLine(d.speech).slice(0, 180);
  if (d.action === 'invite' && !speech) return null;
  return { action: d.action, world: d.world, reason: String(d.reason ?? ''), speech };
}

// A generated director line can arrive as third-person prose plus quoted dialogue.
// Only its actual dialogue belongs in the shared speech/subtitle channel.
export function spokenLine(value: unknown): string {
  if (typeof value !== 'string') return '';
  const clean = stripStage(value).trim();
  if (!clean) return '';
  if (/^(Mira|米拉|她)/i.test(clean)) {
    const quotes = [...clean.matchAll(QUOTED)].map((m) => m[1].trim()).filter(Boolean);
    return quotes.join('');
  }
  // Scene narration and other actors' reported speech are not her line. Dropping
  // the whole decision is quieter than reading stage prose aloud.
  return narrationLike(clean) ? '' : clean;
}

const QUOTED = /[「“"‘’]([^」”"’']+)[」”"’']/g;
// Third parties described acting （老板娘把热可可放桌上 / 猫跳上窗台） — places and
// pronouns are excluded on purpose: she legitimately says both in her own lines.
const NARRATED =
  /(?:老板娘|老板|服务员|店员|路人|客人|旁人|旁白|情侣|猫|狗|手机|电话|收音机|门铃)[^。！？!?]{0,32}(?:把|将|端|放|递|推|拉|瞥|看|望|笑|响|亮|闪|点|摇|招|起|坐|拿|开|关|停|滑|滚|围|蹭|跳|钻|躲|踩|撑|脱|抖|拧|拍|伸|靠|走|进|退|回|侧|低|抬|垂|弯|咬|眯|皱)/;
// A quote attributed to a speech verb is someone else's line （笑着说「…」).
const REPORTED =
  /(?:说|道|问|答|喊|唱|笑|念|读|叫|低语|呢喃|嘟囔|嘀咕|解释|补充|提醒|招呼|介绍|安慰|自言自语)[^「」"“”‘’'【】()（）]{0,10}[「“"‘’'`]/;

function narrationLike(text: string): boolean {
  return /^(?:旁白|场景|叙述|舞台提示)\s*[:：]/.test(text) || NARRATED.test(text) || REPORTED.test(text);
}

const CADENCE_PROMPT = `你正在决定自己刚说完后是否还有一个自然接着说的念头，不是在回答新的用户消息。
先判断：用户想休息或缓一缓，quiet；刚才问了一个需要回答的问题，yield；否则才考虑是否有值得补充的念头。
只输出JSON：{"mode":"continue|yield|quiet","speech":"仅continue时填写接下来真正说出口的台词，否则空字符串","pause_ms":1200}。
continue：刚才只是初步回应，仍有自然的好奇、联想或自我分享，可以稍停900-2400毫秒再补1-2句。比如对方说可以叫他Bug，你刚说“Bug？挺特别的名字。”，可以继续问“这个名字是怎么来的？”。不要机械复述，不评价名字奇怪，不同时盘问多个问题。也可以分享自己的观察，绝非每次补问句。
yield：已经问了一个真正等对方回答的问题、发出邀请，或已经说得完整，此刻把话交给他；禁止换种说法继续追问。修辞疑问不必机械当作提问。
quiet：适合共同留白，如疲惫、情绪倾诉后已经接住、用户想安静或告别；不催答，不为了填满沉默而说话。
不要每轮都续话。只顺着当前具体话题，不制造新事件、不移动场景、不递照片、不替用户行动。刚才没说完的可以补足，但不重说已经说过的话。原有信息边界继续有效，不能因用户未接话而多揭露关系或过去。“我们认识吗”只承认认识之后必须yield，等他自己追问。`;
