// 把最近一次录制（recordings/session-*.jsonl + .pcm）转成前端回放包：
//   web/public/mock/session.json —— 客户端可见事件时间轴
//   web/public/mock/audio.pcm    —— 下行 TTS 裸流（PCM s16le 24k）
//   web/public/mock/media/*      —— 录制中生成/引用的媒体，URL 重写为本地
// 用法: tsx scripts/build-mock.ts [recordings/session-xxx.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const recDir = path.join(ROOT, 'recordings');
const outDir = path.join(ROOT, 'web', 'public', 'mock');
const mediaOut = path.join(outDir, 'media');

// 只保留客户端可见消息 + 音频切片标记；上游原始事件不进回放
const KEEP = new Set([
  'state',
  'transcript.user',
  'transcript.mira',
  'transcript.mira.done',
  'directive',
  'audio.begin',
  'audio.end',
  'audio.pcm',
  'media.event',
  'narration',
  'interrupted',
]);

interface RecEvent {
  t: number;
  type: string;
  payload?: Record<string, unknown>;
  audio?: number;
}

const argFile = process.argv[2];
const jsonl =
  argFile ??
  fs
    .readdirSync(recDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .pop();
if (!jsonl) {
  console.error('no recordings found — run server with RECORD=1 first');
  process.exit(1);
}
const recFile = path.isAbsolute(jsonl) ? jsonl : path.join(recDir, jsonl);
const pcmFile = recFile.replace(/\.jsonl$/, '.pcm');
console.log('source:', recFile);

const events: RecEvent[] = fs
  .readFileSync(recFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RecEvent)
  .filter((e) => KEEP.has(e.type))
  // state:listening 由客户端在音频耗尽时自行推导；录制里的过早 listening 会关断打断窗口
  .filter((e) => !(e.type === 'state' && (e.payload as { phase?: string })?.phase === 'listening'));

fs.mkdirSync(mediaOut, { recursive: true });
// 清空旧媒体
for (const f of fs.readdirSync(mediaOut)) fs.unlinkSync(path.join(mediaOut, f));

// 媒体 URL 本地化：/media/x.jpg → 复制到 /mock/media/x.jpg
for (const e of events) {
  if (e.type !== 'media.event' || !e.payload) continue;
  const ev = (e.payload as { event?: { url?: string } }).event;
  const url = ev?.url ?? '';
  if (!url.startsWith('/media/')) continue;
  const name = url.slice('/media/'.length);
  const src = path.join(ROOT, 'cache', 'media', name);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(mediaOut, name));
    ev!.url = `/mock/media/${name}`;
    console.log('  media →', name);
  } else {
    console.warn('  media missing:', name);
  }
}

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(pcmFile)) {
  fs.copyFileSync(pcmFile, path.join(outDir, 'audio.pcm'));
  console.log(`audio.pcm ${(fs.statSync(pcmFile).size / 1024).toFixed(0)}KB`);
} else {
  console.warn('no pcm beside jsonl — replay will be silent');
}

const script = { events, audioFile: '/mock/audio.pcm', sampleRate: 24000 };
fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(script));
console.log(`session.json: ${events.length} events → ${path.relative(ROOT, outDir)}/`);
