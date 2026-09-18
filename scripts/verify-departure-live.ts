import WebSocket from 'ws';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const ws = new WebSocket('ws://localhost:8787/ws');
const events: any[] = [];
const send = (m: unknown) => ws.send(JSON.stringify(m));
ws.on('message', (raw, binary) => {
  if (binary) return;
  const m = JSON.parse(raw.toString());
  if (m.type !== 'log') events.push(m);
  if (m.type === 'audio.end') send({ type: 'playback', response_id: m.response_id, remaining_ms: 0 });
  if (m.type === 'media.event' && m.event.kind === 'scene') console.log('SCENE', m.event);
  if (m.type === 'transcript.mira') console.log('MIRA', m.delta);
});
async function until(fn: () => boolean, timeout = 25000) {
  const end = Date.now() + timeout;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fn(), 'timeout');
}
async function turn(text: string) {
  const start = events.length;
  send({ type: 'text', text });
  await until(
    () =>
      events.slice(start).some((m) => m.type === 'transcript.mira') &&
      events.slice(start).some((m) => m.type === 'audio.end' && !m.interrupted),
  );
  return events.slice(start);
}
try {
  await until(() => ws.readyState === ws.OPEN);
  send({ type: 'hello' });
  await until(() => events.some((m) => m.type === 'session'));
  send({ type: 'mic', muted: true });
  for (const text of ['拍的很好呀。', '我要走了', '要跟我一起走吗？']) {
    const result = await turn(text);
    assert.equal(result.filter((m) => m.type === 'media.event' && m.event.kind === 'scene').length, 0, text);
    if (text === '我要走了')
      assert.ok(result.some((m) => m.type === 'story' && m.story.phase === 'farewell' && !m.story.consequence));
  }
  const start = events.length;
  await turn('我们现在一起推门出去，沿着街道走到桥边看看吧。');
  await until(
    () =>
      events
        .slice(start)
        .some((m) => m.type === 'media.event' && m.event.kind === 'scene' && m.event.status === 'ready'),
    120000,
  );
  const scene = events
    .slice(start)
    .find((m) => m.type === 'media.event' && m.event.kind === 'scene' && m.event.status === 'ready').event;
  send({ type: 'scene.presented', id: scene.id, ok: true });
  await until(() => events.at(-1)?.type === 'story' && events.at(-1).story.title === '');
  console.log(
    'PASS: praise/goodbye/invitation stay; agreed departure produces scene; presented scene clears pending card.',
  );
} finally {
  fs.writeFileSync('output/checks/departure-live.json', JSON.stringify(events, null, 2));
  ws.close();
}
