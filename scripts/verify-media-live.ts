import WebSocket from 'ws';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import type { DownMessage, MediaEvent } from '../shared/protocol.js';
const ws = new WebSocket('ws://localhost:8787/ws');
const events: DownMessage[] = [];
const media: MediaEvent[] = [];
ws.on('message', (raw, binary) => {
  if (binary) return;
  const m = JSON.parse(raw.toString()) as DownMessage;
  if (m.type !== 'log') events.push(m);
  if (m.type === 'media.event') {
    media.push(m.event);
    console.log(JSON.stringify(m.event));
  }
  if (m.type === 'audio.end')
    ws.send(JSON.stringify({ type: 'playback', response_id: m.response_id, remaining_ms: 0 }));
  if (m.type === 'transcript.mira') console.log(m.delta);
});
const send = (m: unknown) => ws.send(JSON.stringify(m));
async function until(fn: () => boolean, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fn(), 'Expected event before timeout');
}
try {
  await until(() => ws.readyState === WebSocket.OPEN);
  send({ type: 'hello' });
  await until(() => events.some((m) => m.type === 'session'));
  send({ type: 'mic', muted: true });
  send({ type: 'text', text: '给我看看你在海边拍的照片吧。' });
  await until(() => media.some((m) => m.kind === 'photo' && m.status !== 'generating'), 160000);
  send({ type: 'text', text: '我们现在一起推门出去，沿着街道走到桥边看看吧。' });
  await until(() => media.some((m) => m.kind === 'scene' && m.status !== 'generating'), 160000);
  fs.writeFileSync('output/checks/live-media.json', JSON.stringify({ media, events }, null, 2));
  assert.ok(
    media.some((m) => m.kind === 'photo' && m.status === 'ready'),
    'Photo ready',
  );
  assert.ok(
    media.some((m) => m.kind === 'scene' && m.status === 'ready'),
    'Scene ready',
  );
  console.log('PASS: real text -> photo generation and explicit departure -> generated scene.');
} finally {
  ws.close();
}
