import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Director, parseDecision, spokenLine, type DirectorHooks } from '../server/src/director.js';
import { legacyPhotoDisplayRejected as photoDisplayRejected } from '../server/src/compat/legacy-photo.js';
import { ClientSession } from '../server/src/session.js';
import { Story } from '../server/src/story.js';
import { loadContent } from '../server/src/content.js';
import { ClientDirector } from '../web/src/state/directorClient.js';
import { useStore } from '../web/src/state/store.js';
import { SCENE_ARRIVE_MS, SCENE_DEPART_MS } from '../web/src/state/sceneTransition.js';
import type { DownMessage, UpMessage } from '../shared/protocol.js';

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function harness(
  chat: ConstructorParameters<typeof Director>[2] = async () => '{"reply":"好，我记住了。"}',
  decide: ConstructorParameters<typeof Director>[3] = null,
) {
  const spoken: string[] = [],
    media: unknown[] = [],
    contexts: string[] = [],
    narrations: string[] = [];
  const hooks: DirectorHooks = {
    injectNarration: (t) => contexts.push(t),
    speak: (t) => spoken.push(t),
    sendDirective: () => {},
    genimg: (...a) => media.push(a),
    injectTurnPair: () => {},
    narrateToClient: (t) => narrations.push(t),
    story: () => {},
    available: () => true,
  };
  return { d: new Director(loadContent(), hooks, chat, decide), spoken, media, contexts, narrations };
}

test('provider failure stays in character and a later turn recovers normally', async () => {
  let calls = 0;
  const { d, spoken } = harness(async () => {
    if (++calls === 1) throw new Error('provider unavailable');
    return '{"reply":"我喜欢坐在窗边听雨。"}';
  });
  await d.handleTextTurn('你喜欢雨天吗？');
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /没听清/);
  assert.doesNotMatch(spoken[0], /卡了|接口|API|超时|网络|服务/);
  assert.equal(d.turns.filter((t) => t.role === 'user').length, 1);
  await d.handleTextTurn('我是问你喜欢雨天吗？');
  assert.equal(spoken.at(-1), '我喜欢坐在窗边听雨。');
  assert.equal(calls, 2);
});

