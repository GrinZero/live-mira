import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Director, type DirectorHooks } from '../server/src/director.js';
import { loadContent } from '../server/src/content.js';
import { arkChat } from '../server/src/ark.js';

const cases = [
  { user: '你可以叫我 Bug。', reply: 'Bug？挺特别的名字。', mode: 'continue' },
  { user: '你可以叫我 Bug。', reply: 'Bug？这个名字是怎么来的？', mode: 'yield' },
  { user: '今天有点累，先让我缓一缓。', reply: '好，慢慢来。', mode: 'quiet' },
  { user: '我们以前认识吗？', reply: '嗯，认识。', mode: 'yield' },
];
const evidence: unknown[] = [];
for (const c of cases) {
  const spoken: string[] = [];
  let plan: any;
  const hooks: DirectorHooks = {
    injectNarration() {},
    speak: (t) => spoken.push(t),
    sendDirective() {},
    genimg() {},
    injectTurnPair() {},
    narrateToClient() {},
    story() {},
    available: () => true,
  };
  const d = new Director(loadContent(), hooks, async (opts) => {
    const raw = await arkChat(opts);
    plan = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return raw;
  });
  d.noteUser(c.user);
  d.noteMira(c.reply);
  await d.prepareContinuation();
  d.played();
  await new Promise((r) => setTimeout(r, 2500));
  d.advanceConversation();
  evidence.push({ ...c, plan, spoken });
  console.log(JSON.stringify({ ...c, plan, spoken }));
  if (c.mode === 'continue') assert.equal(plan?.mode, c.mode);
  assert.equal(spoken.length, c.mode === 'continue' ? 1 : 0);
}
for (const user of ['当然可以，随便坐。', '可以坐，你可以叫我 Bug。', '你可以叫我 Bug。']) {
  const spoken: string[] = [];
  const d = new Director(loadContent(), {
    injectNarration() {},
    speak: (t) => spoken.push(t),
    sendDirective() {},
    genimg() {},
    injectTurnPair() {},
    narrateToClient() {},
    story() {},
    available: () => true,
  });
  d.noteMira('这个位置……我可以坐吗？外面雨太大了。');
  await d.handleTextTurn(user);
  evidence.push({ user, openingRoleCheck: true, spoken });
  console.log(JSON.stringify({ user, openingRoleCheck: true, spoken }));
  assert.equal(spoken.length, 1);
  assert.doesNotMatch(spoken[0], /随便坐|你坐吧|你请坐|当然可以|你也来躲雨/);
}
fs.mkdirSync('output/checks', { recursive: true });
fs.writeFileSync('output/checks/live-cadence.json', JSON.stringify(evidence, null, 2));
console.log('PASS: real model continuation, yielding, emotional quiet, and relationship boundary.');
