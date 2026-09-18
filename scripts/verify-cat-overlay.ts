// 验证：mock 回放推进到"猫经过"事件 → 叠层应在旁白后渐显、ttl 后渐隐
// tsx scripts/verify-cat-overlay.ts [url] [outPrefix]
import { chromium, type Page } from 'playwright';

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) || 'http://localhost:5173/?mock=1';
const prefix = argv.find((a) => a.startsWith('/') && !a.startsWith('--')) || '/tmp/cat';

async function shot(p: Page, name: string) {
  await p.screenshot({ path: `${prefix}-${name}.png` });
  console.log(`shot ${name}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--headless=new',
    ],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    permissions: ['microphone'],
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));

  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('.enter-btn');
  await page.waitForTimeout(2500);

  // 推进段落：发送文字，直到出现猫旁白（ swallowed while playing → 间隔重发）
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    found = await page
      .locator('.sub.narration', { hasText: '猫' })
      .count()
      .then((n) => n > 0);
    if (found) break;
    await page.fill('.inputbar input', `继续 ${i}`);
    await page.click('.sendbtn');
    await page.waitForTimeout(1600);
  }
  console.log('cat narration found:', found);
  if (!found) {
    await shot(page, 'notfound');
    await browser.close();
    process.exit(1);
  }

  // 叠层 media.event 在旁白后 ~0.8s 到达，渐显 ~1s → 2.2s 时应可见
  await page.waitForTimeout(2400);
  await shot(page, '1-cat-in');
  await page.waitForTimeout(4000);
  await shot(page, '2-cat-hold');
  // ttl=10s 后应渐隐
  await page.waitForTimeout(7000);
  await shot(page, '3-cat-out');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