test('late provider failure cannot speak a fallback over newer user activity', async () => {
  let reject!: (e: Error) => void;
  const { d, spoken } = harness(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const pending = d.handleTextTurn('旧问题');
  d.noteUserActivity();
  reject(new Error('timeout'));
  await pending;
  assert.deepEqual(spoken, []);
});

test('world is generated, choices are optional, results require the exact current utterance', () => {
  const s = new Story();
  assert.equal(
    s.offer({
      action: 'offer',
      title: '收音机里的旧歌',
      event: '吧台的收音机响起一段旧歌。',
      choices: [{ id: 'anything', label: '问她听过没有', text: '你听过这首歌吗？' }],
    }),
    true,
  );
  assert.match(s.choice(s.view().choices[0].id)!, /听过/);
  assert.equal(
    s.resolve({ action: 'resolve', evidence: '别的回合', consequence: '发生了' }, '我们自己唱一首吧。'),
    false,
  );
  assert.equal(
    s.resolve(
      { action: 'resolve', evidence: '我们自己唱一首吧。', consequence: '你们轻轻哼起了自己的旋律。' },
      '我们自己唱一首吧。',
    ),
    true,
  );
  assert.equal(s.view().choices.length, 0);
  assert.match(s.context().confirmed_consequences[0].consequence, /自己的旋律/);
  assert.equal(s.offer({ action: 'offer', title: '新的去向', event: '雨停后，可以去桥边走走。' }), true);
});

test('strict director schema rejects invented action names', () => {
  assert.equal(parseDecision('{"action":"glance_door"}'), null);
  assert.equal(parseDecision('{"action":"invite"}'), null);
});

// ---------- 原子姿态：解析 + 强制校正 ----------
test('gesture atoms compose freely; physical conflicts are force-corrected and reported', async () => {
  const { normalizeGesture, showsPhoto } = await import('../server/src/duplex.js');

  // 自由组合原样通过
  const free = normalizeGesture({ hand_r: 'table', torso: { lean: 0.4 }, gaze: 'down', hold_ms: 3500 });
  assert.equal(free.corrections.length, 0);
  assert.equal(free.gesture?.hand_r, 'table');
  assert.equal(free.gesture?.torso?.lean, 0.4);

  // 双手同锚点 → 砍掉后写的左手
  const dup = normalizeGesture({ hand_r: 'face', hand_l: 'face' });
  assert.equal(dup.gesture?.hand_r, 'face');
  assert.equal(dup.gesture?.hand_l, undefined);
  assert.equal(dup.corrections[0].reason, 'both_hands_same_anchor');

  // hands 共位覆盖单手写
  const both = normalizeGesture({ hands: 'hold_center', hand_r: 'lap' });
  assert.equal(both.gesture?.hands, 'hold_center');
  assert.equal(both.gesture?.hand_r, undefined);

  // 有道具没有手 → 自动补一只展示位的手
  const prop = normalizeGesture({ prop: 'photo' });
  assert.equal(prop.gesture?.hand_r, 'forward_low');
  assert.equal(prop.corrections[0].reason, 'prop_needs_hand');
  assert.equal(showsPhoto(prop.gesture), true);

  // gaze=prop 但没有道具 → 视线改为低垂
  const g = normalizeGesture({ gaze: 'prop' });
  assert.equal(g.gesture?.gaze, 'down');

  // 后仰够不到桌前 → 收躯干而不是砍手
  const reach = normalizeGesture({ torso: { lean: -0.8 }, hand_r: 'table' });
  assert.equal(reach.gesture?.torso?.lean, -0.3);
  assert.equal(reach.gesture?.hand_r, 'table');

  // 埋头时不强行看着用户
  const bowed = normalizeGesture({ head: { pitch: -0.6 } });
  assert.equal(bowed.gesture?.gaze, 'down');

  // 连续量限幅（带 gaze 避免触发"转身但看着用户"规则）
  const wild = normalizeGesture({ torso: { lean: 5, turn: -9 }, gaze: 'window', hold_ms: 99999 });
  assert.equal(wild.gesture?.torso?.lean, 1);
  assert.equal(wild.gesture?.torso?.turn, -0.7);
  assert.equal(wild.gesture?.hold_ms, 8000);

  // 大转身却默认看着用户 → 转身收限（看人的优先级更高）；看向别处则不受限
  const turned = normalizeGesture({ torso: { turn: 0.7 } });
  assert.equal(turned.gesture?.torso?.turn, 0.5);
  assert.equal(
    turned.corrections.some((c) => c.reason === 'turn_limited_while_facing_user'),
    true,
  );

  // 能量预算：全身同时推满 → 连续量等比收缩
  const maxed = normalizeGesture({
    hand_r: 'chest',
    hand_l: 'chest',
    torso: { lean: 1, turn: 0.7 },
    head: { pitch: -0.7, tilt: 0.6 },
    hold_ms: 3000,
  });
  const e =
    Math.abs(maxed.gesture!.torso!.lean!) +
    Math.abs(maxed.gesture!.torso!.turn!) +
    Math.abs(maxed.gesture!.head!.pitch!) +
    Math.abs(maxed.gesture!.head!.tilt!);
  assert.ok(e < 3.0 && maxed.corrections.some((c) => c.reason === 'pose_energy_budget'));
});

test('legacy action strings and model slips still resolve to gestures', async () => {
  const { parseDirective } = await import('../server/src/duplex.js');
  const old = parseDirective({ action: 'hug_cup', emotion: 'warm' });
  assert.deepEqual(old.directive.gesture, { hands: 'hold_center', prop: 'cup' });
  assert.equal(old.corrections[0]?.reason, 'legacy_action_mapped');
  const cn = parseDirective({ action: '抱紧杯子' });
  assert.equal(cn.directive.gesture?.hands, 'hold_center');
  const shown = parseDirective({ gesture: { hand_l: 'forward_eye', prop: 'photo', gaze: 'user' } });
  assert.equal(shown.directive.gesture?.prop, 'photo');
});

test('full-body motion is normalized independently and composes with gesture', async () => {
  const { normalizeMotion, parseDirective } = await import('../server/src/duplex.js');
  const walk = normalizeMotion({ action: 'walk', direction: 'left', style: 'brisk', duration_ms: 3000 });
  assert.deepEqual(walk.motion, { action: 'walk', direction: 'left', style: 'brisk', duration_ms: 3000 });
  assert.equal(walk.corrections.length, 0);

  assert.equal(normalizeMotion({ action: 'walk', duration_ms: 10 }).motion?.duration_ms, 800);
  assert.equal(normalizeMotion({ action: 'dance', duration_ms: 99000 }).motion?.duration_ms, 12000);
  const dance = normalizeMotion({ action: 'dance', direction: 'left', style: 'playful' });
  assert.equal(dance.motion?.direction, undefined);
  assert.equal(dance.corrections[0]?.reason, 'direction_not_used_by_action');

  const composed = parseDirective({
    motion: { action: 'walk', direction: 'forward', duration_ms: 2400 },
    gesture: { gaze: 'door', hand_r: 'chest' },
    emotion: 'warm',
  });
  assert.equal(composed.directive.motion?.action, 'walk');
  assert.equal(composed.directive.gesture?.gaze, 'door');
  assert.equal(composed.directive.gesture?.hand_r, 'chest');
});

test('a photo raised forward reads as showing; clutched to chest does not', async () => {
  const { showsPhoto } = await import('../server/src/duplex.js');
  assert.equal(showsPhoto({ prop: 'photo', hand_l: 'forward_eye' }), true);
  assert.equal(showsPhoto({ prop: 'photo', hand_r: 'chest' }), false);
  assert.equal(showsPhoto({ prop: 'cup', hand_r: 'forward_low' }), false);
  assert.equal(showsPhoto(undefined), false);
});

test('consecutive user utterances merge into one turn; a Mira turn breaks the chain', () => {
  const { d } = harness();
  d.noteUser('我今天路过桥边。');
  d.noteUser('突然想起那首歌。');
  assert.equal(d.turnCount, 1);
  assert.match(d.context().unanswered_user_turn, /路过桥边.*那首歌/);
  d.noteMira('嗯？');
  d.played();
  d.noteUser('还有一件事。');
  assert.equal(d.turnCount, 2);
  assert.equal(d.context().unanswered_user_turn, '还有一件事。');
});

test('typing retains corrections verbatim and answers with no injected microphone channel', async () => {
  const { d, spoken, contexts } = harness();
  await d.handleTextTurn('我叫小林，记住我喜欢雨。');
  await d.handleTextTurn('刚才说错了，我叫小琳，不是小林。');
  assert.equal(spoken.length, 2);
  assert.deepEqual(d.context().user_quotes_oldest_first, [
    '我叫小林，记住我喜欢雨。',
    '刚才说错了，我叫小琳，不是小林。',
  ]);
  assert.match(contexts.at(-1)!, /小琳/);
});

test('a stale generated reply cannot speak over a newer turn', async () => {
  let finish!: (s: string) => void;
  const { d, spoken } = harness(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = d.handleTextTurn('我叫小林。');
  d.noteUserActivity();
  finish('{"reply":"旧回合回复"}');
  await pending;
  assert.equal(spoken.length, 0);
});

test('no automatic turn-end event; user speech invalidates a pending quiet-time event', async () => {
  let finish!: (s: string) => void;
  const { d } = harness(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  d.noteUser('你好');
  d.noteMira('你好');
  d.noteUser('雨很大');
  d.noteMira('是啊');
  d.played();
  Object.assign(d, {
    startedAt: Date.now() - 120000,
    lastSpeechEnd: Date.now() - 45000,
    lastUserAt: Date.now() - 45000,
  });
  assert.equal(await d.evaluate('turn_end'), null);
  const pending = d.evaluate('tick');
  d.noteUserActivity();
  finish(
    '{"action":"invite","speech":"你听，风铃响了。","world":{"action":"offer","title":"新事件","event":"风铃响了"}}',
  );
  await d.apply(await pending);
  assert.equal(d.story.phase, 'arrival');
});

test('explicit free speech can change location; a question does not change location', async () => {
  const { d, media } = harness(async (opts) => {
    const input = JSON.parse(opts.user);
    const text = input.current_topic;
    return text === '我们现在去桥边吧。'
      ? JSON.stringify({
          reply: '好，带上伞，我们出发。',
          world: {
            action: 'resolve',
            evidence: text,
            consequence: '你们决定一起去桥边。',
            scene_prompt: '雨后的小桥，平视，无人物',
          },
        })
      : JSON.stringify({ reply: '可以啊，你想现在去吗？', world: null });
  });
  await d.handleTextTurn('如果去桥边会怎么样？');
  assert.equal(media.length, 0);
  await d.handleTextTurn('我们现在去桥边吧。');
  assert.equal(media.length, 1);
  assert.equal((media[0] as any[])[0], 'scene');
});

test('request for quiet blocks events and farewell does not force a new plot', async () => {
  const { d } = harness(async () => {
    throw new Error('must not be called');
  });
  d.noteUser('不用说话，陪我听雨。');
  Object.assign(d, { startedAt: 0, lastSpeechEnd: 0, lastUserAt: 0 });
  assert.equal(await d.evaluate('tick'), null);
  d.noteUser('晚安');
  assert.equal(d.story.phase, 'farewell');
});

test('playback, not server generation state, owns speaking; stale audio end is ignored', () => {
  const client = new ClientDirector(false);
  const sent: UpMessage[] = [];
  let remaining = 400;
  const testClient = client as unknown as { engine: unknown; transport: unknown; onMessage(m: DownMessage): void };
  testClient.engine = {
    playbackRemainingMs: () => remaining,
    stopPlayback: () => {
      remaining = 0;
    },
  };
  testClient.transport = { send: (m: UpMessage) => sent.push(m) };
  useStore.setState({ phase: 'listening', subtitles: [] });
  testClient.onMessage({ type: 'audio.begin', response_id: 'new', sample_rate: 24000 });
  testClient.onMessage({ type: 'audio.end', response_id: 'old' });
  testClient.onMessage({ type: 'state', phase: 'listening' });
  assert.equal(useStore.getState().phase, 'speaking');
  remaining = 0;
  testClient.onMessage({ type: 'audio.end', response_id: 'new' });
  assert.equal(useStore.getState().phase, 'listening');
  assert.deepEqual(sent.at(-1), { type: 'playback', response_id: 'new', remaining_ms: 0 });
});

test('a held response is not released when the user is already speaking', async () => {
  const session = new ClientSession('interrupt-regression');
  const sent: string[] = [];
  const s = session as unknown as {
    ws: { readyState: number; bufferedAmount: number; send: (payload: string | Buffer) => void };
    userSpeaking: boolean;
    dropAudio: boolean;
    curResponseId: string;
    pending: { rid: string; pcm: Buffer[]; text: string[]; timer: NodeJS.Timeout };
    onDuplexEvent: (event: Record<string, unknown>) => void;
  };
  s.ws = {
    readyState: 1,
    bufferedAmount: 0,
    send: (payload) => sent.push(typeof payload === 'string' ? payload : payload.toString('base64')),
  };
  s.userSpeaking = true;
  s.dropAudio = true;
  s.curResponseId = 'held-response';
  s.pending = {
    rid: 'held-response',
    pcm: [Buffer.from('late-audio')],
    text: ['late text'],
    timer: setTimeout(() => {}, 60_000),
  };

  s.onDuplexEvent({ type: 'response.output_audio.done', response_id: 'held-response' });

  assert.ok(s.pending, 'the held response must remain gated until the interruption decision settles');
  assert.equal(
    sent.some((payload) => payload.includes('audio.begin')),
    false,
    'audio must not begin while user speech is active',
  );
  clearTimeout(s.pending.timer);
  await session.destroy();
});

test('bare PCM outside the audio.begin→end window is never played', () => {
  const client = new ClientDirector(false);
  const played: ArrayBuffer[] = [];
  const c = client as unknown as {
    engine: unknown;
    transport: unknown;
    onMessage(m: DownMessage): void;
    onAudioFrame(b: ArrayBuffer): void;
  };
  c.engine = { playPcm: (b: ArrayBuffer) => played.push(b), playbackRemainingMs: () => 0, stopPlayback: () => {} };
  c.transport = { send: () => {} };
  useStore.setState({ phase: 'listening', subtitles: [] });
  const frame = new ArrayBuffer(960);
  c.onAudioFrame(frame);
  assert.equal(played.length, 0); // 没有任何 begin 的裸帧不播
  c.onMessage({ type: 'audio.begin', response_id: 'r1', sample_rate: 24000 });
  c.onAudioFrame(frame);
  assert.equal(played.length, 1);
  c.onMessage({ type: 'audio.end', response_id: 'r1' });
  c.onAudioFrame(frame);
  assert.equal(played.length, 1); // end 之后的迟到帧丢弃——上游开窗期尾音不会变成无源怪声
  c.onMessage({ type: 'audio.begin', response_id: 'r2', sample_rate: 24000 });
  c.onAudioFrame(frame);
  assert.equal(played.length, 2); // 下一段正常恢复
});

test('muted microphone cannot send audio or locally interrupt', () => {
  const client = new ClientDirector(false);
  const testClient = client as unknown as { transport: unknown; onMicFrame(pcm: ArrayBuffer, rms: number): void };
  testClient.transport = {
    sendAudio: () => {
      throw new Error('audio leaked');
    },
    send: () => {
      throw new Error('interrupt leaked');
    },
  };
  useStore.setState({ phase: 'speaking', micMuted: true, entered: true });
  for (let n = 0; n < 30; n++) testClient.onMicFrame(new ArrayBuffer(640), 0.8);
  assert.equal(useStore.getState().phase, 'speaking');
});

test('verbal agreement without a world update is reconciled for explicit departure', async () => {
  const { d, media } = harness(async (opts) =>
    opts.system.includes('这是文字对话')
      ? '{"reply":"好，我们走吧。","world":null}'
      : JSON.stringify({
          action: 'resolve',
          evidence: '我们现在推门出去吧。',
          consequence: '你们准备去桥边。',
          scene_prompt: '雨后的桥边',
        }),
  );
  await d.handleTextTurn('我们现在推门出去吧。');
  assert.equal(media.length, 1);
  assert.equal((media[0] as any[])[0], 'scene');
});

test('an accepted colloquial invitation commits the requested departure', async () => {
  const text = '要不要跟我去桥边走呗？';
  const { d, media } = harness(
    async (opts) =>
      opts.system.includes('这是文字对话')
        ? JSON.stringify({ reply: '走呗。', world: null })
        : JSON.stringify({
            action: 'resolve',
            evidence: text,
            consequence: '你们一起往桥边走去。',
            scene_prompt: '雨后的桥边',
          }),
    async () => ({
      intent: { choice: 'action', confidence: 0.99 },
      quiet: { choice: 'keep', confidence: 0.99 },
      reaction: { choice: 'none', confidence: 0.99 },
    }),
  );
  await d.handleTextTurn(text);
  assert.equal(media.length, 1);
  assert.equal((media[0] as any[])[0], 'scene');
});

test('late cached media cannot replace the latest scene; location is acknowledged after loading', async () => {
  const client = new ClientDirector(false);
  const sent: UpMessage[] = [];
  const testClient = client as unknown as { transport: unknown; onMessage(m: DownMessage): void };
  testClient.transport = { send: (m: UpMessage) => sent.push(m) };
  const original = (globalThis as any).Image;
  (globalThis as any).Image = class {
    onload?: () => void;
    set src(_url: string) {
      this.onload?.();
    }
  };
  try {
    useStore.setState({ phase: 'listening', bgUrl: 'original', bgKey: 'cafe_interior', generating: [] });
    for (const id of ['old', 'new'])
      testClient.onMessage({ type: 'media.event', event: { id, kind: 'scene', status: 'generating' } });
    testClient.onMessage({
      type: 'media.event',
      event: { id: 'old', kind: 'scene', status: 'ready', cached: true, url: 'old.jpg' },
    });
    assert.equal(useStore.getState().bgUrl, 'original');
    testClient.onMessage({
      type: 'media.event',
      event: { id: 'new', kind: 'scene', status: 'ready', cached: true, url: 'new.jpg' },
    });
    assert.equal(useStore.getState().bgUrl, 'original');
    assert.equal(useStore.getState().sceneTransition?.phase, 'departing');
    await new Promise((resolve) => setTimeout(resolve, SCENE_DEPART_MS + SCENE_ARRIVE_MS + 120));
    assert.equal(useStore.getState().bgUrl, 'new.jpg');
    assert.deepEqual(sent.at(-1), { type: 'scene.presented', id: 'new', ok: true });
  } finally {
    (globalThis as any).Image = original;
  }
});

test('native photo fallback is consumed once, and text photo requests do not await a native tool', () => {
  const native = harness();
  native.d.noteUser('给我看看你拍的海边照片。');
  assert.equal(native.media.length, 0);
  assert.match(native.d.consumeArmedPhoto()!.subject, /海边/);
  assert.equal(native.d.consumeArmedPhoto(), null);
  const typed = harness();
  typed.d.noteUser('给我看看你拍的海边照片。', true);
  assert.equal(typed.media.length, 1);
  assert.equal(typed.d.consumeArmedPhoto(), null);
});

test('a spoken photo offer without the tool call still arms a photo; ordinary speech does not', () => {
  const { d } = harness();
  d.armPhotoFromSpeech('雨这么大，你是来等人的吗？');
  assert.equal(d.photoArmed, false);
  assert.equal(d.consumeArmedPhoto(), null);
  d.armPhotoFromSpeech('算是吧，到处跑着拍。喏，这张是刚才路口的雨帘，路灯透过来的光软得很。');
  assert.equal(d.photoArmed, true);
  assert.match(d.consumeArmedPhoto()!.subject, /雨帘/);
});

test('a just-dispatched show_photo call blocks the speech fallback from stacking a second photo', () => {
  const { d } = harness();
  d.notePhotoDispatched();
  d.armPhotoFromSpeech('喏，这张给你看。');
  assert.equal(d.photoArmed, false);
  assert.equal(d.consumeArmedPhoto(), null);
});

test('a refusal in the final photo reply suppresses the staged image', async () => {
  assert.equal(photoDisplayRejected('那是旧照片，没有。'), true);
  assert.equal(photoDisplayRejected('那不是旧照片，是彩虹，我给你看。'), false);

  const session = new ClientSession('photo-refusal-test');
  const s = session as unknown as {
    genimg: { generate: (...args: unknown[]) => void };
    duplex: { returnToolResults: () => void; close: () => Promise<void> };
    ws: { readyState: number; send: (raw: string) => void };
    miraText: string;
    stagedPhoto?: { contextId: string };
    onToolCalls: (evt: Record<string, unknown>) => void;
    onDuplexEvent: (evt: Record<string, unknown>) => void;
    onGeneratedMedia: (evt: Record<string, unknown>) => void;
  };
  const generated: unknown[][] = [];
  const sent: Record<string, unknown>[] = [];
  s.genimg = { generate: (...args) => generated.push(args) };
  s.duplex = { returnToolResults: () => {}, close: async () => {} };
  s.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>) };
  s.onToolCalls({
    response_id: 'tool-photo-1',
    items: [
      { name: 'show_photo', call_id: 'call-photo-1', arguments: JSON.stringify({ subject: '彩虹', caption: '彩虹' }) },
    ],
  });
  assert.equal(generated.length, 1, 'photo generation starts before the final spoken reply');
  const contextId = s.stagedPhoto!.contextId;
  s.onGeneratedMedia({ id: 'photo-generating', kind: 'photo', status: 'generating', context_id: contextId });
  assert.equal(
    sent.some((m) => m.type === 'media.event'),
    false,
    'generating is kept off the client',
  );
  s.onDuplexEvent({ type: 'response.done', response_id: 'tool-photo-1' });
  assert.equal(generated.length, 1, 'the tool response itself is not the final spoken confirmation');
  s.miraText = '那是旧照片，没有。';
  s.onDuplexEvent({ type: 'response.output_audio.done', response_id: 'reply-photo-1' });
  s.onGeneratedMedia({
    id: 'photo-ready',
    kind: 'photo',
    status: 'ready',
    url: 'unrelated.jpg',
    context_id: contextId,
  });
  assert.equal(
    sent.some((m) => m.type === 'media.event'),
    false,
    'a refused photo never reaches the client',
  );
  await session.destroy();
});

test('an accepted staged photo releases a result that finished early', async () => {
  const session = new ClientSession('photo-accept-test');
  const s = session as unknown as {
    genimg: { generate: (...args: unknown[]) => void };
    duplex: { returnToolResults: () => void; close: () => Promise<void> };
    ws: { readyState: number; send: (raw: string) => void };
    miraText: string;
    stagedPhoto?: { contextId: string };
    onToolCalls: (evt: Record<string, unknown>) => void;
    onDuplexEvent: (evt: Record<string, unknown>) => void;
    onGeneratedMedia: (evt: Record<string, unknown>) => void;
  };
  const sent: Record<string, unknown>[] = [];
  s.genimg = { generate: () => {} };
  s.duplex = { returnToolResults: () => {}, close: async () => {} };
  s.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>) };
  s.onToolCalls({
    response_id: 'tool-photo-2',
    items: [{ name: 'show_photo', call_id: 'call-photo-2', arguments: JSON.stringify({ subject: '彩虹' }) }],
  });
  const contextId = s.stagedPhoto!.contextId;
  s.onGeneratedMedia({
    id: 'photo-ready-2',
    kind: 'photo',
    status: 'ready',
    url: 'rainbow.jpg',
    context_id: contextId,
  });
  assert.equal(
    sent.some((m) => m.type === 'media.event'),
    false,
    'ready is held until the reply is confirmed',
  );
  s.miraText = '喏，这张就是彩虹。';
  s.onDuplexEvent({ type: 'response.output_text.done', response_id: 'reply-photo-2', text: s.miraText });
  s.onDuplexEvent({ type: 'response.output_audio.done', response_id: 'reply-photo-2' });
  assert.equal(
    sent.some((m) => m.type === 'media.event'),
    true,
    'accepted photo is released to the client',
  );
  await session.destroy();
});

