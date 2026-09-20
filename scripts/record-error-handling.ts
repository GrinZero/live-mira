// API-boundary fault injection. Healthy requests are forwarded to real providers.
// Runs isolated backend/Vite/world; no application UI/state/result injection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import WebSocket, { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { config } from '../server/src/config.js';
import { WorldStore } from '../server/src/world/store.js';

const root = process.cwd();
const out = path.resolve(process.env.OUT_DIR ?? `output/playwright/api-errors-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-api-errors-'));
const token = randomUUID();
const db = new WorldStore(worldDir, config.assetsDir, config.cacheDir);
const initial = db.open(token);
const cafe = initial.locations[0];
// Existing-place fixture only for the deterministic asset-failure/retry chapter.
const outside = {
  ...cafe,
  id: randomUUID(),
  key: 'street_outside',
  name: '屋檐下',
  description: '咖啡馆外的屋檐下',
  url: db.promote(initial.id, '/assets/bg/street_outside.jpg'),
  mapUrl: undefined,
  mapStatus: 'failed' as const,
  x: 420,
  visits: 1,
};
db.arrive(initial.id, 'fixture-outside', cafe.id, outside);
db.arrive(initial.id, 'fixture-return', outside.id, cafe);
db.update(initial.id, 'fixture-entered', 'enter', (w) => {
  w.entered = true;
});
const events: { at: number; name: string; data?: unknown }[] = [];
const chapters: { at: number; title: string; detail: string }[] = [];
const mark = (name: string, data?: unknown) => {
  events.push({ at: Date.now(), name, data });
  fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 2));
  console.log(name, data ?? '');
};
const faults = { chat: 'pass', image: 'pass', tts: false };
const voicePeers = new Set<WebSocket>();
const allSockets = new Set<WebSocket>();
let connectedMain = 0;
const proxy = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const isImage = req.url?.endsWith('/images/generations');
  const isChat = req.url?.endsWith('/chat/completions');
  const mode = isImage ? faults.image : isChat ? faults.chat : 'pass';
  if (mode === 'timeout') {
    mark('api.timeout.begin', { route: req.url });
    res.on('close', () => mark('api.timeout.aborted', { route: req.url }));
    return; // The application's own timeout must abort this request.
  }
  if (mode === '503') {
    await new Promise((r) => setTimeout(r, 1800));
    mark('api.503', { route: req.url });
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'injected_unavailable', message: 'Controlled provider outage for recording' } }),
    );
    return;
  }
  try {
    const upstream = await fetch(`${config.arkBase}${req.url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.seedApiKey}` },
      body,
    });
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
    mark('api.forwarded', { route: req.url, status: upstream.status });
  } catch (error) {
    res.writeHead(502);
    res.end('upstream unavailable');
    mark('api.forward.failed', String(error));
  }
});
const voiceProxy = new WebSocketServer({ server: proxy });
voiceProxy.on('connection', (client) => {
  allSockets.add(client);
  let upstream: WebSocket | undefined;
  const queue: Buffer[] = [];
  let classified = false;
  client.on('message', (data) => {
    const bytes = Buffer.from(data as Buffer);
    if (!classified) {
      const msg = JSON.parse(bytes.toString());
      if (msg.type !== 'session.create') {
        queue.push(bytes);
        return;
      }
      classified = true;
      const main = Array.isArray(msg.session?.tools);
      if (!main && faults.tts) {
        mark('tts.connection.closed', { code: 1011 });
        client.close(1011, 'controlled TTS failure');
        return;
      }
      upstream = new WebSocket(config.duplexUrl, { headers: { 'X-Api-Key': config.doubaoApiKey } });
      allSockets.add(upstream);
      queue.push(bytes);
      upstream.on('open', () => {
        for (const item of queue.splice(0)) upstream!.send(item);
      });
      upstream.on('message', (raw) => {
        if (main) {
          const m = JSON.parse(raw.toString());
          if (m.type === 'session.created' || m.type === 'session.updated') {
            connectedMain++;
            voicePeers.add(upstream!);
            mark('voice.connected', { count: connectedMain });
          }
        }
        if (client.readyState === WebSocket.OPEN) client.send(raw);
      });
      upstream.on('close', (code) => {
        voicePeers.delete(upstream!);
        if (client.readyState === WebSocket.OPEN) client.close(code === 1006 ? 1011 : code, 'upstream closed');
      });
      upstream.on('error', () => {
        if (client.readyState === WebSocket.OPEN) client.close(1011, 'upstream error');
      });
    } else if (upstream?.readyState === WebSocket.OPEN) upstream.send(bytes);
    else queue.push(bytes);
  });
  client.on('close', () => upstream?.close());
  client.on('error', () => upstream?.close());
});
proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const proxyAddress = proxy.address();
assert(proxyAddress && typeof proxyAddress !== 'string');
let backend: ChildProcess | undefined;
let vite: ChildProcess | undefined;
const boot = (file: string, args: string[], env: NodeJS.ProcessEnv, logFile: string, cwd = root) => {
  const log = fs.openSync(path.join(out, logFile), 'w');
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  return child;
};
const waitHttp = async (url: string) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* boot */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Cannot reach ${url}`);
};
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: path.join(out, 'raw'), size: { width: 1440, height: 900 } },
});
await context.addInitScript({
  content: `
  localStorage.setItem('mira.ct', ${JSON.stringify(token)});
  localStorage.setItem('mira.eye', 'off');
  // Silent test input avoids host microphone permission/device side effects.
  // No fake application response or UI state is supplied.
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext(); await ctx.resume();
    return ctx.createMediaStreamDestination().stream;
  };
  localStorage.setItem('mira.eye', 'off');
  window.__recordings = [];
  const originalConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(dest, ...args) {
    const result = originalConnect.call(this, dest, ...args);
    if (dest === this.context.destination) {
      let tap = window.__recordings.find(t => t.context === this.context);
      if (!tap) {
        const stream = this.context.createMediaStreamDestination();
        const recorder = new MediaRecorder(stream.stream, { mimeType: 'audio/webm;codecs=opus' });
        tap = { context: this.context, stream, recorder, chunks: [], at: Date.now() };
        recorder.ondataavailable = e => { if(e.data.size) tap.chunks.push(e.data); };
        recorder.start(100);
        window.__recordings.push(tap);
      }
      originalConnect.call(this, tap.stream);
    }
    return result;
  };
  window.__saveAudio = async () => Promise.all(window.__recordings.map(async t => {
    await new Promise(resolve => { t.recorder.onstop = resolve; t.recorder.stop(); });
    const bytes = new Uint8Array(await new Blob(t.chunks).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i+32768));
    return { at: t.at, base64: btoa(binary) };
  }));`,
});
const videoStart = Date.now();
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const state = () =>
  page.evaluate(() => {
    const s = (window as any).__store.getState();
    return {
      phase: s.phase,
      bgKey: s.bgKey,
      toast: s.toast,
      generating: s.generating,
      sceneTransition: s.sceneTransition,
      subtitles: s.subtitles,
      world: s.world,
    };
  });
