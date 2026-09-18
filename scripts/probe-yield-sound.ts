import WebSocket from 'ws';
import { InjectTts } from '../server/src/inject-tts.js';

// 复现"cadence → yield 时的怪声"（走真实服务端）：
// 喂 TTS 用户话音 → 她回答 → 导演 yield；记录 audio.end 之后到达的所有二进制帧。
// 若上游在 output_audio.done 之后还吐 delta（响应未关窗的尾音），这里会抓到。
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2);
const userLines = ['你是谁？', '你为什么会认识我？', '为什么我没有印象呢？'];

const tts = new InjectTts();
const lines: Buffer[] = [];
for (const l of userLines) lines.push(await tts.synthesize(l));
await tts.close();

const ws = new WebSocket('ws://localhost:8787/ws');
ws.binaryType = 'nodebuffer';
const send = (m: unknown) => ws.send(JSON.stringify(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let curRid = '';
let ended = false; // 当前 rid 是否已 audio.end
const orphanFrames: { t: number; n: number }[] = [];
const audioByRid = new Map<string, { start: number; end: number; frames: { t: number; n: number }[] }>();
const startPlayAt = new Map<string, number>();

function reportPlayback(rid: string) {
  const info = audioByRid.get(rid);
  const totalMs = (info?.frames.reduce((a, f) => a + f.n, 0) ?? 0) / 48;
  const rem = Math.max(0, (startPlayAt.get(rid) ?? Date.now()) + totalMs - Date.now());
  send({ type: 'playback', response_id: rid, remaining_ms: rem < 50 ? 0 : Math.round(rem) });
  if (rem >= 50) setTimeout(() => reportPlayback(rid), Math.min(rem + 30, 1000));
}

ws.on('message', (raw: Buffer, isBinary: boolean) => {
  const now = Date.now() - t0;
  if (isBinary) {
    const rec = audioByRid.get(curRid);
    if (rec) rec.frames.push({ t: now, n: raw.length });
    if (ended || !rec) orphanFrames.push({ t: now, n: raw.length });
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
    if (['director'].includes(e.cat) || (e.cat === 'session' && /held|dropped|interrupt|error/.test(e.msg)))
      console.log(`[${ts()}] log:${e.cat} ${e.msg}`);
    return;
  }
  if (t === 'audio.begin') {
    curRid = String(m.response_id);
    ended = false;
    startPlayAt.set(curRid, Date.now());
    audioByRid.set(curRid, { start: now, end: 0, frames: [] });
    console.log(`[${ts()}] audio.begin ${curRid}`);
    return;
  }
  if (t === 'audio.end') {
    ended = true;
    const rec = audioByRid.get(String(m.response_id));
    if (rec) rec.end = now;
    console.log(`[${ts()}] audio.end ${m.response_id}${m.interrupted ? ' INT' : ''}`);
    if (!m.interrupted) reportPlayback(String(m.response_id));
    return;
  }
  if (t === 'transcript.mira' && typeof m.delta === 'string' && !audioByRid.has(curRid)) return;
  if (t === 'transcript.user' && m.final) console.log(`[${ts()}] user FINAL: ${m.text}`);
  if (t === 'interrupted') console.log(`[${ts()}] interrupted`);
});

await new Promise<void>((res, rej) => {
  ws.once('open', () => res());
  ws.once('error', rej);
});
send({ type: 'hello' });
await sleep(400);
send({ type: 'mic', muted: false });
send({ type: 'enter' });
// 等开场白
await new Promise<void>((res) => {
  const c = () => {
    if (audioByRid.size) res();
    else setTimeout(c, 200);
  };
  c();
  setTimeout(res, 12000);
});
await sleep(3500);

for (let li = 0; li < lines.length; li++) {
  const pcm = lines[li];
  console.log(`[${ts()}] >>> stream user: ${userLines[li]}`);
  for (let i = 0; i < pcm.length; i += 640) {
    ws.send(pcm.subarray(i, i + 640));
    await sleep(20);
  }
  // 等这一轮的 audio.end
  const ridBefore = curRid;
  const deadline = Date.now() + 25000;
  await new Promise<void>((res) => {
    const c = () => {
      const rec = audioByRid.get(curRid);
      if ((curRid !== ridBefore && rec?.end) || Date.now() > deadline) res();
      else setTimeout(c, 150);
    };
    c();
  });
  // yield 窗口：response.done 前继续保持静音输入
  const silence = Buffer.alloc(640);
  for (let k = 0; k < 350; k++) {
    ws.send(silence);
    await sleep(20);
  } // ~7s
}

await sleep(8000);

console.log('\n===== per-response frame timeline =====');
for (const [rid, rec] of audioByRid) {
  const total = rec.frames.reduce((a, f) => a + f.n, 0);
  const postEnd = rec.frames.filter((f) => rec.end && f.t > rec.end + 50);
  console.log(
    `${rid} start=${rec.start.toFixed(0)} end=${rec.end.toFixed(0)} frames=${rec.frames.length} ${Math.round(total / 48)}ms` +
      (postEnd.length
        ? `  *** ${postEnd.length} frames / ${Math.round(postEnd.reduce((a, f) => a + f.n, 0) / 48)}ms AFTER audio.end ***`
        : ''),
  );
}
console.log('\norphan frames (no active rid / after end):', JSON.stringify(orphanFrames));
ws.close();
process.exit(0);
