import { planForeground } from '../shared/foreground-layout.js';
import { splitForeground, validateForegroundMask, extendBehindMask } from '../server/src/foreground.js';
import { sceneFrame, SCENE_LAYOUT, randomSceneLayout, layoutToken, layoutFromUrl } from '../shared/scene-layout.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { buildMediaPrompt, createGenImg } from '../server/src/genimg.js';
import { loadContent } from '../server/src/content.js';
import { config } from '../server/src/config.js';
import type { MediaEvent } from '../shared/protocol.js';

const content = loadContent();
test('media prompts retain the subject and do not force anime art', () => {
  for (const kind of ['photo', 'scene', 'overlay'] as const) {
    const prompt = buildMediaPrompt(kind, content.styleTemplate, {}, '极光下的雪山', {});
    assert.doesNotMatch(prompt, /统一的日系二次元|须使用统一的二次元/);
    assert.match(prompt, /极光下的雪山/);
  }
});

test('separate photo and moment events request fresh images, including concurrent calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-genimg-'));
  const originalDir = config.cacheDir;
  const originalFetch = globalThis.fetch;
  config.cacheDir = dir;
  const pixels = Buffer.alloc(1024 * 1024 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + (i >> 8)) % 256;
  const bytes = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 3 } })
    .png()
    .toBuffer();
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/images/generations')) {
      calls++;
      assert.match(JSON.parse(String(init?.body)).prompt, /极光下的雪山/);
      return Response.json({ data: [{ url: 'https://image.test/generated', size: '1024x1024' }] });
    }
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
  try {
    const events: MediaEvent[] = [];
    let terminalCount = 2;
    let settle: (() => void) | undefined;
    const gen = createGenImg({
      ...content,
      sendMedia: (e) => {
        events.push(e);
        if (events.filter((e) => e.status === 'ready' || e.status === 'failed').length === terminalCount) settle?.();
      },
      onDegrade: () => {},
    });
    for (const kind of ['photo', 'overlay'] as const) {
      events.length = 0;
      terminalCount = 2;
      const opts = kind === 'overlay' ? { overlay: { base: 'test', file: path.join(dir, 'base.png') } } : {};
      fs.writeFileSync(path.join(dir, 'base.png'), bytes);
      const done = new Promise<void>((resolve) => {
        settle = resolve;
      });
      gen.generate(kind, '极光下的雪山', opts);
      gen.generate(kind, '极光下的雪山', opts);
      await done;
      const ready = events.filter((e) => e.status === 'ready');
      assert.equal(ready.length, 2);
      assert.notEqual(ready[0].url, ready[1].url);
      assert.ok(ready.every((e) => !e.cached));
      terminalCount = 3;
      const later = new Promise<void>((resolve) => {
        settle = resolve;
      });
      gen.generate(kind, '极光下的雪山', opts);
      await later;
      const allReady = events.filter((e) => e.status === 'ready');
      assert.equal(new Set(allReady.map((e) => e.url)).size, 3);
      assert.ok(allReady.every((e) => !e.cached));
    }
    assert.equal(calls, 6);
  } finally {
    globalThis.fetch = originalFetch;
    config.cacheDir = originalDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only scene prompts reserve a standing space; edits preserve the source', () => {
  const prompt = (kind: MediaEvent['kind']) => buildMediaPrompt(kind, content.styleTemplate, {}, '雪山', {});
  assert.match(prompt('scene'), /40%.*80%.*地面锚点/);
  assert.match(prompt('scene'), /写实电影/);
  assert.doesNotMatch(prompt('photo'), /地面锚点|赛璐璐/);
  assert.match(prompt('foreground'), /不要重画中远景/);
  assert.match(prompt('overlay'), /保留参考图原有风格/);
});