test('the show_photo gesture alone arms a photo, and her spoken line refines its subject', () => {
  const { d } = harness();
  d.armPhotoFromSpeech('', true);
  assert.equal(d.photoArmed, true);
  d.armPhotoFromSpeech('看，这张是在桥头拍的。');
  assert.match(d.consumeArmedPhoto()!.subject, /桥头/);
});

test('a user-requested armed photo adopts her offer line as subject', () => {
  const { d } = harness();
  d.noteUser('给我看看你拍的照片。');
  d.armPhotoFromSpeech('喏，这张是去年冬天在桥上拍的。');
  assert.match(d.consumeArmedPhoto()!.subject, /桥上/);
});

test('silence from entry triggers spoken events, and ignoring an invitation does not freeze the world', async () => {
  let n = 0;
  const { d, spoken } = harness(async () =>
    JSON.stringify({
      action: 'invite',
      speech: `听，第${++n}阵风来了。`,
      world: { action: 'offer', title: '风里的纸片', event: `第${n}阵风把纸片吹到窗边。` },
    }),
  );
  d.noteMira('进来避雨吧。');
  d.played();
  d.lastSpeechEnd = Date.now() - 40000; // 第一个契机等 35s+ 的安静
  await d.apply(await d.evaluate('tick'));
  assert.equal(d.turnCount, 0);
  assert.equal(d.story.phase, 'invitation');
  assert.equal(spoken[0], '听，第1阵风来了。');
  d.played();
  Object.assign(d, { lastSpeechEnd: Date.now() - 75000, lastEvalAt: 0, nextEventDelayMs: 0 });
  d.story.lastEventAt = Date.now() - 75000;
  await d.apply(await d.evaluate('tick'));
  assert.equal(spoken.length, 2);
  assert.match(d.story.event, /第2阵/);
  assert.equal(d.story.history.length, 0, 'silence must not accept a choice');
});

