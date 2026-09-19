import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Director, type DirectorHooks } from '../server/src/director.js';
import { loadContent } from '../server/src/content.js';
import { parseAnswers, type Decide, type DecisionAnswers } from '../server/src/decisions.js';
import type { StageDirective } from '../shared/protocol.js';

const answer = (choice: string, confidence = 1) => ({ choice, confidence });
function harness(decide: Decide, chat = async () => '{"mode":"continue","speech":"我也喜欢给照片起名字。"}') {
  const spoken: string[] = [],
    directives: StageDirective[] = [];
  let available = true;
  const hooks: DirectorHooks = {
    injectNarration: () => {},
    speak: (t) => spoken.push(t),
    sendDirective: (d) => directives.push(d),
    genimg: () => {},
    injectTurnPair: () => {},
    narrateToClient: () => {},
    story: () => {},
    available: () => available,
  };
  const d = new Director(loadContent(), hooks, chat, decide);
  return {
    d,
    spoken,
    directives,
    busy: (value: boolean) => {
      available = !value;
    },
  };
}
const settle = () => new Promise<void>((r) => setImmediate(r));

test('invalid API answers fail closed', () => {
  for (const a of [
    null,
    { type: 'choice', choice: 'travel', confidence: 1 },
    { type: 'choice', choice: 'quiet', confidence: NaN },
    { type: 'choice', choice: 'quiet', confidence: 2 },
  ]) {
    assert.throws(() => parseAnswers({ answers: { intent: a } }, ['intent']));
  }
});
test('semantic quiet persists across acknowledgements and resumes on a question', async () => {
  let quiet = 'enter';
  const { d } = harness(async () => ({ quiet: answer(quiet) }));
  d.noteUser('让我放空一会儿');
  await settle();
  assert.equal(d.story.quiet, true);
  d.noteMira('好。');
  quiet = 'keep';
  d.noteUser('谢谢');
  await settle();
  assert.equal(d.story.quiet, true);
  d.noteMira('嗯。');
  quiet = 'resume';
  d.noteUser('你平时喜欢做什么？');
  await settle();
  assert.equal(d.story.quiet, false);
});
test('late reaction cannot change quiet state or move the actor after user activity', async () => {
  let resolve!: (a: DecisionAnswers) => void;
  const { d, directives } = harness(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  d.noteUser('看看窗外');
  d.noteUserActivity();
  resolve({ quiet: answer('enter'), reaction: answer('window') });
  await settle();
  assert.equal(d.story.quiet, false);
  assert.equal(directives.length, 0);
});
test('independent answers cannot override explicit quiet; a clear question can resume it', async () => {
  const { d } = harness(async () => ({ intent: answer('question'), quiet: answer('resume', 0.84) }));
  d.noteUser('别说话，陪我听雨');
  await settle();
  assert.equal(d.story.quiet, true);
  d.noteMira('好。');
  d.noteUser('你喜欢什么音乐？');
  await settle();
  assert.equal(d.story.quiet, false);
});
test('reaction waits for availability and respects explicit motion ownership', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 20000 });
  const { d, directives, busy } = harness(async () => ({ reaction: answer('window') }));
  busy(true);
  d.noteUser('陪我看窗外');
  await settle();
  assert.equal(directives.length, 0);
  d.noteStageDirective({ motion: { action: 'turn', duration_ms: 3000 } });
  busy(false);
  d.advanceReaction();
  assert.equal(directives.length, 0);
  t.mock.timers.tick(3001);
  d.advanceReaction();
  assert.equal(directives[0]?.gesture?.gaze, 'window');
  d.advanceReaction();
  assert.equal(directives.length, 1);
});
test('low confidence, yield, quiet and API failure never request continuation text', async () => {
  for (const mode of ['low', 'yield', 'quiet', 'failure']) {
    let calls = 0;
    const { d, spoken } = harness(
      async (stage) => {
        if (stage === 'reaction') return {};
        if (mode === 'failure') throw new Error('offline');
        return { cadence: answer(mode === 'low' ? 'continue' : mode, mode === 'low' ? 0.3 : 1) };
      },
      async () => {
        calls++;
        return '{}';
      },
    );
    d.noteUser('今天路过桥边');
    d.noteMira('桥边的风很舒服。');
    await d.prepareContinuation();
    d.played();
    d.advanceConversation();
    assert.equal(calls, 0);
    assert.equal(spoken.length, 0);
  }
});
test('approved continuation still needs playback completion and is cancelled by typing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 20000 });
  const { d, spoken } = harness(async (stage) => (stage === 'cadence' ? { cadence: answer('continue') } : {}));
  d.noteUser('你可以叫我Bug');
  d.noteMira('挺特别的名字。');
  await d.prepareContinuation();
  t.mock.timers.tick(2000);
  d.advanceConversation();
  assert.equal(spoken.length, 0);
  d.played();
  t.mock.timers.tick(1200);
  d.advanceConversation();
  assert.equal(spoken.length, 1);
  d.noteUser('那是我的网名');
  d.noteMira('原来如此。');
  await d.prepareContinuation();
  d.played();
  d.noteUserActivity();
  t.mock.timers.tick(2000);
  d.advanceConversation();
  assert.equal(spoken.length, 1);
});
