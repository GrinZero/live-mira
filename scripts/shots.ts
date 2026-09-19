/* 验证脚本：mock 回放里截转场 + 室外站位。跑法：pnpm exec tsx scripts/shots.ts */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'output/checks/journey';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:5173/?mock=1');
await page.waitForSelector('text=进入', { timeout: 20000 });
await page.click('text=进入');
await page.waitForTimeout(600);

const st = () =>
  page.evaluate(() => {
    const s = (window as any).__store?.getState();
    return { tr: s?.sceneTransition?.phase ?? 'none', phase: s?.phase, bg: s?.bgKey };
  });

// 等当前段播完再发下一条（playNext 在播放中会被吞）
async function poke(text: string) {
  for (let i = 0; i < 20; i++) {
    const { phase } = await st();
    if (phase === 'listening' || phase === 'idle') break;
    await page.waitForTimeout(500);
  }
  await page.fill('.inputbar input', text);
  await page.press('.inputbar input', 'Enter');
  await page.waitForTimeout(900);
}

let departShot = false;
for (let i = 0; i < 16; i++) {
  const { tr, phase } = await st();
  console.log(`poke ${i}: transition=${tr} phase=${phase}`);
  if (tr === 'departing' && !departShot) {
    departShot = true;
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/depart-mid.png` });
    console.log('shot depart-mid');
  }
  if (tr === 'arriving') {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/arrive-mid.png` });
    console.log('shot arrive-mid');
    break;
  }
  await poke(`继续 ${i}`);
}

for (let i = 0; i < 14; i++) {
  const { tr, bg } = await st();
  console.log(`settle ${i}: transition=${tr} bg=${bg}`);
  if (tr === 'none' && bg !== 'cafe_interior') break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/settled-outside.png` });
console.log('shot settled-outside');

await browser.close();
