import WebSocket from 'ws';
import { InjectTts } from '../server/src/inject-tts.js';

// 复现"怪声"：她话音刚落（audio.done 已到、response.done 未到、响应仍开着），
// 用户发出一个很短的应声（"嗯"），看上游是否在旧响应里补一段音频 / 或起个新响应。
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2);

const tts = new InjectTts();
const userPcm = await tts.synthesize('你为什么会认识我？');
const backchannel = await tts.synthesize('嗯');
await tts.close();

const ws = new WebSocket('ws://localhost:8787/ws');
ws.binaryType = 'nodebuffer';
const send = (m: unknown) => ws.send(JSON.stringify(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let curRid = '';
let ended = false;
const orphan: { t: number; n: number }[] = [];
const byRid = new Map<string, { start: number; end: number; frames: { t: number; n: number }[] }>();
const startPlayAt = new Map<string, number>();

function reportPlayback(rid: string) {
  const rec = byRid.get(rid);
  const totalMs = (rec?.frames.reduce((a, f) => a + f.n, 0) ?? 0) / 48;
  const rem = Math.max(0, (startPlayAt.get(rid) ?? Date.now()) + totalMs - Date.now());
  send({ type: 'playback', response_id: rid, remaining_ms: rem < 50 ? 0 : Math.round(rem) });
  if (rem >= 50) setTimeout(() => reportPlayback(rid), Math.min(rem + 30, 1000));
}

ws.on('message', (raw: Buffer, isBinary: boolean) => {
  const now = Date.now() - t0;
  if (isBinary) {
    const rec = byRid.get(curRid);
    if (rec) rec.frames.push({ t: now, n: raw.length });
    if (ended || !rec) {
      orphan.push({ t: now, n: raw.length });
      console.log(`[${ts()}] *** ORPHAN AUDIO FRAME ${raw.length}B (curRid=${curRid}, ended=${ended}) ***`);
    }
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
    if (e.cat === 'director' || /held|dropped|interrupt|tool/.test(e.msg))
      console.log(`[${ts()}] log:${e.cat} ${e.msg}`);
    return;
  }
  if (t === 'audio.begin') {
    curRid = String(m.response_id);
    ended = false;
    startPlayAt.set(curRid, Date.now());
    byRid.set(curRid, { start: now, end: 0, frames: [] });
    console.log(`[${ts()}] audio.begin ${curRid}`);
    return;
  }
  if (t === 'audio.end') {
    ended = true;
    const r = byRid.get(String(m.response_id));
    if (r) r.end = now;
    console.log(`[${ts()}] audio.end ${m.response_id}${m.interrupted ? ' INT' : ''}`);
    if (!m.interrupted) reportPlayback(String(m.response_id));
    return;
  }
  if (t === 'transcript.user') console.log(`[${ts()}] user ${m.final ? 'FINAL' : 'partial'}: ${m.text}`);
  if (t === 'transcript.mira') process.stdout.write(`\x1b[2m${m.delta}\x1b[0m`);
  if (t === 'interrupted') console.log(`\n[${ts()}] interrupted`);
});

await new Promise<void>((res, rej) => {
  ws.once('open', () => res());
  ws.once('error', rej);
});
send({ type: 'hello' });
await sleep(400);
send({ type: 'mic', muted: false });
send({ type: 'enter' });
await new Promise<void>((res) => {
  const c = () => {
    if (byRid.size) res();
    else setTimeout(c, 200);
  };
  c();
  setTimeout(res, 12000);
});
await sleep(3000);

console.log(`\n[${ts()}] >>> user: 你为什么会认识我？`);
for (let i = 0; i < userPcm.length; i += 640) {
  ws.send(userPcm.subarray(i, i + 640));
  await sleep(20);
}

// 等回答的 audio.end
const deadline = Date.now() + 30000;
await new Promise<void>((res) => {
  const c = () => {
    if (byRid.size >= 2 && [...byRid.values()].at(-1)!.end) res();
    else if (Date.now() > deadline) res();
    else setTimeout(c, 100);
  };
  c();
});

// 她话音刚落 0.6s：用户"嗯"一声（response 多半还开着）
await sleep(600);
console.log(`\n[${ts()}] >>> backchannel: 嗯 (while response may still be open)`);
for (let i = 0; i < backchannel.length; i += 640) {
  ws.send(backchannel.subarray(i, i + 640));
  await sleep(20);
}

// 静音流保持
const silence = Buffer.alloc(640);
for (let k = 0; k < 1500; k++) {
  ws.send(silence);
  await sleep(20);
}

console.log('\n===== summary =====');
for (const [rid, rec] of byRid) {
  const total = rec.frames.reduce((a, f) => a + f.n, 0);
  const postEnd = rec.frames.filter((f) => rec.end && f.t > rec.end + 50);
  console.log(
    `${rid} ${Math.round(total / 48)}ms frames=${rec.frames.length}` +
      (postEnd.length ? ` *** ${postEnd.length} post-end frames ***` : ''),
  );
}
console.log('orphan frames:', orphan.length, JSON.stringify(orphan.slice(0, 20)));
ws.close();
process.exit(0);