test('proactive events never confirm shared history just because several turns passed', async () => {
  const reveal = async () =>
    JSON.stringify({
      action: 'invite',
      speech: '这首歌……以前有人总点。',
      world: {
        action: 'offer',
        title: '旧歌',
        event: '收音机放起一首你们以前常听的歌。',
        choices: [{ id: 'x', label: '问她怎么知道', text: '你怎么知道这首？' }],
      },
    });
  const { d, spoken } = harness(reveal);
  Object.assign(d, { lastSpeechEnd: 0, lastUserAt: 0, lastEvalAt: 0, nextEventDelayMs: 0 });
  d.story.lastEventAt = 0;
  await d.apply(await d.evaluate('tick'));
  assert.equal(d.story.phase, 'arrival', 'reveal-scented event must not fire while the encounter is young');
  assert.equal(spoken.length, 0);
  // More small talk is not permission to confirm shared history.
  for (let i = 0; i < 4; i++) {
    d.noteUser(`随便聊聊${i}`);
    d.noteMira('嗯');
    d.played();
  }
  Object.assign(d, { lastSpeechEnd: 0, lastUserAt: 0, lastEvalAt: 0 });
  d.story.lastEventAt = 0;
  await d.apply(await d.evaluate('tick'));
  assert.equal(d.story.phase, 'arrival');
});

