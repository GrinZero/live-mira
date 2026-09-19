// Real voice/director/image providers, browser and SQLite. Uses paid APIs.
// Isolated save directory and ports: never modifies the user's active world.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { chromium } from 'playwright';
import { WorldStore } from '../server/src/world/store.js';

const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-browser-world-'));
const out = path.join(root, 'output/checks/scene-live');
fs.mkdirSync(out, { recursive: true });
const db = new WorldStore(dir, path.join(root, 'assets'), path.join(root, 'cache'));
const token = randomUUID();
const initial = db.open(token);
const cafe = initial.locations[0];
let backend: ChildProcess | undefined;
let vite: ChildProcess | undefined;
let logs = '';
const run = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd = root) => {
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (b) => {
    logs += b.toString();
  });
  child.stderr?.on('data', (b) => {
    logs += b.toString();
  });
  return child;
};
const bootBackend = () =>
  run(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'], {
    PORT: '8793',
    WORLD_DATA_DIR: dir,
    MAP_IMAGES: '1',
    RECORD: '0',
    ACCESS_TOKENS: ' ',
  });
const waitHttp = async (url: string) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* wait for boot */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server unavailable: ${url}`);
};
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  backend = bootBackend();
  vite = run(
    process.execPath,
    [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5193', '--strictPort'],
    { VITE_SERVER_TARGET: 'http://127.0.0.1:8793' },
    path.join(root, 'web'),
  );
  await Promise.all([waitHttp('http://127.0.0.1:8793/api/health'), waitHttp('http://127.0.0.1:5193')]);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
    recordVideo: { dir: out, size: { width: 1280, height: 800 } },
  });
  await context.addInitScript((t) => {
    localStorage.setItem('mira.ct', t);
    localStorage.setItem('mira.eye', 'off');
  }, token);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    errors.push(e.message);
    fs.writeFileSync(path.join(out, 'errors.json'), JSON.stringify(errors));
  });
  const enter = async () => {
    await page.goto('http://127.0.0.1:5193');
    await page
      .locator('.enter-btn')
      .click({ timeout: 90000 })
      .catch(async (e) => {
        await page.screenshot({ path: path.join(out, 'failure.png') });
        fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
        throw e;
      });
    await page.locator('.world-map-opener').waitFor({ timeout: 15000 });
  };
  await enter();
  await page.locator('.world-map-opener').click();
  await page.locator('.world-map-region img').waitFor();
  await page.waitForFunction(
    () => {
      const img = document.querySelector<HTMLImageElement>('.world-map-region img');
      return img?.complete && img.naturalWidth > 0;
    },
    {},
    { timeout: 15000 },
  );
  await page.screenshot({ path: path.join(out, 'initial-map.png') });
  await page.getByRole('button', { name: '关闭地图', exact: true }).click();
  await page.getByRole('textbox', { name: '对 Mira 说' }).fill('我们现在一起去咖啡馆外面的屋檐下看看雨吧，走吧。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  let arrived = false;
  for (let i = 0; i < 150; i++) {
    if (db.read(initial.id).locations.length > 1) {
      arrived = true;
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!arrived) {
    await page.screenshot({ path: path.join(out, 'travel-failed.png') });
    throw new Error('Real model never committed a new destination');
  }
  await page.waitForTimeout(2500);
  await page.locator('.world-map-opener').click();
  for (let i = 0; i < 90 && db.read(initial.id).locations.some((l) => l.mapStatus === 'pending'); i++)
    await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(out, 'explored-map.png') });
  const statuses = db.read(initial.id).locations.map((l) => ({ name: l.name, mapStatus: l.mapStatus }));
  assert(
    statuses.every((l) => l.mapStatus === 'ready'),
    'generated regions must be ready',
  );
  const images = await page
    .locator('.world-map-region img')
    .evaluateAll((imgs: HTMLImageElement[]) => imgs.map((i) => ({ loaded: i.complete && i.naturalWidth > 0 })));
  assert(images.length >= 2 && images.every((i) => i.loaded));
  await page.locator('.world-map-region').filter({ hasText: '雨夜咖啡馆' }).click();
  await page.getByRole('button', { name: '回到雨夜咖啡馆', exact: true }).click();
  await page.getByRole('button', { name: '关闭地图', exact: true }).click();
  await page.waitForTimeout(5000);
  assert.equal(db.read(initial.id).currentLocationId, cafe.id);
  await page.screenshot({ path: path.join(out, 'returned.png') });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.world-map-opener').click();
  await page.screenshot({ path: path.join(out, 'mobile-map.png') });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, statuses, images, errors }, null, 2));
  await context.close();
  console.log('Real journey recorded:', await page.video()?.path());
} finally {
  await browser.close();
  backend?.kill('SIGTERM');
  vite?.kill('SIGTERM');
  db.close();
  fs.writeFileSync(path.join(out, 'server.log'), logs);
}