test('responsive crop and actor use the same source ground point', () => {
  for (const [w, h] of [
    [2048, 1066],
    [390, 844],
    [1440, 900],
  ]) {
    const f = sceneFrame(w, h);
    assert.ok(f.left <= 0 && f.top <= 0);
    assert.ok(f.width + f.left >= w && f.height + f.top >= h);
    assert.equal(f.actorX * w, f.left + f.width * SCENE_LAYOUT.x);
    assert.equal(f.footY * h, f.top + f.height * SCENE_LAYOUT.footY);
    assert.ok(f.footY < 0.9 && f.footY - f.actorHeight > 0);
    assert.ok(f.actorHeight >= 0.6);
  }
});

test('scene requests send a visual guide and never retry as text-only generation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-guide-'));
  const previousDir = config.cacheDir;
  const previousFetch = globalThis.fetch;
  config.cacheDir = dir;
  const requests: { image?: string; prompt: string; size: string }[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('fixture image editing failure', { status: 400 });
  }) as typeof fetch;
  try {
    await new Promise<void>((resolve) => {
      createGenImg({
        ...content,
        onDegrade: () => {},
        sendMedia: (e) => {
          if (e.status === 'failed') resolve();
        },
      }).generate('scene', '雨后的街道', { sceneKey: 'guide_test' });
    });
    assert.equal(requests.length, 2);
    for (const request of requests) {
      assert.match(request.image ?? '', /^data:image\/png;base64,/);
      assert.match(request.prompt, /紫红色矩形框/);
      assert.equal(request.size, '2560x1440');
      const guide = Buffer.from(request.image!.split(',')[1], 'base64');
      const meta = await sharp(guide).metadata();
      assert.deepEqual([meta.width, meta.height], [2560, 1440]);
    }
  } finally {
    config.cacheDir = previousDir;
    globalThis.fetch = previousFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('random scene boxes vary, remain bounded and keep 60% viewport height', () => {
  const layouts = [0, 0.1, 0.5, 0.9, 1].map((n) => randomSceneLayout(() => n));
  assert.equal(new Set(layouts.map(layoutToken)).size, 5);
  for (const layout of layouts) {
    assert.deepEqual(layoutFromUrl(`/media/scene_test_${layoutToken(layout)}.jpg`), layout);
    assert.ok(layout.x - 0.08 > 0 && layout.x + 0.08 < 1);
    assert.ok(layout.footY - layout.actorHeight > 0 && layout.footY < 1);
    for (const [w, h] of [
      [390, 844],
      [360, 800],
      [1440, 900],
      [2048, 1066],
      [3440, 1440],
      [844, 390],
    ]) {
      const f = sceneFrame(w, h, layout);
      assert.equal(f.actorHeight, 0.6);
      assert.ok(f.footY - f.actorHeight >= 0.1 && f.footY <= 0.9);
      const halfWidth = (h * f.actorHeight * 0.22) / w;
      assert.ok(f.actorX - halfWidth >= 0.03 && f.actorX + halfWidth <= 0.97);
      assert.ok(Math.abs(f.actorX * w - (f.left + f.width * layout.x)) < 1e-8);
      assert.ok(Math.abs(f.footY * h - (f.top + f.height * layout.footY)) < 1e-8);
    }
  }
  assert.equal(layoutFromUrl('/media/scene_stage3_999_999.jpg'), null);
});

test('new scenes receive different guide positions and revisits reuse the same image and layout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-random-scenes-'));
  const oldDir = config.cacheDir;
  const oldFetch = globalThis.fetch;
  config.cacheDir = dir;
  const pixels = Buffer.alloc(2560 * 1440 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + (i >> 8)) % 256;
  const bytes = await sharp(pixels, { raw: { width: 2560, height: 1440, channels: 3 } })
    .jpeg()
    .toBuffer();
  const guides: string[] = [];
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/images/generations')) {
      calls++;
      const request = JSON.parse(String(init?.body));
      if (request.image.startsWith('data:image/png;')) guides.push(request.image);
      return Response.json({ data: [{ url: 'https://image.test/scene' }] });
    }
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
  try {
    let resolveEvent: (e: MediaEvent) => void = () => {};
    const samples = [0.1, 0.2, 0.8, 0.9];
    const gen = createGenImg({
      layoutRandom: () => samples.shift()!,
      ...content,
      onDegrade: () => {},
      sendMedia: (e) => {
        if (e.status === 'ready' || e.status === 'failed') resolveEvent(e);
      },
    });
    const generate = (theme: string) =>
      new Promise<MediaEvent>((resolve) => {
        resolveEvent = resolve;
        gen.generate('scene', theme);
      });
    const a = await generate('海边的街道');
    const b = await generate('山间的步道');
    assert.equal(a.status, 'ready');
    assert.equal(b.status, 'ready');
    assert.ok(layoutFromUrl(a.url!));
    assert.ok(layoutFromUrl(b.url!));
    assert.equal(guides.length, 2);
    assert.notEqual(guides[0], guides[1]);
    const revisit = await generate('海边的街道');
    assert.equal(revisit.url, a.url);
    assert.equal(revisit.cached, true);
    assert.equal(calls, 4);
  } finally {
    config.cacheDir = oldDir;
    globalThis.fetch = oldFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('foreground is opt-in for near framing objects, not automatic for scenery', () => {
  assert.equal(planForeground('开阔海边步道，远处栏杆和长椅', SCENE_LAYOUT), null);
  assert.equal(planForeground('雨夜街道', SCENE_LAYOUT), null);
  assert.equal(planForeground('门廊，不需要前景', SCENE_LAYOUT), null);
  assert.equal(planForeground('在木门廊下看雨', SCENE_LAYOUT)?.side, 'right');
  assert.equal(planForeground('在木门廊下看雨', { ...SCENE_LAYOUT, x: 0.7 })?.side, 'left');
});

test('foreground split keeps source RGB, alpha holes, actor protection and immutable background pixels', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-layers-'));
  const layout = { ...SCENE_LAYOUT, width: 640, height: 360 };
  const plan = planForeground('门廊', layout)!;
  const image = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#a05020' } })
    .png()
    .toBuffer();
  const mask = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="black"/><rect x="340" width="26" height="360" fill="white"/><rect x="350" width="290" height="30" fill="white"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const fill = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#304060' } })
    .png()
    .toBuffer();
  let calls = 0;
  try {
    const result = await splitForeground(image, layout, plan, path.join(dir, 'test'), async () =>
      ++calls === 1 ? mask : fill,
    );
    const pixel = async (buffer: Buffer, x: number, y: number) => [
      ...(await sharp(buffer).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()),
    ];
    assert.deepEqual(await pixel(result.foreground, 350, 100), [160, 80, 32, 255]);
    assert.equal((await pixel(result.foreground, 250, 100))[3], 0);
    assert.deepEqual(await pixel(result.background, 250, 100), [160, 80, 32, 255]);
    assert.deepEqual(await pixel(result.background, 350, 100), [48, 64, 96, 255]);
    const bad = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer();
    await assert.rejects(validateForegroundMask(bad, layout, plan), /coverage/);
    const overlaps = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="black"/><rect x="240" y="70" width="30" height="200" fill="white"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await assert.rejects(validateForegroundMask(overlaps, layout, plan), /overlaps_actor/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hidden near object is removed by edge continuation when image editing repeats it', async () => {
  const w = 80,
    h = 40;
  const source = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="80" height="40" fill="#304060"/><rect x="38" width="5" height="40" fill="#a05020"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const mask = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="80" height="40" fill="black"/><rect x="38" width="5" height="40" fill="white"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const out = await extendBehindMask(source, mask, { ...SCENE_LAYOUT, width: w, height: h });
  const p = [...(await sharp(out).extract({ left: 40, top: 20, width: 1, height: 1 }).raw().toBuffer())];
  assert.deepEqual(p, [48, 64, 96]);
});
