import { chromium } from 'playwright';
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
const page = await ctx.newPage();
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForSelector('.enter-btn:not([disabled])', { timeout: 30000 });
await page.click('.enter-btn');
await page.waitForTimeout(2500);
const st = await page.evaluate(() => ({
  eye: (window as any).__eye?.state,
  entered: (window as any).__store?.getState?.().entered,
  toast: (window as any).__store?.getState?.().toast,
  mediaDevices: !!navigator.mediaDevices?.getUserMedia,
}));
console.log('probe:', JSON.stringify(st));
// 手动再 enable 一次看报什么错
const manual = await page.evaluate(async () => {
  try {
    await (window as any).__eye.enable();
    return 'ok:' + (window as any).__eye.state;
  } catch (e) {
    return 'throw:' + (e as Error).name + ':' + (e as Error).message;
  }
});
console.log('manual enable:', manual);
await browser.close();
