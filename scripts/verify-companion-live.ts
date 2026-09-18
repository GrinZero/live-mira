import WebSocket from 'ws';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import type { DownMessage } from '../shared/protocol.js';

const prompts = [
  '我叫小琳，今天刚结束面试，有点累。',
  '你刚才记住我叫什么了吗？',
  '更正一下，我其实叫小岚，不叫小琳。',
  '那你现在叫我什么？我今天做了什么？',
  '你为什么一个人在这里？',
  '我问的是你来这里的原因，不是窗外的风景。',
  '先别说话了，陪我安静听一会儿雨吧。',
];
const ws = new WebSocket('ws://localhost:8787/ws');
const evidence: { user: string; reply: string; audioBytes: number; latencyMs: number }[] = [];
let current = -1,
  text = '',
  audioBytes = 0,
  started = 0,
  waiting = false;
let timeout: ReturnType<typeof setTimeout>;
function send(m: unknown) {
  ws.send(JSON.stringify(m));
}
function next() {
  if (++current >= prompts.length) {
    finish();
    return;
  }
  text = '';
  audioBytes = 0;
  started = Date.now();
  waiting = true;
  send({ type: 'text', text: prompts[current] });
  clearTimeout(timeout);
  timeout = setTimeout(() => fail(new Error('reply timeout')), 35000);
}
function fail(e: Error) {
  console.error(e.message);
  ws.close();
  process.exitCode = 1;
  clearTimeout(timeout);
}
function finish() {
  clearTimeout(timeout);
  fs.mkdirSync('output/checks', { recursive: true });
  fs.writeFileSync('output/checks/live-conversation.json', JSON.stringify(evidence, null, 2));
  try {
    assert.match(evidence[1].reply, /小琳/);
    assert.match(evidence[3].reply, /小岚/);
    assert.match(evidence[3].reply, /面试/);
    assert.ok(evidence.every((e) => e.audioBytes > 0));
    console.log('PASS: live name recall, correction, previous activity, and spoken audio for every text turn.');
  } catch (e) {
    process.exitCode = 1;
    console.error(e);
  }
  ws.close();
}
ws.on('open', () => send({ type: 'hello' }));
ws.on('error', fail);
ws.on('message', (raw, binary) => {
  if (binary) {
    audioBytes += Array.isArray(raw) ? raw.reduce((n, b) => n + b.byteLength, 0) : raw.byteLength;
    return;
  }
  const m = JSON.parse(raw.toString()) as DownMessage;
  if (m.type === 'session' && current === -1) {
    send({ type: 'mic', muted: true });
    next();
  }
  if (m.type === 'transcript.mira') text += m.delta;
  if (m.type === 'error') console.error('SERVICE', m.message);
  if (m.type === 'audio.end' && !m.interrupted && waiting) {
    waiting = false;
    send({ type: 'playback', response_id: m.response_id, remaining_ms: 0 });
    const row = { user: prompts[current], reply: text, audioBytes, latencyMs: Date.now() - started };
    evidence.push(row);
    console.log(JSON.stringify(row));
    setTimeout(next, 300);
  }
});
