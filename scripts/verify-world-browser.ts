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
const out = path.join(root, 'output/checks/world');
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
upstream.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'session.create')
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
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.locator('.world-map-region').count(), 2);
  const assertVisibleMap = async () => {
    await page.waitForFunction(
      () => {
        const viewport = document.querySelector('.world-map-viewport')!.getBoundingClientRect();
        const regions = [...document.querySelectorAll('.world-map-region')];
        return (
          regions.length === 2 &&
          regions.every((region) => {
            const rect = region.getBoundingClientRect();
            const img = region.querySelector('img');
            return (
              img?.complete &&
              img.naturalWidth > 0 &&
              rect.left >= viewport.left &&
              rect.right <= viewport.right &&
              rect.top >= viewport.top &&
              rect.bottom <= viewport.bottom
            );
          })
        );
      },
      {},
      { timeout: 15000 },
    );
  };
  await assertVisibleMap();
  // Inspect the rendered R3F scene during the actual WS transition. Assertions
  // catch the old translation/zoom pattern, rather than merely an empty console.
  await page.evaluate(`(async () => {
    const source = await (await fetch('/src/scene/Stage.tsx')).text();
    const spec = source.match(/from ["']([^"']*@react-three_fiber[^"']*)["']/)[1];
    const { _roots } = await import(spec);
    const { useStore } = await import('/src/state/store.ts');
    const samples = window.__journeySamples = [];
    const sample = () => {
      const state = useStore.getState();
      if (state.sceneTransition && state.sceneTransition.phase !== 'preparing') {
        const frame = [..._roots.values()][0]?.store.getState();
        const actor = frame?.scene.getObjectByName('mira-placement');
        if (actor) samples.push({ phase: state.sceneTransition.phase, bg: state.bgKey,
          x: actor.position.x, z: actor.position.z, cameraZ: frame.camera.position.z });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`);

  await page.getByRole('button', { name: '放大地图', exact: true }).click();
  await page.getByRole('button', { name: '缩小地图', exact: true }).click();
  await page.screenshot({ path: path.join(out, 'desktop.png') });
  await page.locator('.world-map-region').filter({ hasText: '雨夜咖啡馆' }).click();
  await page.getByRole('button', { name: '回到雨夜咖啡馆', exact: true }).click();
  await page.getByRole('button', { name: '取消行程', exact: true }).click({ timeout: 1200 });
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(db.read(initial.id).currentLocationId, outside.id, 'cancel preserves origin');
  await page.getByRole('button', { name: '回到雨夜咖啡馆', exact: true }).click();
  await page.getByRole('button', { name: '关闭地图', exact: true }).click();
  for (let i = 0; i < 60 && db.read(initial.id).currentLocationId !== cafe.id; i++)
    await new Promise((r) => setTimeout(r, 100));
  assert.equal(db.read(initial.id).currentLocationId, cafe.id);
  assert.equal(db.read(initial.id).locations.length, 2);
  assert.equal(db.read(initial.id).locations[0].visits, 2);
  await page.waitForTimeout(1800);
  const journeySamples = (await page.evaluate(() => (window as any).__journeySamples)) as {
    phase: string;
    bg: string;
    x: number;
    z: number;
    cameraZ: number;
  }[];
  assert(journeySamples.some((s) => s.phase === 'departing') && journeySamples.some((s) => s.phase === 'arriving'));
  assert(
    journeySamples.every((s) => Math.abs(s.x) < 0.001 && Math.abs(s.z) < 0.001),
    'no photo-space sliding',
  );
  // Discard the first RAF of a cut, when the store can precede the camera update.
  const settledFrames = journeySamples.filter((s, i) => i > 0 && journeySamples[i - 1].bg === s.bg);
  assert(
    settledFrames.every((s) => Math.abs(s.cameraZ - (s.bg === 'cafe_interior' ? 1.55 : 3.05)) < 0.02),
    'no transit-only zoom or arrival doll-to-human scale change',
  );
  fs.writeFileSync(path.join(out, 'journey-samples.json'), JSON.stringify(journeySamples));
  await page.screenshot({ path: path.join(out, 'arrival.png') });
  await page.reload();
  await page
    .locator('.enter-btn')
    .click({ timeout: 90000 })
    .catch(async (e) => {
      await page.screenshot({ path: path.join(out, 'failure.png') });
      fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
      throw e;
    });
  await page.locator('.world-map-opener').filter({ hasText: '雨夜咖啡馆' }).waitFor();
  // Restart the actual backend; same browser credentials must recover the persisted world.
  backend.kill('SIGTERM');
  await once(backend, 'exit');
  backend = bootBackend();
  await waitHttp('http://127.0.0.1:8793/api/health');
  await page.reload();
  await page
    .locator('.enter-btn')
    .click({ timeout: 90000 })
    .catch(async (e) => {
      await page.screenshot({ path: path.join(out, 'failure.png') });
      fs.writeFileSync(path.join(out, 'failure.txt'), await page.locator('body').innerText());
      throw e;
    });
  await page.locator('.world-map-opener').filter({ hasText: '雨夜咖啡馆' }).waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.locator('.world-map-opener').click();
  await page.getByRole('dialog').waitFor();
  await assertVisibleMap();
  await page.screenshot({ path: path.join(out, 'mobile.png') });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        evidence:
          'real UI, WS and durable SQLite; seeded visited world and fixture voice provider; no live voice/image generation or physical phone acceptance',
        checks: [
          'visited-only regions',
          'zoom',
          'cancel before arrival',
          'return with saved image',
          'no duplicate visits',
          'reload',
          'backend restart',
          '375px all visited regions visible',
          'generated map and photo fallback images decoded',
          'rendered root stays anchored',
          'no transition camera zoom',
          'Escape',
          'no page errors',
        ],
      },
      null,
      2,
    ),
  );
  console.log('World browser checks passed:', out);
} finally {
  await browser.close();
  backend?.kill('SIGTERM');
  vite?.kill('SIGTERM');
  for (const ws of upstream.clients) ws.terminate();
  upstream.close();
  db.close();
  fs.writeFileSync(path.join(out, 'server.log'), logs);
}
