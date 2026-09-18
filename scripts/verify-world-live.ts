import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Director, type DirectorHooks } from '../server/src/director.js';
import { arkChat } from '../server/src/ark.js';
import { loadContent } from '../server/src/content.js';

const result: unknown[] = [];
for (const topic of [
  '我想坐火车去海边，喜欢那种半夜还开着灯的小站。',
  '小时候我很喜欢听收音机里的故事，尤其是讲到一半没了结尾的。',
]) {
  const media: unknown[] = [],
    lines: string[] = [];
  const hooks: DirectorHooks = {
    injectNarration: () => {},
    speak: (t) => lines.push(t),
    sendDirective: () => {},
    genimg: (...args) => media.push(args),
    injectTurnPair: () => {},
    narrateToClient: () => {},
    story: () => {},
    available: () => true,
  };
  const d = new Director(loadContent(), hooks, async (opts) => {
    const raw = await arkChat(opts);
    console.log('RAW', raw);
    return raw;
  });
  await d.handleTextTurn('你好，我想在这里坐一会儿。');
  await d.handleTextTurn(topic);
  d.played();
  Object.assign(d, {
    startedAt: Date.now() - 120000,
    lastSpeechEnd: Date.now() - 35000,
    lastUserAt: Date.now() - 35000,
  });
  const decision = await d.evaluate('tick');
  await d.apply(decision);
  const offered = d.story.view();
  await d.handleTextTurn('我们现在一起推门出去，顺着街道走到桥边看看吧。');
  const moved = d.story.context();
  assert.ok(
    media.some((m) => (m as any[])[0] === 'scene'),
    'Explicit departure must produce scene request',
  );
  const row = { topic, decision, offered, freeAction: moved, lines, media };
  result.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync('output/checks/live-world.json', JSON.stringify(result, null, 2));
console.log(
  'PASS: real model world decisions and arbitrary user action; media requests captured, generation tested separately.',
);
