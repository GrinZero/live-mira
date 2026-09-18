// 视线追踪验证（stage-check 独立舞台页，无后端依赖）：
//   1) 注入合成注视样本 → 截图对比瞳孔/头朝向（无摄像头环境也能验视线链路）
//   2) fake camera 真实 enable() → 状态变 on、检测循环跑起来（无脸时回落默认注视）
// tsx scripts/verify-eye-contact.ts
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
  await page.waitForTimeout(2500); // 模型就绪稳定

  const face = { x: 20, y: 60, width: 400, height: 420 };
  const shot = (name: string) => page.screenshot({ path: `${OUT}/eye-${name}.png`, clip: face });
  await page.screenshot({ path: `${OUT}/eye-0-full.png` });
  await shot('1-default');

  // 用户在屏幕右侧 → 她的视线应偏画面右
  await page.evaluate(() => {
    const eye = (window as any).__eye;
    (window as any).__g = setInterval(() => eye.inject(0.8, 0.3, 0.55), 100);
  });
  await page.waitForTimeout(1600);
  await shot('2-user-right');

  await page.evaluate(() => {
    const eye = (window as any).__eye;
    clearInterval((window as any).__g);
    (window as any).__g = setInterval(() => eye.inject(-0.8, 0.3, 0.55), 100);
  });
  await page.waitForTimeout(1600);
  await shot('3-user-left');

  // 用户偏低（低头/把手机放低）→ 她该低头看下来
  await page.evaluate(() => {
    const eye = (window as any).__eye;
    clearInterval((window as any).__g);
    (window as any).__g = setInterval(() => eye.inject(0.15, -0.6, 0.55), 100);
  });
  await page.waitForTimeout(1600);
  await shot('3b-user-low');

  // 用户脸居中但视线看向右下（读屏幕角落的东西）→ 她的目光跟着你的视线走
  await page.evaluate(() => {
    const eye = (window as any).__eye;
    clearInterval((window as any).__g);
    (window as any).__g = setInterval(() => eye.inject(0, 0, 0.55, 0.8, -0.6), 100);
  });
  await page.waitForTimeout(1600);
  await shot('3c-gaze-rightdown');

  // 凑近（dist 小）→ 注视点拉近，双眼轻微集合
  await page.evaluate(() => {
    const eye = (window as any).__eye;
    clearInterval((window as any).__g);
    (window as any).__g = setInterval(() => eye.inject(0, 0.05, 0.28, 0, 0), 100);
  });
  await page.waitForTimeout(1600);
  await shot('3d-close');

  // 停止注入 → 样本过期 → 回落默认
  await page.evaluate(() => clearInterval((window as any).__g));
  await page.waitForTimeout(1600);
  await shot('4-lost');

  // 真实链路：fake camera + wasm/model 实际加载
  await page.evaluate(() => (window as any).__eye.disable());
  const st = await page.evaluate(async () => {
    const eye = (window as any).__eye;
    try {
      await eye.enable();
    } catch (e) {
      return 'throw:' + (e as Error).name;
    }
    return eye.state;
  });
  console.log('enable() state =', st);
  await page.waitForTimeout(1500);
  const probe = await page.evaluate(() => ({
    state: (window as any).__eye.state,
    gaze: (window as any).__eye.gaze(),
    videoAlive: !!(document.querySelector('video') as HTMLVideoElement | null)?.srcObject,
  }));
  console.log('probe:', JSON.stringify(probe));
  await page.screenshot({ path: `${OUT}/eye-5-realcam.png`, clip: face });

  // 开关按钮：真实点击 → 开/关
  await page.screenshot({ path: `${OUT}/eye-6-toggle-on.png`, clip: { x: 0, y: 0, width: 430, height: 80 } });
  await page.click('.eye-toggle');
  await page.waitForTimeout(400);
  const eyeAfter = await page.evaluate(() => (window as any).__eye.state);
  const persisted = await page.evaluate(() => localStorage.getItem('mira.eye'));
  console.log('after toggle off:', eyeAfter, '| localStorage mira.eye =', persisted);
  await page.screenshot({ path: `${OUT}/eye-7-toggle-off.png`, clip: { x: 0, y: 0, width: 430, height: 80 } });

  await browser.close();
  if (st !== 'on') {
    console.error('FAIL: enable() did not reach on');
    process.exit(1);
  }
  console.log('done →', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
