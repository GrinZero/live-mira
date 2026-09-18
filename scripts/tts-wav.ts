// 用 Duplex TTS 生成一句中文语音 wav（PCM24k → ffmpeg 转 16k mono）
// 用法: tsx scripts/tts-wav.ts "要说的话" /tmp/out.wav
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const text = process.argv[2];
const out = process.argv[3] ?? '/tmp/tts.wav';
if (!text) {
  console.error('usage: tts-wav.ts <text> <out.wav>');
  process.exit(1);
}

const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', {
  headers: { 'X-Api-Key': process.env.DOUBAO_API_KEY },
});
const chunks: Buffer[] = [];
let gotStarted = false;

const done = () => {
  const pcm = Buffer.concat(chunks);
  const raw = out.replace(/\.wav$/, '.pcm');
  fs.writeFileSync(raw, pcm);
  execSync(`ffmpeg -y -v error -f s16le -ar 24000 -ac 1 -i "${raw}" -ar 16000 -ac 1 "${out}"`);
  console.log(`${out} ${(pcm.length / 48).toFixed(0)}ms audio`);
  ws.close();
  process.exit(0);
};

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      type: 'session.create',
      session: {
        model: process.env.DUPLEX_MODEL || '1.2.6.1',
        instructions: '你是配音演员。只把给你的文字原样读出来，不要加任何别的话。',
        audio: {
          input: { format: { type: 'pcm', rate: 16000 } },
          output: {
            format: { type: 'pcm_s16le', rate: 24000 },
            voice: process.env.MIRA_VOICE || 'zh_female_vv_jupiter_bigtts',
          },
        },
      },
    }),
  );
  setTimeout(() => ws.send(JSON.stringify({ type: 'speech_text_buffer.commit', text })), 800);
  setTimeout(() => {
    console.error('timeout');
    process.exit(1);
  }, 30000);
});

ws.on('message', (raw: Buffer) => {
  let evt: Record<string, unknown>;
  try {
    evt = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (evt.type === 'response.output_audio.started') gotStarted = true;
  if (evt.type === 'response.output_audio.delta') chunks.push(Buffer.from(String(evt.delta), 'base64'));
  if (evt.type === 'response.output_audio.done' && gotStarted) setTimeout(done, 500);
});
