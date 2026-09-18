import WebSocket from 'ws';
import fs from 'node:fs';
import { config } from '../server/src/config.js';
import { loadContent } from '../server/src/content.js';
import { TOOLS } from '../server/src/duplex.js';
import { InjectTts } from '../server/src/inject-tts.js';

// 探针（修正版）：直连上游 duplex，抓两件事——
// A. commit "我们……认识。" 这句台词，看 "……" 是否被渲染成有声的叹气/气声（yield 时怪声嫌疑 1）
// B. 真实用户回合 output_audio.done → response.done 的开窗期里喂非语音声响，
//    看上游是否在窗口内补发 delta（无帧怪声嫌疑 2）
// 旧版 bug：静音节拍器与话音流并发交错，VAD 永远触发不了。已修：说话时暂停节拍器。
const content = loadContent();
const tts = new InjectTts();
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(2);

interface Turn {
  rid: string;
  deltas: { t: number; n: number; afterDone: boolean; afterRespDone: boolean }[];
  doneAt: number;
  respDoneAt: number;
  pcm: Buffer[];
}

async function session(): Promise<{ ws: WebSocket; turns: Turn[]; events: string[] }> {
  const ws = new WebSocket(config.duplexUrl, { headers: { 'X-Api-Key': config.doubaoApiKey } });
  const turns: Turn[] = [];
  const events: string[] = [];
  let cur: Turn | undefined;
  let audioDone = false,
    respDone = false;

  ws.on('message', (raw: Buffer) => {
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    const t = String(e.type ?? '');
    const now = Date.now() - t0;
    if (t === 'response.output_audio.started') {
      cur = { rid: String(e.response_id), deltas: [], doneAt: 0, respDoneAt: 0, pcm: [] };
      turns.push(cur);
      audioDone = false;
      respDone = false;
      events.push(`[${ts()}] audio.started rid=${cur.rid} tts=${e.tts_type}`);
      return;
    }
    if (t === 'response.output_audio.delta') {
      const pcm = Buffer.from(String(e.delta ?? ''), 'base64');
      cur?.deltas.push({ t: now, n: pcm.length, afterDone: audioDone, afterRespDone: respDone });
      cur?.pcm.push(pcm);
      return;
    }
    if (t === 'response.output_audio.done') {
      audioDone = true;
      if (cur) cur.doneAt = now;
      events.push(`[${ts()}] audio.done rid=${e.response_id}`);
      return;
    }
    if (t === 'response.done') {
      respDone = true;
      if (cur) cur.respDoneAt = now;
      events.push(`[${ts()}] response.done`);
      return;
    }
    if (t === 'response.function_call_arguments.done') {
      events.push(`[${ts()}] function_call done → 回执`);
      const items = (Array.isArray(e.items) ? e.items : e.item ? [e.item] : []) as Record<string, unknown>[];
      const results = items.map((it) => ({
        call_id: String(it.call_id ?? it.id ?? ''),
        role: 'tool',
        content: [{ type: 'input_text', text: JSON.stringify({ ok: true }) }],
      }));
      if (results.length) ws.send(JSON.stringify({ type: 'conversation.item.create', items: results }));
      return;
    }
    if (t === 'response.canceled' || t === 'error' || t.includes('transcription')) {
      events.push(`[${ts()}] ${t} ${JSON.stringify({ ...e, delta: undefined }).slice(0, 160)}`);
      return;
    }
    if (t !== 'session.created' && t !== 'session.updated') events.push(`[${ts()}] ${t}`);
  });

  await new Promise<void>((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  ws.send(
    JSON.stringify({
      type: 'session.create',
      session: {
        model: config.duplexModel,
        instructions: content.personaInstructions,
        audio: {
          input: { format: { type: 'pcm', rate: 16000 } },
          output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: config.voice },
        },
        tools: TOOLS,
      },
    }),
  );
  await new Promise((r) => setTimeout(r, 1000));
  ws.send(JSON.stringify({ type: 'input_audio_unmute.commit' }));
  ws.send(
    JSON.stringify({
      type: 'conversation.item.create',
      items: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text: '这个位置……我可以坐吗？外面雨太大了。' }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '当然可以。你可以叫我 Bug。' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_text', text: '谢谢 Bug。我叫 Mira，是个旅行摄影师。' }],
        },
      ],
    }),
  );
  return { ws, turns, events };
}

