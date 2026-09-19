import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
page.setDefaultTimeout(15_000);

try {
  const baseUrl = process.env.MIRA_WEB_URL ?? 'http://127.0.0.1:5173';
  await page.goto(`${baseUrl}/?mock=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('.enter-btn');
    return button !== null && !button.disabled;
  });
  await page.locator('.enter-btn').click();
  await page.locator('.subtitles').waitFor({ state: 'attached' });
  const layout = await page.locator('.subtitles').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      left: rect.left,
      right: rect.right,
      center: rect.left + rect.width / 2,
    };
  });

  assert.ok(Math.abs(layout.center - layout.viewportWidth / 2) <= 1, JSON.stringify(layout));
  console.log('Landscape subtitle layout passed:', layout);
} finally {
  await browser.close();
}
