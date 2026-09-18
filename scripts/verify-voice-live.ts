import WebSocket from 'ws';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { InjectTts } from '../server/src/inject-tts.js';
import type { DownMessage } from '../shared/protocol.js';
const tts = new InjectTts();
const first = await tts.synthesize('你好，我叫小川，今天刚面试完。你叫什么名字？');
const second = await tts.synthesize('先不说这个了，我现在只想坐下来歇一会儿。');
await tts.close();
const events: DownMessage[] = [];
let audioBytes = 0;
const ws = new WebSocket('ws://localhost:8787/ws');
ws.on('message', (raw, binary) => {
  if (binary) {
    audioBytes += Array.isArray(raw) ? raw.reduce((n, b) => n + b.byteLength, 0) : raw.byteLength;
    return;
  }
  const event = JSON.parse(raw.toString()) as DownMessage;
  if (event.type !== 'log') {
    events.push(event);
    if (event.type === 'transcript.user' || event.type === 'transcript.mira') console.log(JSON.stringify(event));
  }
});
const send = (m: unknown) => ws.send(JSON.stringify(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(predicate: () => boolean, label: string) {
  const end = Date.now() + 25000;
  while (!predicate() && Date.now() < end) await sleep(50);
  assert.ok(predicate(), label);
}
async function stream(pcm: Buffer) {
  for (let i = 0; i < pcm.length; i += 640) {
    ws.send(pcm.subarray(i, i + 640));
    await sleep(20);
  }
}
try {
  await until(() => ws.readyState === WebSocket.OPEN, 'websocket open');
  send({ type: 'hello' });
  await until(() => events.some((e) => e.type === 'session'), 'session');
  send({ type: 'mic', muted: false });
  await stream(first);
  await until(() => events.some((e) => e.type === 'audio.end'), 'first voice reply');
  const end = events.find((e) => e.type === 'audio.end') as Extract<DownMessage, { type: 'audio.end' }>;
  send({ type: 'playback', response_id: end.response_id, remaining_ms: 8000 });
  send({ type: 'interrupt' });
  await until(() => events.some((e) => e.type === 'interrupted'), 'interrupt during remaining playback');
  const start = events.length;
  await stream(second);
  await until(
    () => events.slice(start).some((e) => e.type === 'audio.end' && !e.interrupted),
    'voice reply after interruption',
  );
  const users = events.filter((e) => e.type === 'transcript.user' && e.final);
  assert.ok(users.length >= 2, 'both user utterances transcribed');
  assert.ok(audioBytes > 0);
  fs.writeFileSync(
    'output/checks/live-voice.json',
    JSON.stringify({ syntheticInput: true, audioBytes, events }, null, 2),
  );
  console.log(
    'PASS: native voice, both ASR turns, interruption while playback remains, and recovery. Synthetic audio; not a physical microphone test.',
  );
} finally {
  ws.close();
}