async function streamFrames(ws: WebSocket, pcm: Buffer) {
  for (let i = 0; i < pcm.length; i += 640) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(i, i + 640).toString('base64') }));
    await new Promise((r) => setTimeout(r, 20));
  }
}

const silence = Buffer.alloc(640);
async function streamSilence(ws: WebSocket, ms: number) {
  for (let t = 0; t < ms; t += 20) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence.toString('base64') }));
    await new Promise((r) => setTimeout(r, 20));
  }
}

function noise(level: number): Buffer {
  const b = Buffer.alloc(640);
  for (let i = 0; i < 320; i++) b.writeInt16LE(Math.round((Math.random() * 2 - 1) * level), i * 2);
  return b;
}
async function streamNoise(ws: WebSocket, ms: number, level: number) {
  for (let t = 0; t < ms; t += 20) {
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: noise(level).toString('base64') }));
    await new Promise((r) => setTimeout(r, 20));
  }
}

function report(turns: Turn[], events: string[], label: string) {
  console.log(`\n===== ${label} =====`);
  for (const e of events) console.log(e);
  for (const turn of turns) {
    const total = turn.deltas.reduce((a, d) => a + d.n, 0);
    const late = turn.deltas.filter((d) => d.afterDone);
    const postResp = turn.deltas.filter((d) => d.afterRespDone);
    console.log(
      `rid=${turn.rid} total=${(total / 48).toFixed(0)}ms deltas=${turn.deltas.length} ` +
        `post-audio.done: ${late.length}d/${(late.reduce((a, d) => a + d.n, 0) / 48).toFixed(0)}ms ` +
        `post-response.done: ${postResp.length}d/${(postResp.reduce((a, d) => a + d.n, 0) / 48).toFixed(0)}ms` +
        (late.length ? `  times: ${late.map((d) => (d.t - turn.doneAt).toFixed(0)).join(',')}ms after done` : ''),
    );
    fs.writeFileSync(`output/checks/tail-${turn.rid}.pcm`, Buffer.concat(turn.pcm));
  }
}

// ===== A: commit 原句，看 "……" 段 =====
{
  const { ws, turns, events } = await session();
  console.log(`[${ts()}] commit: 我们……认识。`);
  ws.send(JSON.stringify({ type: 'speech_text_buffer.commit', text: '我们……认识。' }));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline && !(turns.length && turns[0].respDoneAt)) await new Promise((r) => setTimeout(r, 100));
  await streamSilence(ws, 8000); // done 后还开着，继续灌静音看有没有尾巴
  report(turns, events, 'A: speech_text_buffer.commit 我们……认识。');
  ws.send(JSON.stringify({ type: 'session.close' }));
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
}

// ===== B: 真实用户回合 + 开窗期喂叹气/噪声 =====
{
  const { ws, turns, events } = await session();
  const line = await tts.synthesize('我们以前认识吗？');
  const sigh = await tts.synthesize('唉……');
  console.log(`[${ts()}] stream user: 我们以前认识吗？`);
  await streamFrames(ws, line);
  // 等 audio.done
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(turns.length && turns[turns.length - 1].doneAt))
    await new Promise((r) => setTimeout(r, 100));
  console.log(`[${ts()}] audio.done seen → 开窗期喂"唉……"叹气 + 3s 中噪声`);
  await streamFrames(ws, sigh);
  await streamNoise(ws, 3000, 3000);
  await streamSilence(ws, 12000);
  report(turns, events, 'B: 用户回合 + 开窗期声响');
  ws.send(JSON.stringify({ type: 'session.close' }));
  await new Promise((r) => setTimeout(r, 800));
  ws.close();
}

await tts.close();
process.exit(0);
