// 截图/冒烟：playwright 打开页面 → 进入 → 连续截帧看效果
// tsx scripts/snap.ts [url] [outPrefix] [--wait ms] [--speak wav]
import { chromium, type Page } from 'playwright';

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) || 'http://localhost:5173';
const prefix = argv.find((a) => a.startsWith('/') && !a.startsWith('--')) || '/tmp/mira';
const has = (k: string) => argv.includes(`--${k}`);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};

async function shot(p: Page, name: string) {
  await p.screenshot({ path: `${prefix}-${name}.png` });
  console.log(`shot ${name}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: !has('headed'),
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      has('headed') ? '' : '--headless=new',
    ].filter(Boolean),
  });
  const ctx = await browser.newContext({
    viewport: { width: 430, height: 860 }, // 移动端尺寸
    permissions: ['microphone'],
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await shot(page, '1-enter');

  // 轻触进入
  await page.click('.enter-btn');
  await page.waitForTimeout(5000);
  await shot(page, '2-open');

  // 文字回合
  if (has('text')) {
    await page.fill('.inputbar input', arg('text', '你在等谁？'));
    await page.click('.sendbtn');
    await page.waitForTimeout(9000);
    await shot(page, '3-text');
  }

  if (has('waits')) {
    await page.waitForTimeout(Number(arg('waits', '8000')));
    await shot(page, '5-late');
  }

  await page.waitForTimeout(4000);
  await shot(page, '4-idle');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
