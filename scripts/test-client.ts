// E2E 测试客户端：模拟浏览器走完一轮语音对话 + 打断 + 文字回合
// 用法: tsx scripts/test-client.ts [--wav /tmp/probe_q.wav] [--wav2 /tmp/probe_q2.wav] [--text "你在等谁？"] [--nointerrupt]
import fs from 'node:fs';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const has = (k: string) => process.argv.includes(`--${k}`);

const WAV1 = arg('wav', '/tmp/probe_q.wav');
const WAV2 = arg('wav2', '/tmp/probe_q2.wav');
const TEXT = arg('text', '');
const NO_INT = has('nointerrupt');
const SILENCE = Buffer.alloc(640);

function wavPcm(file: string): Buffer {
  const d = fs.readFileSync(file);
  // 找 data chunk
  let off = 12;
  while (off + 8 <= d.length) {
    const id = d.toString('ascii', off, off + 4);
    const sz = d.readUInt32LE(off + 4);
    if (id === 'data') return d.subarray(off + 8, off + 8 + sz);
    off += 8 + sz;
  }
  return d.subarray(44);
}

async function main() {
  const ws = new WebSocket('ws://localhost:8787/ws');
  const st = { speaking: false, audioBytes: 0, firstAudioAt: 0, barged: false, done: false, turns: 0, begins: 0 };

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello' }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'enter' })), 400);
  });

  ws.on('message', async (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      st.audioBytes += raw.length;
      return;
    }
    const m = JSON.parse(raw.toString());
    if (m.type === 'audio.begin') {
      st.speaking = true;
      st.begins = (st.begins ?? 0) + 1;
      if (!st.firstAudioAt) {
        st.firstAudioAt = Date.now();
      }
      // 打断专项：第 N 段语音刚开口 1.2s 就插话
      if (has('interrupton') && !st.barged && st.begins >= Number(arg('interruptat', '2'))) {
        st.barged = true;
        setTimeout(async () => {
          console.log('\n>> 她在说话——打断 + wav2 流入');
          ws.send(JSON.stringify({ type: 'interrupt' }));
          const pcm = wavPcm(WAV2);
          for (let i = 0; i + 640 <= pcm.length; i += 640) {
            ws.send(pcm.subarray(i, i + 640));
            await new Promise((r) => setTimeout(r, 20));
          }
        }, 1200);
      }
    }
    if (m.type === 'audio.end') {
      st.speaking = false;
      st.turns++;
      console.log(`  < audio.end interrupted=${m.interrupted} turns=${st.turns}`);
    }
    if (m.type === 'transcript.mira') process.stdout.write(m.delta);
    if (m.type === 'transcript.user' && m.final) console.log(`\n  < user(final): ${m.text}`);
    if (m.type === 'directive') console.log(`\n  < directive`, m.directive);
    if (m.type === 'media.event')
      console.log(`  < media ${m.event.kind}/${m.event.status} ${m.event.url ?? m.event.reason ?? ''}`);
    if (m.type === 'narration') console.log(`  < narration: ${m.text}`);
    if (m.type === 'interrupted') console.log(`  < interrupted (server ack)`);
    if (m.type === 'state') console.log(`  < state → ${m.phase}`);
    if (m.type === 'error') console.log(`  < ERROR ${m.code}: ${m.message}`);
    if (m.type === 'session') console.log(`  < session ${m.session_id}`);
  });

  // 发送 wav 实时流
  async function stream(file: string) {
    const pcm = wavPcm(file);
    for (let i = 0; i + 640 <= pcm.length; i += 640) {
      ws.send(pcm.subarray(i, i + 640));
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const _mode = arg('mode', 'full');
  // T+3s: 说第一句
  setTimeout(async () => {
    console.log('>> 说话 wav1');
    await stream(WAV1);
    console.log('>> wav1 播完，保持静音');
    (async () => {
      while (true) {
        ws.send(SILENCE);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
  }, 3000);

  // T+16s: 若还在说话 → 打断（wav2）
  if (!NO_INT)
    setTimeout(async () => {
      if (st.speaking) {
        console.log('\n>> 打断：wav2 流入 + interrupt');
        ws.send(JSON.stringify({ type: 'interrupt' }));
        await stream(WAV2);
        console.log('>> wav2 播完');
      } else {
        console.log('\n>> 未在说话，直接说 wav2');
        await stream(WAV2);
      }
    }, 16000);

  if (TEXT)
    setTimeout(() => {
      console.log(`\n>> 文字回合: ${TEXT}`);
      ws.send(JSON.stringify({ type: 'text', text: TEXT }));
    }, 30000);

  setTimeout(
    () => {
      console.log(
        `\n== 结果 audioBytes=${st.audioBytes} turns=${st.turns} firstAudio=${st.firstAudioAt ? 'yes' : 'no'}`,
      );
      ws.close();
      process.exit(0);
    },
    Number(arg('dur', '60000')),
  );
}

main();