const waitIdle = () =>
  page.waitForFunction(() => ['listening', 'idle'].includes((window as any).__store.getState().phase), undefined, {
    timeout: 60000,
  });
const type = async (text: string) => {
  await page.getByRole('textbox', { name: '对 Mira 说' }).fill(text);
  await page.waitForTimeout(1100);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  mark('user.text', text);
};
const waitReply = async (text: string, timeout = 80000) => {
  await page.waitForFunction(
    (t) => {
      const s = (window as any).__store.getState();
      const index = s.subtitles.findIndex((x: any) => x.who === 'user' && x.text === t);
      return (
        index >= 0 &&
        s.subtitles.slice(index + 1).some((x: any) => x.who === 'mira' && x.text.length > 5) &&
        s.phase === 'speaking'
      );
    },
    text,
    { timeout },
  );
  await page.waitForTimeout(2000);
  await waitIdle();
};
const chapter = (title: string, detail: string) => {
  chapters.push({ at: Date.now(), title, detail });
  mark('chapter', title);
};
const screenshot = (name: string) => page.screenshot({ path: path.join(out, `${name}.png`) });
let raw: string;
let audio: { at: number; base64: string }[];
let success = false;
try {
  assert(config.doubaoApiKey && config.seedApiKey, 'Real provider keys required');
  backend = boot(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'server/src/index.ts'],
    {
      PORT: '8796',
      WORLD_DATA_DIR: worldDir,
      MAP_IMAGES: '0',
      RECORD: '0',
      ACCESS_TOKENS: ' ',
      ARK_BASE: `http://127.0.0.1:${proxyAddress.port}`,
      DUPLEX_URL: `ws://127.0.0.1:${proxyAddress.port}`,
    },
    'server.log',
  );
  vite = boot(
    process.execPath,
    [path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5196', '--strictPort'],
    { VITE_SERVER_TARGET: 'http://127.0.0.1:8796' },
    'vite.log',
    path.join(root, 'web'),
  );
  await Promise.all([waitHttp('http://127.0.0.1:8796/api/health'), waitHttp('http://127.0.0.1:5196')]);
  await page.goto('http://127.0.0.1:5196');
  await page.locator('.enter-btn:not([disabled])').click({ timeout: 60000 });
  await page.getByRole('textbox', { name: '对 Mira 说' }).waitFor();
  await page.waitForTimeout(9000);
  await waitIdle();
  // 1: Force injected-input TTS to fail, then exercise real director HTTP timeout.
  chapter('01 / 回应 API 超时', '服务层故障注入：TTS 辅路断开 + 导演请求超时；观察提示和重试');
  faults.tts = true;
  faults.chat = 'timeout';
  const timeoutText = '我叫小林。你喜欢雨天还是晴天？';
  await type(timeoutText);
  await page.getByText('刚才你说什么？我没听清。', { exact: false }).first().waitFor({ timeout: 65000 });
  mark('timeout.fallback.visible');
  await screenshot('01-api-timeout');
  assert(events.some((e) => e.name === 'api.timeout.aborted'));
  await page.waitForTimeout(2000);
  await waitIdle();
  faults.chat = 'pass';
  faults.tts = false;
  const retryText = '那我再问一次，你喜欢雨天还是晴天？';
  await type(retryText);
  await waitReply(retryText);
  mark('timeout.recovered', await state());
  await screenshot('02-api-recovered');
  // 2: Fail actual image API requests, including retries; never change location.
  chapter('02 / 生图 API 返回 503', '服务层故障注入：实际生图请求失败；保留原地点并结束加载');
  faults.image = '503';
  const before = await state();
  const explore = '我们现在一起出发，去咖啡馆旁边小巷尽头的蓝色旧书店门口避雨，走吧。';
  await type(explore);
  await page
    .getByText('画面暂时没准备好，我们还在原处。可以继续聊，或再试一次。', { exact: true })
    .waitFor({ timeout: 120000 });
  const failedImage = await state();
  assert.equal(failedImage.bgKey, before.bgKey);
  assert.equal(failedImage.world.currentLocationId, before.world.currentLocationId);
  assert.equal(failedImage.sceneTransition, null);
  assert.equal(failedImage.generating.length, 0);
  assert(events.filter((e) => e.name === 'api.503').length >= 2, 'Image retries must really reach API');
  mark('image.degraded', failedImage);
  await screenshot('03-image-api-failed');
  await page.waitForTimeout(4000);
  await waitIdle();
  faults.image = 'pass';
  const stay = '没关系，那我们先留在咖啡馆聊聊。你平时用什么相机？';
  await type(stay);
  await waitReply(stay);
  mark('image.conversation.continues');
  // 3: Saved scene image HTTP failure, then retry with the same durable asset.
  chapter('03 / 场景图片 HTTP 404', '资源层故障注入：图片打不开时留在原处；解除故障后重新进入');
  const mediaBefore = await state();
  const assetPath = new URL(outside.url, 'http://local').pathname;
  let deniedAssets = 0;
  await page.route(
    (url) => url.pathname === assetPath,
    async (route) => {
      deniedAssets++;
      mark('media.http404', { path: assetPath });
      await route.fulfill({ status: 404, body: 'controlled missing image' });
    },
  );
  const goOutside = async () => {
    await page.locator('.world-map-opener').click();
    await page.locator('.world-map-region').filter({ hasText: '屋檐下' }).click();
    await page.getByRole('button', { name: '回到屋檐下', exact: true }).click();
    const close = page.getByRole('button', { name: '关闭地图', exact: true });
    if (await close.isVisible()) await close.click();
  };
  await goOutside();
  await page.getByText('新画面暂时打不开，我们还在原处。', { exact: true }).waitFor({ timeout: 20000 });
  const failedMedia = await state();
  assert(deniedAssets > 0);
  assert.equal(failedMedia.bgKey, mediaBefore.bgKey);
  assert.equal(failedMedia.world.currentLocationId, mediaBefore.world.currentLocationId);
  mark('media.degraded', failedMedia);
  await screenshot('04-media-failed');
  await page.waitForTimeout(4000);
  await page.unrouteAll();
  await goOutside();
  await page.waitForFunction(
    (id) =>
      (window as any).__store.getState().world.currentLocationId === id &&
      !(window as any).__store.getState().sceneTransition,
    outside.id,
    { timeout: 30000 },
  );
  mark('media.recovered', await state());
  await screenshot('05-media-recovered');
  await page.waitForTimeout(4000);
  // 4: Drop actual upstream voice connection; observe reconnect and next real reply.
  chapter('04 / 语音服务连接中断', '连接层故障注入：关闭上游 WebSocket；观察重连后恢复交流');
  const connectionCount = connectedMain;
  assert(voicePeers.size > 0);
  for (const ws of voicePeers) ws.close(1011, 'controlled upstream disconnect');
  mark('voice.injected-close');
  await page.getByText('语音链路中断，重连中…', { exact: true }).waitFor({ timeout: 15000 });
  await screenshot('06-voice-disconnected');
  for (let i = 0; i < 100 && connectedMain <= connectionCount; i++) await page.waitForTimeout(200);
  assert(connectedMain > connectionCount, 'A new real upstream session must connect');
  await page.waitForTimeout(3000);
  const resumed = '刚才断了一下，现在能听到吗？我们继续聊吧。';
  await type(resumed);
  await waitReply(resumed);
  mark('voice.recovered', await state());
  await screenshot('07-voice-recovered');
  assert.equal(errors.length, 0);
  await page.waitForTimeout(2500);
  success = true;
} catch (error) {
  mark('FAILED', String(error));
  await screenshot('failure').catch(() => {});
  throw error;
} finally {
  audio = (await page.evaluate('window.__saveAudio()').catch(() => [])) as { at: number; base64: string }[];
  fs.writeFileSync(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        ok: success,
        videoStart,
        chapters,
        events,
        errors,
        faultsAtBoundary: true,
        liveProvidersWhenHealthy: true,
        seededSavedPlace: true,
        silentMicInput: true,
      },
      null,
      2,
    ),
  );
  audio.forEach((t, i) => fs.writeFileSync(path.join(out, `audio-${i}.webm`), Buffer.from(t.base64, 'base64')));
  await context.close();
  raw = await page.video()!.path();
  await browser.close();
  backend?.kill('SIGTERM');
  vite?.kill('SIGTERM');
  db.close();
  for (const socket of allSockets) socket.terminate();
  voiceProxy.close();
  proxy.closeAllConnections();
  proxy.close();
}
const inputs = ['-i', raw];
const filters: string[] = [];
audio.forEach((track, i) => {
  inputs.push('-i', path.join(out, `audio-${i}.webm`));
  filters.push(`[${i + 1}:a]adelay=${Math.max(0, track.at - videoStart)}:all=1[a${i}]`);
});
assert(audio.length);
filters.push(`${audio.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audio.length}:normalize=0,apad[audio]`);
filters.push('[0:v]pad=1440:1000:0:100:black[v0]');
for (let i = 0; i < chapters.length; i++) {
  const c = chapters[i];
  const banner = path.join(out, `chapter-${i}.png`);
  await sharp(
    Buffer.from(
      `<svg width="1440" height="100"><rect width="1440" height="100" fill="#101827"/><text x="32" y="40" font-family="sans-serif" font-size="28" fill="#ffffff">${c.title}</text><text x="32" y="77" font-family="sans-serif" font-size="20" fill="#c5ceda">${c.detail}</text></svg>`,
    ),
  )
    .png()
    .toFile(banner);
  inputs.push('-loop', '1', '-i', banner);
  const start = (c.at - videoStart) / 1000;
  const end = i + 1 < chapters.length ? (chapters[i + 1].at - videoStart) / 1000 : 9999;
  filters.push(
    `[v${i}][${audio.length + 1 + i}:v]overlay=0:0:enable='between(t,${start},${end})':shortest=1[v${i + 1}]`,
  );
}
execFileSync('ffmpeg', [
  '-y',
  '-v',
  'error',
  ...inputs,
  '-filter_complex',
  filters.join(';'),
  '-map',
  `[v${chapters.length}]`,
  '-map',
  '[audio]',
  '-c:v',
  'libx264',
  '-preset',
  'fast',
  '-crf',
  '20',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '160k',
  '-shortest',
  '-movflags',
  '+faststart',
  path.join(out, 'api-error-handling.mp4'),
]);
console.log('DELIVERABLE', path.join(out, 'api-error-handling.mp4'));
