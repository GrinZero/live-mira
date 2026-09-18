// 音频驱动动作离线验证：mock 回放录音 → __speech 信号 + 头骨旋转方差
// tsx scripts/verify-audio-drive.ts [url]
import { chromium } from 'playwright';
import * as fs from 'node:fs';

const url = process.argv.find((a) => a.startsWith('http')) || 'http://localhost:5173/?mock=1';
const out = 'output/checks/audio-drive.json';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 860 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('.enter-btn');
  await page.waitForTimeout(1500);

  const stats = (await page.evaluate(`(() => {
    const speech = window.__speech;
    const probe = () => {
      const a = window.__actor;
      const h = a?.vrm?.humanoid?.getNormalizedBoneNode?.('head')?.rotation;
      return a && h ? { nod: a.nod, tilt: a.tilt, yaw: a.yaw, hx: h.x, hy: h.y } : null;
    };
    const speaking = [], quiet = [], nods = [], nodsQuiet = [];
    let beats = 0, maxLevel = 0, samples = 0, lastBeat = 0, nodMax = 0;
    const t0 = performance.now();
    return new Promise((resolve) => {
      const iv = setInterval(() => {
        const s = speech();
        const r = probe();
        samples++;
        maxLevel = Math.max(maxLevel, s.level);
        if (s.beat > 0.4 && performance.now() - lastBeat > 200) { beats++; lastBeat = performance.now(); }
        if (r) {
          nodMax = Math.max(nodMax, Math.abs(r.nod));
          if (s.level > 0.08) { speaking.push({ x: r.hx, y: r.hy }); nods.push(r.nod, r.tilt, r.yaw); }
          else if (s.level < 0.02) { quiet.push({ x: r.hx, y: r.hy }); nodsQuiet.push(r.nod); }
        }
        if (performance.now() - t0 > 55000) { clearInterval(iv); resolve({ samples, speechFrames: speaking.length, beats, maxLevel, nodMax, speaking, quiet, nods, nodsQuiet }); }
      }, 40);
    });
  })()`)) as {
    samples: number;
    speechFrames: number;
    beats: number;
    maxLevel: number;
    nodMax: number;
    speaking: { x: number; y: number }[];
    quiet: { x: number; y: number }[];
    nods: number[];
    nodsQuiet: number[];
  };

  const variance = (a: number[]) => {
    const m = a.reduce((s, v) => s + v, 0) / (a.length || 1);
    return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1);
  };
  const range = (a: number[]) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  const pack = (arr: { x: number; y: number }[]) => ({
    varX: +variance(arr.map((v) => v.x)).toFixed(6),
    varY: +variance(arr.map((v) => v.y)).toFixed(6),
    rangeX: +range(arr.map((v) => v.x)).toFixed(4),
  });
  const nodVar = +variance(stats.nods).toFixed(6);
  const nodVarQuiet = +variance(stats.nodsQuiet).toFixed(6);
  const result = {
    samples: stats.samples,
    speechFrames: stats.speechFrames,
    beats: stats.beats,
    maxLevel: +stats.maxLevel.toFixed(3),
    nodMax: +stats.nodMax.toFixed(4),
    nodVarDuringSpeech: nodVar,
    nodVarQuiet,
    headRotDuringSpeech: pack(stats.speaking),
    headRotQuiet: pack(stats.quiet),
  };
  fs.mkdirSync('output/checks', { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  // nodMax ≈ 头部瞬时偏转（rad）；>0.07 ≈ 头部可见点头 ~3°+；quiet 应≈0
  console.log(
    result.speechFrames > 20 && result.beats >= 2 && stats.nodMax > 0.07 && nodVarQuiet < nodVar * 0.3
      ? 'PASS'
      : 'CHECK-NEEDED',
  );
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
