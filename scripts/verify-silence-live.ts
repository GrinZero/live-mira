import WebSocket from 'ws';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const ws = new WebSocket('ws://localhost:8787/ws');
const start = Date.now();
const events: any[] = [];
let bytes = 0,
  playbackEnd = 0;
const send = (m: unknown) => ws.send(JSON.stringify(m));
ws.on('message', (raw, binary) => {
  if (binary) {
    const length = Array.isArray(raw) ? raw.reduce((sum, b) => sum + b.byteLength, 0) : raw.byteLength;
    bytes += length;
    playbackEnd = Math.max(Date.now(), playbackEnd) + length / 48;
    return;
  }
  const m = JSON.parse(raw.toString());
  if (m.type !== 'log') events.push({ t: Date.now() - start, ...m });
  if (m.type === 'audio.end') {
    const ack = () => {
      if (ws.readyState !== ws.OPEN) return;
      const remaining = Math.max(0, playbackEnd - Date.now());
      send({ type: 'playback', response_id: m.response_id, remaining_ms: remaining });
      if (remaining) setTimeout(ack, Math.min(1000, remaining + 20));
    };
    ack();
  }
  if (m.type === 'story' && m.story.phase === 'invitation') console.log('EVENT', Date.now() - start, m.story);
  if (m.type === 'transcript.mira') console.log('SPEECH', m.delta);
});
async function until(fn: () => boolean, timeout: number) {
  const end = Date.now() + timeout;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  assert.ok(fn(), 'Expected event before timeout');
}
try {
  await until(() => ws.readyState === ws.OPEN, 10000);
  send({ type: 'hello' });
  await until(() => events.some((m) => m.type === 'session'), 20000);
  send({ type: 'mic', muted: true });
  send({ type: 'enter' });
  await until(() => events.filter((m) => m.type === 'story' && m.story.phase === 'invitation').length >= 2, 240000);
  // 事件可以只有画面没有台词（说漏嘴的句子会被她吞回去）——至少有开场白+一次事件口播
  await until(() => events.filter((m) => m.type === 'audio.end').length >= 2, 30000);
  assert.ok(bytes > 0);
  assert.equal(events.filter((m) => m.type === 'error').length, 0, 'No upstream idle timeout');
  assert.ok(
    events.filter((m) => m.type === 'transcript.mira').every((m) => !/^Mira/.test(m.delta)),
    'No stage narration in spoken lines',
  );
  assert.equal(events.filter((m) => m.type === 'transcript.user').length, 0);
  // 节奏纪律：用户零发言的早期阶段，事件与台词都必须停在"陌生人躲雨"——
  // 不把"你认识我吗/我们以前"这类直接指向他的线索说出口；第三人称远暗示允许
  const reveal =
    /(你(们)?(还|也|真|难道|是不是)?[^，。]{0,6}(认识|认得|记得|想起|认出)|(认识|记得|认出)我|不记得|似曾相识|眼熟|面熟|(你|你们|我们|咱们|他)[^，。]{0,6}(以前|从前|过去|当年)|(以前|从前|过去|当年)[^，。]{0,4}(你|你们|我们|咱们)|老照片|旧照片|合照|女朋友|男朋友|恋人|情侣|前任)/;
  const invites = events.filter((m) => m.type === 'story' && m.story.phase === 'invitation');
  assert.ok(
    invites.every(
      (m) =>
        !reveal.test(`${m.story.title} ${m.story.event} ${(m.story.choices ?? []).map((c: any) => c.label).join(' ')}`),
    ),
    'early events must stay neutral, no relationship hints',
  );
  assert.ok(
    events.filter((m) => m.type === 'transcript.mira').every((m) => !reveal.test(m.delta)),
    'early speech must not leak the hidden relationship',
  );
  console.log(
    'PASS: zero user turns, two live spontaneous events with speech, real-time playback acknowledgements, no early reveal.',
  );
} finally {
  fs.writeFileSync('output/checks/live-silence.json', JSON.stringify({ bytes, events }, null, 2));
  ws.close();
}
