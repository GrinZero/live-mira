// 预览面板 + 对视 parity 验证（stage-check 独立舞台页）：
//   1) inject() 注入样本 → 预览面板能打开、canvas 画出锚点圈（probe() 非空即画）
//   2) gx<0（用户向左转头）→ 她的头向画面右迎（gazeHead.yaw>0），不再同向跟看
//   3) 眼球注视点不含水平跟看偏移：userGazePoint 的 r 分量只由脸位置决定
//   4) fake camera 真实 enable() → 预览 <video> 拿到同一 MediaStream
// tsx scripts/verify-eye-preview.ts
import { chromium } from 'playwright';
import fs from 'node:fs';

const URL_ = 'http://localhost:5173/stage-check.html';
const OUT = '/Users/bugyaluwang/project/live-demo/output/checks';
fs.mkdirSync(OUT, { recursive: true });

async function main() {
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 860 },
    permissions: ['camera', 'microphone'],
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200));
  });

  await page.goto(URL_, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean((window as any).__actor && (window as any).__eye), null, { timeout: 20000 });
  await page.waitForTimeout(2500);

  // --- 1) 注入样本，预览按钮应出现（x=0 纯转头，隔离 parity 变量）---
  await page.evaluate(() => {
    const eye = (window as any).__eye;
    (window as any).__g = setInterval(() => eye.inject(0, 0, 0.55, -0.4, 0), 100);
  });
  await page.waitForTimeout(700);
  const btnVisible = await page.locator('.eye-preview-btn').isVisible();
  console.log('preview button visible:', btnVisible);
  await page.click('.eye-preview-btn');
  await page.waitForTimeout(600);
  const panel = await page.locator('.cam-panel').isVisible();
  const probe = await page.evaluate(() => (window as any).__eye.probe());
  console.log('panel visible:', panel, '| probe:', JSON.stringify(probe));
  // canvas 上有非透明像素 = 圈画出来了
  const drawn = await page.evaluate(() => {
    const cv = document.querySelector('.cam-canvas') as HTMLCanvasElement;
    const ctx = cv.getContext('2d');
    if (!ctx || !cv.width) return false;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
    return false;
  });
  console.log('circle drawn on canvas:', drawn);
  await page.screenshot({ path: `${OUT}/eye-preview-panel.png`, clip: { x: 130, y: 0, width: 300, height: 380 } });

  // --- 2) 用户向左转头（gx<0）→ 她的头应迎向画面右（yaw>0）---
  await page.waitForTimeout(1200);
  const yaw = await page.evaluate(() => (window as any).__actor.gazeHead.yaw);
  console.log('gx=-0.4 → gazeHead.yaw =', yaw.toFixed(3), '(期望 >0 = 画面右)');

  // 用户向右转头 → 应向画面左
  await page.evaluate(() => {
    const eye = (window as any).__eye;
    clearInterval((window as any).__g);
    (window as any).__g = setInterval(() => eye.inject(0, 0, 0.55, 0.4, 0), 100);
  });
  await page.waitForTimeout(1400);
  const yaw2 = await page.evaluate(() => (window as any).__actor.gazeHead.yaw);
  console.log('gx=+0.4 → gazeHead.yaw =', yaw2.toFixed(3), '(期望 <0 = 画面左)');

  // --- 3) 眼睛注视点：纯转头（x=0, gx=+0.4）时水平分量应 ≈ 相机 x（≈0.074）——
  // 视线锁脸，旧实现会 +0.11（gx*0.5*d 跟看偏移）
  const eyeX = await page.evaluate(() => (window as any).__actor.gazeCur.x);
  console.log('gazeCur.x =', eyeX.toFixed(3), '(期望 ≈0.07，旧实现 ≈0.18)');

  // --- 4) fake camera 真实链路：enable → 预览 video 共享同一 stream ---
  await page.evaluate(() => {
    clearInterval((window as any).__g);
    (window as any).__eye.disable();
  });
  const st = await page.evaluate(async () => {
    const eye = (window as any).__eye;
    try {
      await eye.enable();
    } catch (e) {
      return 'throw:' + (e as Error).name;
    }
    return eye.state;
  });
  await page.waitForTimeout(800);
  const shared = await page.evaluate(() => {
    const eye = (window as any).__eye;
    const pv = document.querySelector('.cam-video') as HTMLVideoElement | null;
    return {
      state: eye.state,
      stream: !!eye.getStream(),
      videoSrc: !!(pv && pv.srcObject),
      sameStream: !!(pv && pv.srcObject === eye.getStream()),
    };
  });
  console.log('enable() state =', st, '| shared stream:', JSON.stringify(shared));
  await page.screenshot({ path: `${OUT}/eye-preview-realcam.png`, clip: { x: 130, y: 0, width: 300, height: 380 } });

  await browser.close();
  const pass =
    btnVisible && panel && drawn && yaw > 0.01 && yaw2 < -0.01 && Math.abs(eyeX - 0.074) < 0.05 && shared.sameStream;
  if (!pass) {
    console.error('FAIL');
    process.exit(1);
  }
  console.log('done →', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
