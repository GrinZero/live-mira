// Real browser + application WS + SQLite. Only the upstream voice provider is a fixture.
// Uses an isolated save directory and ports; never touches the user's world or paid APIs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { WorldStore } from '../server/src/world/store.js';

const root = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-browser-world-'));
const out = path.join(root, 'output/playwright/entry');
fs.mkdirSync(out, { recursive: true });
const db = new WorldStore(dir, path.join(root, 'assets'), path.join(root, 'cache'));
const token = randomUUID();
const initial = db.open(token);
const cafe = initial.locations[0];
db.update(initial.id, 'enter', 'enter', (w) => {
  w.entered = true;
  w.locations[0].url = db.promote(initial.id, cafe.url);
  w.locations[0].mapStatus = 'ready';
  w.locations[0].mapUrl = db.promote(initial.id, '/assets/bg/cafe_map.webp');
  w.memory = [{ role: 'user', text: '我们去屋檐下看看', ts: Date.now() }];
});
const outside = {
  ...cafe,
  id: randomUUID(),
  key: 'street_outside',
  name: '屋檐下',
  description: '咖啡馆外的屋檐，雨夜街道',
  url: db.promote(initial.id, '/assets/bg/street_outside.jpg'),
  x: 300,
  y: 0,
  visits: 0,
  mapStatus: 'failed' as const,
};
db.arrive(initial.id, 'fixture-arrival', cafe.id, outside);
const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(upstream, 'listening');
let silent = false;
upstream.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session.close') ws.send(JSON.stringify({ type: 'session.closed' }));
    if (m.type === 'session.create' && !silent)
      ws.send(JSON.stringify({ type: 'session.created', session: { id: randomUUID() } }));
  });
});
const address = upstream.address();
assert(typeof address !== 'string' && address);
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
    MAP_IMAGES: '0',
    RECORD: '0',
    ACCESS_TOKENS: ' ',
    DOUBAO_API_KEY: 'fixture',
    SEED_API_KEY: 'fixture',
    DUPLEX_URL: `ws://127.0.0.1:${address.port}`,
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
  await context.addInitScript((token) => {
    localStorage.setItem('mira.ct', token);
    localStorage.setItem('mira.eye', 'off');
  }, token);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://127.0.0.1:5193');
  await page.getByRole('button', { name: '继续上次', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'continue.png') });
  await page.getByRole('button', { name: '继续上次', exact: true }).click({ timeout: 90000 });
  await page.locator('.world-map-opener').filter({ hasText: '屋檐下' }).waitFor({ timeout: 15000 });
  assert.equal(db.open(token).id, initial.id);
  await page.reload();
  await page.getByRole('button', { name: '开始新故事', exact: true }).click({ timeout: 90000 });
  await page.locator('.world-map-opener').filter({ hasText: '雨夜咖啡馆' }).waitFor({ timeout: 15000 });
  const fresh = db.open(token);
  assert.notEqual(fresh.id, initial.id);
  assert.equal(fresh.locations.length, 1);
  assert.equal(fresh.locations[0].key, 'cafe_interior');
  assert.equal(db.read(initial.id).locations.length, 2, 'old story is archived');
  const reset = async () => {
    await page.getByRole('button', { name: '重新开始', exact: true }).click();
    await page.getByRole('button', { name: '重新开始', exact: true }).click();
  };
  const before = Date.now();
  await reset();
  await page.getByRole('button', { name: '连接中…', exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
  await page.locator('.world-map-opener').waitFor({ timeout: 15000 });
  const resetMs = Date.now() - before;
  assert.notEqual(db.open(token).id, fresh.id);
  silent = true;
  await reset();
  await page.getByText('连接失败：语音会话连接超时，请重试', { exact: true }).waitFor({ timeout: 20000 });
  silent = false;
  await page.getByRole('button', { name: '开始新故事', exact: true }).click({ timeout: 15000 });
  await page.locator('.world-map-opener').waitFor({ timeout: 15000 });
  assert.equal(db.open(token).locations.length, 1);
  await page.reload();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: '继续上次', exact: true }).waitFor();
  await page.screenshot({ path: path.join(out, 'mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        resetMs,
        checks: [
          'continue saved location without browser sid',
          'fresh story archives old world',
          'reset waits for session and enters',
          'timeout is visible and retry succeeds',
          'mobile entry fits',
        ],
        limitations: 'Real browser, app server and SQLite; fixture upstream voice, not live provider latency.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, resetMs, out }));
  await context.close();
} catch (e) {
  fs.writeFileSync(path.join(out, 'server.log'), logs);
  throw e;
} finally {
  await browser.close();
  backend?.kill('SIGTERM');
  vite?.kill('SIGTERM');
  for (const client of upstream.clients) client.terminate();
  upstream.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