test('a moment worth seeing becomes an overlay edit on the current scene, never a separate card', async () => {
  const { d, media } = harness(async () =>
    JSON.stringify({
      action: 'invite',
      speech: '你听。',
      world: { action: 'offer', title: '窗台', event: '一只猫跳上了窗台。', visual_prompt: '窗台上的猫' },
    }),
  );
  Object.assign(d, { lastSpeechEnd: 0, lastUserAt: 0, lastEvalAt: 0, nextEventDelayMs: 0 });
  d.story.lastEventAt = 0;
  await d.apply(await d.evaluate('tick'));
  const call = media.find((m) => (m as unknown[])[0] === 'overlay') as unknown[] | undefined;
  assert.ok(call, 'event visuals render into the scene as overlay');
  assert.equal((call[2] as { purpose?: string }).purpose, 'moment');
  assert.equal((call[2] as { sceneKey?: string }).sceneKey, 'cafe_interior');
});

test('a confirmed consequence reaches the user as narration, not a spoken line', async () => {
  const text = '我把灯关暗一点。';
  const { d, narrations } = harness(async () =>
    JSON.stringify({
      reply: '嗯，暗一点也好。',
      world: {
        action: 'resolve',
        evidence: text,
        consequence: '灯光暗了一格。',
      },
    }),
  );
  await d.handleTextTurn(text);
  assert.deepEqual(narrations, ['灯光暗了一格。']);
});

test('a moment overlay lands on its own scene and retires when the story turns', async () => {
  const client = new ClientDirector(false);
  const c = client as unknown as { transport: unknown; onMessage(m: DownMessage): void };
  c.transport = { send: () => {} };
  const original = (globalThis as any).Image;
  (globalThis as any).Image = class {
    onload?: () => void;
    set src(_u: string) {
      this.onload?.();
    }
  };
  const storyAt = (revision: number): DownMessage => ({
    type: 'story',
    story: {
      revision,
      phase: revision === 3 ? 'invitation' : 'together',
      title: 't',
      prop: '',
      event: 'e',
      consequence: '',
      choices: [],
    },
  });
  try {
    useStore.setState({ bgKey: 'cafe_interior', overlay: null, generating: [] });
    c.onMessage(storyAt(3));
    c.onMessage({
      type: 'media.event',
      event: { id: 'ov1', kind: 'overlay', status: 'generating', purpose: 'moment', scene_key: 'cafe_interior' },
    });
    c.onMessage({
      type: 'media.event',
      event: {
        id: 'ov1',
        kind: 'overlay',
        status: 'ready',
        url: 'ov.jpg',
        purpose: 'moment',
        scene_key: 'cafe_interior',
        ttl_ms: 90000,
      },
    });
    assert.equal(useStore.getState().overlay?.url, 'ov.jpg');
    c.onMessage(storyAt(4));
    assert.equal(useStore.getState().overlay, null, 'overlay of the previous beat must fade with it');
    useStore.setState({ bgKey: 'street_at_night', overlay: null });
    c.onMessage(storyAt(5));
    c.onMessage({
      type: 'media.event',
      event: {
        id: 'ov2',
        kind: 'overlay',
        status: 'ready',
        url: 'late.jpg',
        purpose: 'moment',
        scene_key: 'cafe_interior',
        ttl_ms: 90000,
      },
    });
    assert.equal(useStore.getState().overlay, null, 'a late overlay must not appear over a different scene');
  } finally {
    (globalThis as any).Image = original;
  }
});

test('biographical question rejects a hallucinated world update even with exact evidence', async () => {
  const question = '那你这个样子很年轻呀，怎么会想着当这个？';
  const { d, media, spoken } = harness(async () =>
    JSON.stringify({
      reply: '上学时就喜欢摄影。',
      world: {
        action: 'resolve',
        evidence: question,
        consequence: 'Mira声音带着笑意：“从高中拍到彩虹开始吧。”',
        scene_prompt: 'Mira看向窗外',
      },
    }),
  );
  await d.handleTextTurn(question);
  assert.equal(d.story.consequence, '');
  assert.equal(media.length, 0);
  assert.deepEqual(spoken, ['上学时就喜欢摄影。']);
});

test('world result cannot become a second actor script; quiet description is not a quiet request', () => {
  const s = new Story();
  s.hear('这里很安静。');
  assert.equal(s.quiet, false);
  s.hear('安静一会，陪我听雨。');
  assert.equal(s.quiet, true);
  const user = '我们现在出去吧。';
  assert.equal(s.resolve({ action: 'resolve', evidence: user, consequence: '她说：“我们走吧。”' }, user), false);
});

test('director prose is separated from spoken dialogue before entering the audio channel', () => {
  const decision = parseDecision(
    JSON.stringify({
      action: 'invite',
      speech: 'Mira看着窗外，指尖划过杯壁：「这雨好像在故意拉长夜晚似的。」',
      world: { action: 'offer', title: '窗外', event: '风铃响了。' },
    }),
  );
  assert.equal(decision?.speech, '这雨好像在故意拉长夜晚似的。');
  assert.equal(
    parseDecision(
      JSON.stringify({ action: 'invite', speech: 'Mira看着窗外。', world: { title: '窗外', event: '风铃响了。' } }),
    ),
    null,
  );
});

test('scene narration written into the speech field is dropped before the audio channel', () => {
  const narration = '老板娘把两杯热可可放桌上，笑着说‘刚煮的，暖暖身子’';
  assert.equal(spokenLine(narration), '');
  assert.equal(spokenLine('老板娘端来两杯冒着热气的热可可，杯壁凝着水珠。'), '');
  assert.equal(spokenLine('他说「别走」，声音很低。'), '');
  assert.equal(spokenLine('旁白：风铃响了。'), '');
  assert.equal(
    parseDecision(
      JSON.stringify({
        action: 'invite',
        speech: narration,
        world: { action: 'offer', title: '热可可', event: '老板娘端来热可可。' },
      }),
    ),
    null,
  );
  // Her own observations stay speakable even when they mention third parties.
  assert.equal(spokenLine('你听，风铃响了。'), '你听，风铃响了。');
  assert.equal(spokenLine('老板娘人真好。'), '老板娘人真好。');
  assert.equal(spokenLine('门口好像有人进来了，我去看看。'), '门口好像有人进来了，我去看看。');
});

test('initial mute is committed upstream, rather than assumed already active', async () => {
  const { DuplexClient } = await import('../server/src/duplex.js');
  const d = new DuplexClient({ onEvent: () => {}, onClose: () => {} });
  const sent: any[] = [];
  const internals = d as unknown as { send: (m: unknown) => void; commitMute: (muted: boolean) => void };
  internals.send = (m) => sent.push(m);
  internals.commitMute(true);
  internals.commitMute(true);
  assert.deepEqual(sent, [{ type: 'input_audio_mute.commit' }]);
});

test('photo praise is not an action even when world model invents a result or a scene', async () => {
  for (const scene_prompt of ['无', 'none', '湖边的白天']) {
    const text = '拍的很好呀。';
    const { d, media } = harness(async () =>
      JSON.stringify({
        reply: '谢谢，雨天的光很特别。',
        world: {
          action: 'resolve',
          evidence: text,
          consequence: 'Mira收起手机，看向窗外雨幕。',
          scene_prompt,
        },
      }),
    );
    await d.handleTextTurn(text);
    assert.equal(media.length, 0);
    assert.equal(d.story.history.length, 0);
  }
});

