import WebSocket from 'ws';
import fs from 'node:fs';
import { InjectTts } from '../server/src/inject-tts.js';

// 复现"怪声"假设：Mira 说完后，把她自己的回答音频当麦克风输入喂回去（模拟外放回声），
// 观察上游是否因此产生一段无字幕的怪声响应。
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1);
const audioByRid = new Map<string, Buffer[]>();
let curRid = '';
const mark = (kind: string, info = '') => console.log(`[${ts()}] ${kind} ${info}`);

function resampleTo16k(pcm24: Buffer): Buffer {
  const n = Math.floor(pcm24.length / 2);
  const outN = Math.floor(n / 1.5);
  const out = Buffer.alloc(outN * 2);
  for (let k = 0; k < outN; k++) {
    const s = k * 1.5,
      i0 = Math.floor(s),
      f = s - i0;
    const a = pcm24.readInt16LE(i0 * 2);
    const b = i0 + 1 < n ? pcm24.readInt16LE((i0 + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * f), k * 2);
  }
  return out;
}

const tts = new InjectTts();
const userPcm = await tts.synthesize('你可以叫我 Bug。');
await tts.close();

const ws = new WebSocket('ws://localhost:8787/ws');
ws.binaryType = 'nodebuffer';
const send = (m: unknown) => ws.send(JSON.stringify(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startPlayAt = new Map<string, number>();

function reportPlayback(rid: string) {
  const pcm = Buffer.concat(audioByRid.get(rid) ?? []);
  const totalMs = pcm.length / 48;
  const endAt = startPlayAt.get(rid) ?? Date.now();
  const rem = Math.max(0, endAt + totalMs - Date.now());
  send({ type: 'playback', response_id: rid, remaining_ms: rem < 50 ? 0 : Math.round(rem) });
  if (rem >= 50) setTimeout(() => reportPlayback(rid), Math.min(rem + 30, 1000));
}

ws.on('message', (raw: Buffer, isBinary: boolean) => {
  if (isBinary) {
    if (!audioByRid.has(curRid)) audioByRid.set(curRid, []);
    audioByRid.get(curRid)!.push(raw);
    return;
  }
  let m: Record<string, any>;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const t = String(m.type ?? '');
  if (t === 'log') {
    const e = m.entry;
    if (
      e.cat === 'director' ||
      (e.cat === 'session' && !/first-audio/.test(e.msg)) ||
      (e.cat === 'duplex' && /started|done|closed|error|speak|held|dropped|interrupt/.test(e.msg))
    )
      mark(`log:${e.cat}`, e.msg);
    return;
  }
  if (t === 'audio.begin') {
    curRid = String(m.response_id);
    startPlayAt.set(curRid, Date.now());
    mark('audio.begin', curRid);
    return;
  }
  if (t === 'audio.end') {
    mark('audio.end', `${m.response_id}${m.interrupted ? ' interrupted' : ''}`);
    if (!m.interrupted) reportPlayback(String(m.response_id));
    return;
  }
  if (t === 'transcript.mira') return;
  if (t === 'transcript.user')
    mark(t, `${m.final === false ? '(partial)' : 'FINAL'} ${String(m.text ?? '').slice(0, 80)}`);
  else if (t === 'state' || t === 'interrupted' || t === 'error') mark(t, JSON.stringify(m).slice(0, 160));
});

await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve());
  ws.once('error', reject);
});
send({ type: 'hello' });
await sleep(400);
send({ type: 'mic', muted: false });
send({ type: 'enter' });
await new Promise<void>((resolve) => {
  const chk = () => {
    if (audioByRid.size) resolve();
    else setTimeout(chk, 200);
  };
  chk();
  setTimeout(resolve, 12000);
});
await sleep(4000);

mark('stream user audio');
for (let i = 0; i < userPcm.length; i += 640) {
  ws.send(userPcm.subarray(i, i + 640));
  await sleep(20);
}

// 等她回答音频收完（第二个 rid 的 audio.end）
await new Promise<void>((resolve) => {
  const chk = () => {
    if (audioByRid.size >= 2) resolve();
    else setTimeout(chk, 200);
  };
  chk();
  setTimeout(resolve, 20000);
});
await sleep(1500);
const miraAnswer = Buffer.concat([...audioByRid.values()].at(-1)!);
mark('got mira answer pcm', `${Math.round(miraAnswer.length / 48)}ms`);

// 关键动作：把她自己的声音当回声喂回上行（模拟外放被麦克风收进）
const echo = resampleTo16k(miraAnswer);
mark('stream ECHO of her own voice');
for (let i = 0; i < echo.length; i += 640) {
  ws.send(echo.subarray(i, i + 640));
  await sleep(20);
}

// 之后静音 40s 观察
const silence = Buffer.alloc(640);
const pacer = setInterval(() => ws.send(silence), 20);
await sleep(40000);
clearInterval(pacer);

const summary = [...audioByRid.entries()].map(([rid, bufs], i) => ({
  i,
  rid,
  ms: Math.round(Buffer.concat(bufs).length / 48),
  firstAt: Math.round((startPlayAt.get(rid) ?? 0) - t0),
}));
console.log(JSON.stringify(summary, null, 2));
for (const [rid, bufs] of audioByRid) fs.writeFileSync(`output/checks/echo-probe-${rid}.pcm`, Buffer.concat(bufs));
ws.close();
process.exit(0);
