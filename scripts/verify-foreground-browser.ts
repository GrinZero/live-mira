// Production renderer + real generated samples, without opening a microphone/session.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const dir = path.resolve('output/playwright/foreground');
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const evidence: object[] = [];
try {
  for (const name of ['porch', 'promenade']) {
    const media = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    assert.equal(!!media.foreground_url, name === 'porch');
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const params = new URLSearchParams({ scene: media.url });
      if (media.foreground_url) params.set('foreground', media.foreground_url);
      await page.goto(`http://127.0.0.1:5173/stage-check.html?${params}`);
      await page.getByRole('button', { name: '验证出发与到达' }).click();
      await page.waitForFunction(() => document.documentElement.dataset.presented === 'check');
      await page.getByRole('status').filter({ hasText: '已到达' }).waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll<HTMLImageElement>('.room-matte img,.scene-foreground img')].every(
          (i) => i.complete && i.naturalWidth > 0,
        ),
      );
      assert.equal(await page.locator('.scene-foreground').count(), name === 'porch' ? 1 : 0);
      await page.mouse.move(width / 2, height / 2);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(dir, `${name}-${width}.png`) });
      if (name === 'porch') {
        const layer = page.locator('.scene-foreground');
        const before = await layer.evaluate((el) => getComputedStyle(el).transform);
        await page.mouse.move(width - 5, 10);
        await page.waitForTimeout(700);
        const after = await layer.evaluate((el) => getComputedStyle(el).transform);
        assert.notEqual(after, before);
        assert.equal(await page.locator('.room-matte').evaluate((el) => getComputedStyle(el).transform), 'none');
        await page.screenshot({ path: path.join(dir, `${name}-${width}-parallax.png`) });
        await layer.evaluate((el) => {
          (el as HTMLElement).style.visibility = 'hidden';
        });
        await page.screenshot({ path: path.join(dir, `${name}-${width}-background-only.png`) });
        evidence.push({ name, width, height, foreground: true, before, after });
      } else evidence.push({ name, width, height, foreground: false });
    }
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(dir, 'browser.json'), JSON.stringify({ evidence, errors }, null, 2));
} finally {
  await browser.close();
}