test('local action with no-scene placeholder stays local; local action cannot authorize travel', async () => {
  for (const scene_prompt of ['无', 'none', '远处的湖边']) {
    const text = '我把杯子拿起来。';
    const { d, media } = harness(async () =>
      JSON.stringify({
        reply: '小心烫。',
        world: {
          action: 'resolve',
          evidence: text,
          consequence: '杯子离开了桌面。',
          scene_prompt,
        },
      }),
    );
    await d.handleTextTurn(text);
    assert.equal(media.length, 0);
  }
});

test('speaking or typing after viewing a photo closes it, and old ready events cannot reopen it', () => {
  for (const input of ['voice', 'text']) {
    const client = new ClientDirector(false);
    const c = client as unknown as { transport: unknown; onMessage(m: DownMessage): void };
    c.transport = { send: () => {} };
    useStore.setState({ phase: 'listening', photo: null, generating: [] });
    c.onMessage({ type: 'media.event', event: { id: 'old-photo', kind: 'photo', status: 'generating' } });
    c.onMessage({ type: 'media.event', event: { id: 'old-photo', kind: 'photo', status: 'ready', url: 'photo.jpg' } });
    assert.ok(useStore.getState().photo);
    if (input === 'text') client.sendText('拍得很好呀。');
    else c.onMessage({ type: 'transcript.user', text: '拍得很好呀。', final: true });
    assert.equal(useStore.getState().photo, null);
    c.onMessage({ type: 'media.event', event: { id: 'old-photo', kind: 'photo', status: 'ready', url: 'photo.jpg' } });
    assert.equal(useStore.getState().photo, null);
  }
});

test('goodbye clears the event card and never transports the companion', async () => {
  const text = '我要走了';
  const { d, media } = harness(async () =>
    JSON.stringify({
      reply: '好，路上小心。',
      world: {
        action: 'resolve',
        evidence: text,
        consequence: '用户站起身准备离开。',
        scene_prompt: '外面的街道',
      },
    }),
  );
  d.story.offer({ action: 'offer', title: '窗边', event: '风铃响了。' });
  await d.handleTextTurn(text);
  assert.equal(media.length, 0);
  assert.equal(d.story.phase, 'farewell');
  assert.equal(d.story.title, '');
  assert.equal(d.story.consequence, '');
});

test('voice world uses the actual reply; a refusal cannot turn into a joint departure', async () => {
  const text = '我们现在一起出发去桥边吧。';
  let observed = '';
  const { d, media } = harness(async (opts) => {
    observed = JSON.parse(opts.user).actual_mira_reply;
    return JSON.stringify({ action: 'resolve', evidence: text, consequence: '两人出发。', scene_prompt: '雨夜桥边' });
  });
  d.noteUser(text);
  await d.handleVoiceWorld(text, '我还得整理照片，就不一起了。你慢走。');
  assert.match(observed, /不一起/);
  assert.equal(media.length, 0);
});

test('proposed travel cannot narrate arrival before the scene commits', async () => {
  const text = '我们现在一起出发去桥边吧。';
  const { d, narrations, media } = harness(async () =>
    JSON.stringify({
      action: 'resolve',
      evidence: text,
      consequence: '两人已经抵达桥边。',
      scene_prompt: '雨夜桥边',
    }),
  );
  d.noteUser(text);
  await d.handleVoiceWorld(text, '好，我们走吧。');
  assert.equal(media.length, 1);
  assert.deepEqual(narrations, ['正在准备前往新的地点，尚未抵达。']);
  assert.doesNotMatch(JSON.stringify(d.story.context()), /已经抵达/);
  d.sceneFailed();
  assert.equal(d.story.consequence, '');
  assert.equal(d.story.title, '');
});

test('background prompt removes actors and no-change placeholders', async () => {
  const { environmentOnly } = await import('../server/src/story.js');
  assert.equal(environmentOnly('无'), undefined);
  assert.equal(
    environmentOnly('雨夜街道，两人并肩撑伞（或共穿雨衣）走向桥边，雨水打湿地面反射灯光'),
    '雨夜街道，雨水打湿地面反射灯光',
  );
});

