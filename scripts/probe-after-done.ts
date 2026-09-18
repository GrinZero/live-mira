import WebSocket from 'ws';
import { config } from '../server/src/config.js';
import { loadContent } from '../server/src/content.js';
import { TOOLS } from '../server/src/duplex.js';

// 探针：commit 一句台词后保持静默 20s，观察上游是否自发再出音频（yield 时的怪声嫌疑）
const content = loadContent();
const ws = new WebSocket(config.duplexUrl, { headers: { 'X-Api-Key': config.doubaoApiKey } });
const t0 = Date.now();
const ev = (m: string, extra = '') => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}] ${m}`, extra);
let doneAt = 0;

ws.on('message', (raw: Buffer) => {
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  const t = String(e.type ?? '');
  if (t === 'response.output_audio.delta') {
    process.stdout.write(`\raudio.delta ${String(e.delta ?? '').length}B tts? rid=${e.response_id}`);
    return;
  }
  ev(`← ${t}`, JSON.stringify({ ...e, delta: undefined }).slice(0, 220));
  if (t === 'response.output_audio.done') doneAt = Date.now();
});

await new Promise<void>((resolve, reject) => {
  ws.once('open', () => resolve());
  ws.once('error', reject);
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
await new Promise((r) => setTimeout(r, 1200));

// 开麦喂静音帧（模拟真实会话里 mic open 但用户没说话）
ws.send(JSON.stringify({ type: 'input_audio_unmute.commit' }));
const silence = Buffer.alloc(640).toString('base64');
const pacer = setInterval(() => {
  ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: silence }));
}, 20);

// 等她开口问完一个问题（yield 的典型场景：问完把话交给用户）
ws.send(
  JSON.stringify({ type: 'speech_text_buffer.commit', text: '雨天的咖啡馆总是很适合发呆呢。你也喜欢这样的天气吗？' }),
);
ev('commit sent');

await new Promise((r) => setTimeout(r, 20000));
ev('probe window over', doneAt ? `last audio.done at +${((doneAt - t0) / 1000).toFixed(1)}s` : 'no audio.done seen');
clearInterval(pacer);
ws.send(JSON.stringify({ type: 'session.close' }));
await new Promise((r) => setTimeout(r, 800));
ws.close();
process.exit(0);
