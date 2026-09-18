// 录制一场完整 demo 戏（需服务端以 RECORD=1 运行）
// 节拍：enter → wav1 → u3 → 打断示范 → u4(照片钩) → u5(转场钩) → 文字回合 → 收尾
// 用法: tsx scripts/record-demo.ts
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

const SILENCE = Buffer.alloc(640);

function wavPcm(file: string): Buffer {
  const d = fs.readFileSync(file);
  let off = 12;
  while (off + 8 <= d.length) {
    const id = d.toString('ascii', off, off + 4);
    const sz = d.readUInt32LE(off + 4);
    if (id === 'data') return d.subarray(off + 8, off + 8 + sz);
    off += 8 + sz;
  }
  return d.subarray(44);
}

// 合成语音 ASR 偶尔丢句：确定性钩子（照片/转场）走文字，wav 只留开场真语音与打断示范
// 转场钩必须是共同明确行动（世界更新拒绝"要不我们去…吧"式口头商量），且尽早发出给生图留时间
const SCRIPT: { wav?: string; text?: string; barge?: boolean }[] = [
  { wav: '/tmp/probe_q.wav' }, // 外面雨好大…
  { text: '这么大的雨，你是一直在这里等人吗？' },
  { text: '给我看看你旅途中拍的照片吧' }, // 照片钩
  { text: '这张照片背后有什么故事吗？' },
  { text: '我们现在一起推门出去，沿着街道走到桥边看看吧。' }, // 转场钩：明确行动
  { wav: '/tmp/u6.wav', barge: true }, // 她回应途中打断 + 这句
  { text: '明天还会下雨吗？' },
];

async function main() {
  const ws = new WebSocket('ws://localhost:8787/ws');
  let segIdx = -1; // 已完成的 mira 语音段数
  let stepIdx = 0; // 已执行的脚本步
  let bargeDone = false;
  let live = true;

  const stream = async (file: string) => {
    const pcm = wavPcm(file);
    for (let i = 0; i + 640 <= pcm.length && live; i += 640) {
      ws.send(pcm.subarray(i, i + 640));
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const next = () => {
    if (stepIdx >= SCRIPT.length || !live) return;
    const step = SCRIPT[stepIdx++];
    if (step.wav) void stream(step.wav);
    if (step.text) ws.send(JSON.stringify({ type: 'text', text: step.text }));
  };

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello' }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'enter' }));
      // 背景静音流，保活 VAD
      (async () => {
        while (live) {
          ws.send(SILENCE);
          await new Promise((r) => setTimeout(r, 20));
        }
      })();
    }, 600);
    // 开场白给 4s，然后第一句用户语音
    setTimeout(next, 4500);
  });

  ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (isBinary) return;
    const m = JSON.parse(raw.toString());
    if (m.type === 'audio.begin') {
      segIdx++;
      // barge 步：她刚说 1.6s 就插话
      const pending = SCRIPT[stepIdx];
      if (pending?.barge && !bargeDone) {
        bargeDone = true;
        setTimeout(() => {
          console.log('>> barge-in');
          ws.send(JSON.stringify({ type: 'interrupt' }));
          next(); // 说 u5
        }, 1600);
      }
    }
    if (m.type === 'audio.end') {
      console.log(`< audio.end int=${m.interrupted ?? false} seg=${segIdx}`);
      // 回放客户端不真播音频：回执 remaining_ms=0 告诉服务端"播完了"，
      // 否则下一句文字在 6s 宽限窗内到达会被当成打断，连砍正常回合
      if (!m.interrupted) {
        ws.send(JSON.stringify({ type: 'playback', response_id: m.response_id, remaining_ms: 0 }));
        setTimeout(next, 2500);
      }
    }
    if (m.type === 'media.event')
      console.log(`< media ${m.event.kind}/${m.event.status} ${m.event.url ?? m.event.reason ?? ''}`);
    if (m.type === 'directive') console.log('< directive', JSON.stringify(m.directive));
    if (m.type === 'transcript.user' && m.final) console.log(`< user: ${m.text}`);
    if (m.type === 'error') console.log(`< ERROR ${m.code}: ${m.message}`);
  });

  setTimeout(
    () => {
      live = false;
      ws.close();
      console.log('done');
      process.exit(0);
    },
    Number(process.env.DUR ?? 240000),
  );
}

main();