test('loaded scene waits for speech and a newer scene cancels an older scheduled cut', async () => {
  const client = new ClientDirector(false);
  const sent: UpMessage[] = [];
  const c = client as unknown as { transport: unknown; onMessage(m: DownMessage): void };
  c.transport = { send: (m: UpMessage) => sent.push(m) };
  const original = (globalThis as any).Image;
  (globalThis as any).Image = class {
    onload?: () => void;
    set src(_url: string) {
      this.onload?.();
    }
  };
  try {
    useStore.setState({ phase: 'speaking', bgUrl: 'cafe', generating: [] });
    const offer = (id: string) => {
      c.onMessage({ type: 'media.event', event: { id, kind: 'scene', status: 'generating' } });
      c.onMessage({ type: 'media.event', event: { id, kind: 'scene', status: 'ready', url: id + '.jpg' } });
    };
    offer('first');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(useStore.getState().bgUrl, 'cafe');
    assert.equal(useStore.getState().sceneTransition?.phase, 'preparing');
    useStore.setState({ phase: 'listening' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(useStore.getState().sceneTransition?.phase, 'departing');
    offer('second');
    await waitFor(() => useStore.getState().bgUrl === 'second.jpg' && useStore.getState().sceneTransition === null);
    assert.equal(useStore.getState().bgUrl, 'second.jpg');
    assert.equal(useStore.getState().sceneTransition, null);
    assert.deepEqual(sent, [{ type: 'scene.presented', id: 'second', ok: true }]);
  } finally {
    (globalThis as any).Image = original;
  }
});

test('second-turn first-meeting spoiler is rejected across every event output', async () => {
  const leak = '这雨……像我们第一次见面那天。';
  for (const channel of ['speech', 'title', 'event', 'visual_prompt', 'label', 'text']) {
    const beat: any = {
      action: 'invite',
      speech: '杯子还很烫。',
      world: {
        action: 'offer',
        title: '热可可',
        event: '吧台端来热可可。',
        choices: [{ label: '暖暖手', text: '我捧起杯子暖暖手。' }],
      },
    };
    if (channel === 'speech') beat.speech = leak;
    else if (channel === 'label' || channel === 'text') beat.world.choices[0][channel] = leak;
    else beat.world[channel] = leak;
    const { d, spoken, media } = harness(async () => JSON.stringify(beat));
    for (const text of ['你好', '可以。']) {
      d.noteUser(text);
      d.noteMira('嗯。');
      d.played();
    }
    Object.assign(d, { lastSpeechEnd: 0, lastUserAt: 0, lastEvalAt: 0, nextEventDelayMs: 0 });
    await d.apply(await d.evaluate('tick'));
    assert.equal(d.story.phase, 'arrival', channel);
    assert.deepEqual(spoken, [], channel);
    assert.deepEqual(media, [], channel);
  }
});

test('silence and repeated invitations cannot unlock indirect backstory for a quiet user', async () => {
  const { d, spoken } = harness(async () =>
    JSON.stringify({
      action: 'invite',
      speech: '以前有个人，每次来都点这个。',
      world: { action: 'offer', title: '杯子', event: '杯口冒着热气。' },
    }),
  );
  Object.assign(d, { invites: 8, lastSpeechEnd: 0, lastUserAt: 0, lastEvalAt: 0, nextEventDelayMs: 0 });
  await d.apply(await d.evaluate('tick'));
  assert.deepEqual(spoken, []);
});

test('neutral second-turn event remains playable without making rain into a shared memory', async () => {
  const { d, spoken } = harness(async () =>
    JSON.stringify({
      action: 'invite',
      speech: '这雨一时半会儿停不了呢。',
      world: {
        action: 'offer',
        title: '杯子',
        event: '杯口冒着热气。',
        choices: [{ label: '暖暖手', text: '我捧起杯子。' }],
      },
    }),
  );
  for (const text of ['你好', '可以。']) {
    d.noteUser(text);
    d.noteMira('嗯。');
    d.played();
  }
  Object.assign(d, { lastSpeechEnd: 0, lastUserAt: 0, lastEvalAt: 0, nextEventDelayMs: 0 });
  await d.apply(await d.evaluate('tick'));
  assert.equal(d.story.phase, 'invitation');
  assert.deepEqual(spoken, ['这雨一时半会儿停不了呢。']);
  assert.equal(d.story.choices.length, 1);
});

// Cadence uses actual playback completion, not response generation completion.
test('continuation pauses after playback ACK, runs once, and stays on topic', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const { d, spoken } = harness(async () =>
    JSON.stringify({ mode: 'continue', speech: '这个名字是怎么来的？', pause_ms: 1200 }),
  );
  d.noteUser('你可以叫我 Bug。');
  d.noteMira('Bug？挺特别的名字。');
  await d.prepareContinuation();
  t.mock.timers.tick(5000);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
  d.played();
  t.mock.timers.tick(1199);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
  t.mock.timers.tick(1);
  d.advanceConversation();
  assert.deepEqual(spoken, ['这个名字是怎么来的？']);
  await d.prepareContinuation();
  d.played();
  t.mock.timers.tick(5000);
  d.advanceConversation();
  assert.equal(spoken.length, 1);
});

test('speech activity cancels both pending plans and a planned pause', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  let resolve!: (s: string) => void;
  const { d, spoken } = harness(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  d.noteUser('叫我 Bug');
  d.noteMira('挺特别的名字。');
  const planning = d.prepareContinuation();
  d.played();
  d.noteUserActivity();
  resolve('{"mode":"continue","speech":"这个名字怎么来的？"}');
  await planning;
  t.mock.timers.tick(3000);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
  d.noteUser('是我的网名');
  d.noteMira('原来如此。');
  const next = d.prepareContinuation();
  resolve('{"mode":"continue","speech":"我也喜欢给照片起名字。"}');
  await next;
  d.played();
  d.invalidate();
  t.mock.timers.tick(3000);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
});

test('yield, quiet, malformed plans and failures never manufacture follow-up speech', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  for (const mode of ['yield', 'quiet', 'invalid', 'failure']) {
    const { d, spoken } = harness(async () => {
      if (mode === 'failure') throw new Error('offline');
      return JSON.stringify({ mode, speech: '你为什么不回答？' });
    });
    d.noteUser('你好');
    d.noteMira('今天怎么样？');
    await d.prepareContinuation();
    d.played();
    t.mock.timers.tick(2000);
    d.advanceConversation();
    assert.equal(spoken.length, 0);
  }
});

test('quiet requests, farewell and unsolicited relationship reveals cannot continue', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  for (const user of ['先别说话，陪我安静一会儿。', '再见，我先走了。', '叫我 Bug']) {
    const { d, spoken } = harness(async () => '{"mode":"continue","speech":"我是你的女朋友。"}');
    d.noteUser(user);
    d.noteMira('嗯。');
    await d.prepareContinuation();
    d.played();
    t.mock.timers.tick(3000);
    d.advanceConversation();
    assert.equal(spoken.length, 0);
  }
});

test('continuation expires rather than speaking after a long blocked pause', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const { d, spoken } = harness(async () => '{"mode":"continue","speech":"这个名字怎么来的？"}');
  d.noteUser('叫我 Bug');
  d.noteMira('挺特别的名字。');
  await d.prepareContinuation();
  d.played();
  d.pendingMedia = true;
  t.mock.timers.tick(2000);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
  t.mock.timers.tick(7000);
  d.pendingMedia = false;
  d.advanceConversation();
  assert.equal(spoken.length, 0);
});

test('reset returns the whole stage to the entrance and asks the server for a fresh session', async () => {
  const client = new ClientDirector(false);
  const sent: UpMessage[] = [];
  const c = client as unknown as { engine: unknown; transport: unknown };
  c.engine = { stopPlayback: () => {}, stopThunder: () => {}, setRainLevel: () => {} };
  c.transport = { send: (m: UpMessage) => sent.push(m) };
  useStore.setState({
    phase: 'speaking',
    entered: true,
    sessionId: 'old-sid',
    resumed: true,
    story: {
      revision: 3,
      phase: 'invitation',
      title: '窗边',
      prop: '',
      event: '猫跳上窗台。',
      consequence: '',
      choices: [],
    },
    subtitles: [{ id: 1, who: 'mira', text: '嗨', final: true }],
    bgUrl: '/media/street.jpg',
    bgKey: 'street',
    overlay: { url: 'o.jpg', sceneKey: 'street', until: 0 },
    fg: { url: 'f.jpg', sceneKey: 'street' },
    generating: [{ id: 'g', kind: 'photo', status: 'generating' }],
    photo: { url: 'p.jpg', caption: '' },
    sceneTransition: { id: 'g', phase: 'departing', startedAt: 0 },
    camera: 'close_up',
    emotion: 'warm',
    motion: { action: 'dance' },
    gesture: { hand_r: 'table' },
    toast: 'x',
  });
  const resetting = client.reset();
  const s = useStore.getState();
  assert.equal(s.entered, false);
  assert.equal(s.phase, 'boot');
  assert.equal(s.story, null);
  assert.equal(s.bgKey, 'cafe_interior');
  assert.equal(s.bgUrl, '/assets/bg/cafe_interior.jpg');
  assert.deepEqual(s.subtitles, []);
  assert.equal(s.sessionId, '');
  assert.equal(s.resumed, false);
  assert.equal(s.generating.length, 0);
  assert.equal(s.photo, null);
  assert.equal(s.sceneTransition, null);
  assert.equal(s.overlay, null);
  assert.equal(s.fg, null);
  assert.equal(s.gesture, null);
  assert.equal(s.camera, 'idle_drift');
  assert.equal(s.emotion, 'neutral');
  assert.equal(s.motion, null);
  assert.deepEqual(sent, [{ type: 'reset' }]);
  (client as any).onMessage({ type: 'session', session_id: 'new-sid', resumed: false });
  await resetting;
});

