import assert from 'node:assert/strict';
import { config } from '../server/src/config.js';
import { jevDecide, pick } from '../server/src/decisions.js';
import { Director } from '../server/src/director.js';
import { loadContent } from '../server/src/content.js';
import type { StageDirective } from '../shared/protocol.js';

assert.ok(config.typesafeApiKey, 'TYPESAFE_API_KEY required');
const cases = [
  { text: '先别说话，陪我看会儿雨。', expected: 'quiet' },
  { text: '这里真安静，你平时也常来吗？', expected: 'question' },
  { text: '那我们现在出去走走吧。', expected: 'action' },
  { text: '我今天路过桥边，想起小时候放学的路。', expected: 'sharing' },
];
for (const c of cases) {
  const start = Date.now();
  const answers = await jevDecide('reaction', {
    latest_user: c.text,
    quiet_preference: false,
    scene: '雨夜咖啡馆，窗边的桌子',
    recent_turns: [],
  });
  console.log(JSON.stringify({ text: c.text, ms: Date.now() - start, answers }));
  assert.equal(pick(answers, 'intent', 'unknown'), c.expected);
}
for (const line of ['这个名字是怎么来的？', '好，我陪你安静坐一会儿。']) {
  const answers = await jevDecide('cadence', {
    just_spoken: line,
    quiet_preference: line.includes('安静'),
    recent_turns: [],
    phase: 'together',
  });
  console.log(JSON.stringify({ line, answers }));
  assert.notEqual(pick(answers, 'cadence', 'yield', 0.85), 'continue');
}

// Real API -> Director -> existing directive hooks. No simulated model answers.
const directives: StageDirective[] = [];
let pending: Promise<unknown> | undefined;
const director = new Director(
  loadContent(),
  {
    injectNarration() {},
    speak() {
      throw new Error('unexpected speech');
    },
    sendDirective: (d) => directives.push(d),
    genimg() {},
    injectTurnPair() {},
    narrateToClient() {},
    story() {},
    available: () => true,
  },
  undefined,
  (...args) => {
    const request = jevDecide(...args);
    pending = request;
    return request;
  },
);
director.noteUser('先别说话，陪我看会儿雨。');
await pending;
assert.equal(director.story.quiet, true);
assert.equal(directives.at(-1)?.gesture?.gaze, 'window');
director.noteMira('好。');
director.noteUser('你平时喜欢做什么？');
await pending;
assert.equal(director.story.quiet, false);
console.log('PASS real Jev -> Director: quiet, window directive, explicit question resumes conversation.');