test('a reset-era media event cannot repaint the wiped scene', async () => {
  const client = new ClientDirector(false);
  const c = client as unknown as { engine: unknown; transport: unknown; onMessage(m: DownMessage): void };
  c.engine = { stopPlayback: () => {}, stopThunder: () => {}, setRainLevel: () => {} };
  c.transport = { send: () => {} };
  const original = (globalThis as any).Image;
  (globalThis as any).Image = class {
    onload?: () => void;
    set src(_u: string) {
      this.onload?.();
    }
  };
  try {
    useStore.setState({ phase: 'listening', entered: true, bgKey: 'street', bgUrl: 'street.jpg', generating: [] });
    c.onMessage({ type: 'media.event', event: { id: 'old-scene', kind: 'scene', status: 'generating' } });
    const resetting = client.reset();
    // 换会话窗口：新 session 就位前，旧会话的迟到下行一律丢弃
    c.onMessage({ type: 'media.event', event: { id: 'old-scene', kind: 'scene', status: 'ready', url: 'late.jpg' } });
    c.onMessage({
      type: 'media.event',
      event: { id: 'old-photo', kind: 'photo', status: 'ready', url: 'late-photo.jpg' },
    });
    c.onMessage({ type: 'transcript.mira', delta: '旧台词', response_id: 'old' });
    await new Promise((r) => setTimeout(r, 2600));
    assert.equal(useStore.getState().bgUrl, '/assets/bg/cafe_interior.jpg');
    assert.equal(useStore.getState().bgKey, 'cafe_interior');
    assert.equal(useStore.getState().photo, null);
    assert.equal(useStore.getState().sceneTransition, null);
    assert.equal(useStore.getState().subtitles.length, 0);
    // 新 session 就位后，新会话的事件正常落地
    c.onMessage({ type: 'session', session_id: 'new-sid', resumed: false });
    await resetting;
    useStore.setState({ phase: 'listening', entered: true });
    c.onMessage({ type: 'media.event', event: { id: 'new-scene', kind: 'scene', status: 'generating' } });
    c.onMessage({ type: 'media.event', event: { id: 'new-scene', kind: 'scene', status: 'ready', url: 'fresh.jpg' } });
    await new Promise((r) => setTimeout(r, 2600));
    assert.equal(useStore.getState().bgUrl, 'fresh.jpg');
  } finally {
    (globalThis as any).Image = original;
  }
});

test('a model trying to continue after a direct question is held to yielding', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const { d, spoken } = harness(async () => '{"mode":"continue","speech":"听起来像代码里的名字。"}');
  d.noteUser('叫我 Bug');
  d.noteMira('这个名字是怎么来的？');
  await d.prepareContinuation();
  d.played();
  t.mock.timers.tick(2000);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
});

test('activity before audio completion prevents replanning until a real new user turn', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  let calls = 0;
  const { d, spoken } = harness(async () => {
    calls++;
    return '{"mode":"continue","speech":"这个名字怎么来的？"}';
  });
  d.noteUser('叫我 Bug');
  d.noteMira('挺特别的名字。');
  d.noteUserActivity();
  await d.prepareContinuation();
  d.played();
  t.mock.timers.tick(2000);
  d.advanceConversation();
  assert.equal(calls, 0);
  assert.equal(spoken.length, 0);
});

test('local speech during a listening pause notifies the server before transcription', () => {
  const client = new ClientDirector(false);
  const sent: UpMessage[] = [];
  const c = client as unknown as { transport: unknown; onMicFrame(pcm: ArrayBuffer, rms: number): void };
  c.transport = { send: (m: UpMessage) => sent.push(m), sendAudio() {} };
  useStore.setState({ entered: true, micMuted: false, phase: 'listening' });
  for (let i = 0; i < 6; i++) c.onMicFrame(new ArrayBuffer(640), 0.04);
  assert.deepEqual(sent, [{ type: 'user.activity' }]);
  client.noteInputActivity();
  assert.equal(sent.length, 2);
  useStore.setState({ micMuted: true });
  for (let i = 0; i < 10; i++) c.onMicFrame(new ArrayBuffer(640), 0.04);
  assert.equal(sent.length, 2);
});

test('photo tool does not duplicate a typed request or a previous tool dispatch', () => {
  const typed = harness();
  typed.d.noteUser('给我看看你拍的极光照片。', true);
  assert.equal(typed.media.length, 1);
  assert.equal(typed.d.notePhotoDispatched(), false);
  const tool = harness();
  assert.equal(tool.d.notePhotoDispatched(), true);
  assert.equal(tool.d.notePhotoDispatched(), false);
});

test('missing media terminal event expires and late success cannot reopen the photo', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new ClientDirector(false);
  const c = client as unknown as { onMessage(m: DownMessage): void };
  useStore.setState({ generating: [], photo: null, toast: '' });
  c.onMessage({ type: 'media.event', event: { id: 'lost', kind: 'photo', status: 'generating' } });
  t.mock.timers.tick(300000);
  assert.equal(useStore.getState().generating.length, 0);
  assert.match(useStore.getState().toast, /暂时/);
  c.onMessage({ type: 'media.event', event: { id: 'lost', kind: 'photo', status: 'ready', url: 'late.jpg' } });
  assert.equal(useStore.getState().photo, null);
});

test('reconnect is single-flight and exhausted attempts remain manually retryable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new ClientDirector(false);
  const c = client as unknown as {
    engine: unknown;
    start(): Promise<void>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
  };
  c.engine = { dispose: async () => {} };
  let attempts = 0;
  let fail!: (error: Error) => void;
  c.start = () => {
    attempts++;
    return new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
  };
  for (let i = 0; i < 3; i++) {
    const attempt = client.reconnect();
    await Promise.resolve();
    await client.reconnect();
    assert.equal(attempts, i + 1);
    fail(new Error('offline'));
    await attempt;
  }
  assert.equal(useStore.getState().phase, 'reconnecting');
  assert.match(useStore.getState().toast, /点屏幕重试/);
  t.mock.timers.tick(60000);
  assert.equal(attempts, 3);
});

test('disconnected input does not create a thinking turn or send a lost message', () => {
  const client = new ClientDirector(false);
  const sent: UpMessage[] = [];
  (client as unknown as { transport: unknown }).transport = { send: (m: UpMessage) => sent.push(m) };
  useStore.setState({ phase: 'reconnecting', subtitles: [] });
  client.sendText('still typing');
  client.choose('choice');
  assert.deepEqual(sent, []);
  assert.deepEqual(useStore.getState().subtitles, []);
  assert.equal(useStore.getState().phase, 'reconnecting');
});

test('an error toast during reconnect cannot unlock disconnected input', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = new ClientDirector(false);
  const c = client as unknown as { engine: unknown; onMessage(m: DownMessage): void };
  c.engine = { playbackRemainingMs: () => 0 };
  useStore.setState({ phase: 'reconnecting' });
  c.onMessage({ type: 'error', code: 'duplex_close_1006', message: '正在恢复连接' });
  assert.equal(useStore.getState().phase, 'reconnecting');
});

test('reset waits for the replacement session and rejects connection failure', async (t) => {
  const initial = useStore.getState();
  t.after(() => useStore.setState(initial, true));
  const client = new ClientDirector(false) as any;
  client.engine = { stopPlayback() {}, stopThunder() {}, setRainLevel() {}, async dispose() {} };
  client.transport = { send() {}, close() {} };
  client.started = true;
  let ready = false;
  const reset = client.reset().then(() => {
    ready = true;
  });
  await Promise.resolve();
  assert.equal(ready, false, 'reset must not complete before session acknowledgement');
  client.onMessage({ type: 'session', session_id: 'replacement', resumed: false });
  await reset;
  assert.equal(ready, true);
  const failed = client.reset();
  client.onMessage({ type: 'error', code: 'duplex_connect', message: 'connection failed' });
  await assert.rejects(failed, /connection failed/);
  assert.equal(client.started, false, 'failure must permit another start');
});
