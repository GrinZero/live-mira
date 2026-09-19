import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorldStore } from '../server/src/world/store.js';
import type { WorldLocation, WorldObject } from '../shared/world.js';
import type { DownMessage, MediaEvent } from '../shared/protocol.js';

const OWNER = 'world-test-owner-0001';
const OTHER = 'world-test-owner-0002';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-world-test-'));
  const dir = path.join(root, 'worlds');
  const assets = path.join(root, 'assets');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(path.join(assets, 'bg'), { recursive: true });
  fs.mkdirSync(path.join(cache, 'media'), { recursive: true });
  let store = new WorldStore(dir, assets, cache);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    dir,
    assets,
    cache,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new WorldStore(dir, assets, cache);
      return store;
    },
  };
}

function destination(key = 'bridge'): WorldLocation {
  return {
    id: randomUUID(),
    key,
    name: key,
    description: `The ${key}`,
    url: `/assets/bg/${key}.jpg`,
    firstVisitedAt: 0,
    lastVisitedAt: 0,
    visits: 0,
    x: -999,
    y: -999,
    mapStatus: 'ready',
    environment: { rain: 0, dim: 0.4 },
  };
}

test('world persists identity, entry, scene, memory, environment and revision across database reopen', (t) => {
  const f = fixture(t);
  assert.equal(f.store.hasStory(OWNER), false);
  const w = f.store.open(OWNER);
  assert.equal(f.store.hasStory(OWNER), false);
  assert.deepEqual(f.store.view(w.id).locations, []);
  f.store.update(w.id, 'enter', 'enter', (saved) => {
    saved.entered = true;
    saved.memory = [{ role: 'user', text: 'Meet me at the bridge', ts: 123, interrupted: true }];
    saved.locations[0].environment = { rain: 0, dim: 1 };
  });
  const target = destination();
  const arrived = f.store.arrive(w.id, 'trip-1', w.currentLocationId, target);
  assert.notEqual(arrived.sceneInstanceId, w.sceneInstanceId);
  const view = f.store.view(w.id);
  assert.equal(view.locations.length, 2);
  assert.equal('access' in view, false);
  assert.equal('memory' in view, false);
  assert.deepEqual(f.reopen().open(OWNER), arrived);
  assert.equal(f.store.hasStory(OWNER), true);
  assert.deepEqual(f.store.view(w.id), view);
});

test('owners have independent active worlds and access capabilities', (t) => {
  const f = fixture(t);
  const a = f.store.open(OWNER);
  const b = f.store.open(OTHER);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.access, b.access);
  f.store.update(a.id, 'private-memory', 'memory', (w) => {
    w.memory.push({ role: 'user', text: 'owner A only', ts: 1 });
  });
  f.reopen();
  assert.equal(f.store.open(OWNER).memory[0].text, 'owner A only');
  assert.deepEqual(f.store.open(OTHER), b);
  for (const token of ['', 'short', 'x'.repeat(257)]) assert.throws(() => f.store.open(token));
});

test('fresh replaces only the owner active pointer and archives the complete old world', (t) => {
  const f = fixture(t);
  const old = f.store.open(OWNER);
  const other = f.store.open(OTHER);
  const saved = f.store.update(old.id, 'enter', 'enter', (w) => {
    w.entered = true;
  });
  const fresh = f.store.open(OWNER, true);
  assert.notEqual(fresh.id, old.id);
  assert.notEqual(fresh.access, old.access);
  assert.equal(fresh.revision, 0);
  assert.equal(fresh.entered, false);
  assert.deepEqual(fresh.memory, []);
  assert.deepEqual(fresh.objects, []);
  f.reopen();
  assert.deepEqual(f.store.open(OWNER), fresh);
  assert.deepEqual(f.store.read(old.id), saved);
  assert.deepEqual(f.store.open(OTHER), other);
});

test('arrival event is idempotent even after reopen and later travel', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  const target = destination();
  const first = f.store.arrive(w.id, 'arrival', w.currentLocationId, target);
  assert.equal(first.locations[1].visits, 1);
  assert.deepEqual(f.store.arrive(w.id, 'arrival', w.currentLocationId, target), first);
  f.reopen();
  assert.deepEqual(f.store.arrive(w.id, 'arrival', w.currentLocationId, target), first);
  const back = f.store.arrive(w.id, 'back', target.id, w.locations[0]);
  assert.deepEqual(f.store.arrive(w.id, 'arrival', w.currentLocationId, target), back);
});

test('stale origin rejects atomically and does not consume the rejected event ID', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  const bridge = destination();
  const park = destination('park');
  const first = f.store.arrive(w.id, 'bridge', w.currentLocationId, bridge);
  assert.throws(() => f.store.arrive(w.id, 'park', w.currentLocationId, park), /地点已经变化/);
  assert.deepEqual(f.reopen().read(w.id), first);
  const next = f.store.arrive(w.id, 'park', bridge.id, park);
  assert.equal(next.revision, first.revision + 1);
  assert.equal(next.currentLocationId, park.id);
});

test('throwing update rolls back nested mutations and permits retry', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  assert.throws(
    () =>
      f.store.update(w.id, 'retry', 'entry', (draft) => {
        draft.locations[0].visits = 500;
        draft.memory.push({ role: 'mira', text: 'must not persist', ts: 0 });
        throw new Error('fixture failure');
      }),
    /fixture failure/,
  );
  assert.deepEqual(f.reopen().read(w.id), w);
  assert.equal(
    f.store.update(w.id, 'retry', 'entry', (draft) => {
      draft.entered = true;
    }).revision,
    1,
  );
});

test('repeated returns preserve layout, first visit, media and environment without duplicate edges', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  const targets = Array.from({ length: 10 }, (_, i) => destination(`place-${i}`));
  let current = w;
  for (const target of targets) current = f.store.arrive(w.id, randomUUID(), current.currentLocationId, target);
  const stable = current.locations.map((l) => ({ ...l }));
  assert.equal(new Set(stable.map((l) => `${l.x},${l.y}`)).size, stable.length);
  const last = targets.at(-1)!;
  for (let i = 0; i < 3; i++) {
    f.store.arrive(w.id, `home-${i}`, last.id, w.locations[0]);
    current = f.store.arrive(w.id, `return-${i}`, w.currentLocationId, {
      ...last,
      x: 9000,
      y: 9000,
      url: '/incorrect.jpg',
      environment: { rain: 9, dim: 9 },
    });
  }
  assert.equal(current.locations.length, 11);
  assert.equal(current.connections.length, 11);
  assert.equal(current.locations[0].visits, 4);
  assert.equal(current.locations.at(-1)!.visits, 4);
  for (const old of stable) {
    const now = current.locations.find((l) => l.id === old.id)!;
    assert.deepEqual(
      [now.x, now.y, now.firstVisitedAt, now.url, now.environment],
      [old.x, old.y, old.firstVisitedAt, old.url, old.environment],
    );
    assert.ok(now.lastVisitedAt >= old.lastVisitedAt);
  }
  assert.deepEqual(f.reopen().open(OWNER), current);
});

test('promoted generated media survives cache deletion and store reopen', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  const bytes = Buffer.from('generated-image-fixture');
  fs.writeFileSync(path.join(f.cache, 'media', 'scene.jpeg'), bytes);
  const url = f.store.promote(w.id, '/media/scene.jpeg');
  assert.equal(f.store.promote(w.id, '/media/scene.jpeg'), url);
  f.store.update(w.id, 'media', 'media', (draft) => {
    draft.locations[0].url = url;
  });
  fs.rmSync(f.cache, { recursive: true });
  const restored = f.reopen().open(OWNER);
  const parsed = new URL(restored.locations[0].url, 'http://fixture');
  const file = f.store.assetFile(parsed.pathname, parsed.searchParams.get('access')!);
  assert.ok(file);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(f.store.promote(w.id, url), url);
  fs.writeFileSync(path.join(f.assets, 'bg', 'base.png'), bytes);
  assert.match(f.store.promote(w.id, '/assets/bg/base.png'), /\.png\?access=/);
});

test('scene layout version survives promotion and restoring the world', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  fs.writeFileSync(path.join(f.cache, 'media', 'scene_street_stage2_hash.jpg'), Buffer.from('staged'));
  const url = f.store.promote(w.id, '/media/scene_street_stage2_hash.jpg');
  assert.match(url, /&layout=stage2$/);
  f.store.update(w.id, 'staged', 'media', (draft) => {
    draft.locations[0].url = url;
  });
  const saved = f.reopen().open(OWNER).locations[0].url;
  assert.equal(saved, url);
  const parsed = new URL(saved, 'http://fixture');
  assert.ok(f.store.assetFile(parsed.pathname, parsed.searchParams.get('access')!));
});

test('asset resolver rejects wrong owner, malformed capabilities and path traversal', (t) => {
  const f = fixture(t);
  const a = f.store.open(OWNER);
  const b = f.store.open(OTHER);
  const url = new URL(f.store.saveAsset(a.id, Buffer.from('asset')), 'http://fixture');
  assert.ok(f.store.assetFile(url.pathname, a.access));
  for (const token of [b.access, '', '0'.repeat(64), a.access.slice(1), 'g'.repeat(64)]) {
    assert.equal(f.store.assetFile(url.pathname, token), null);
  }
  for (const pathname of [
    `/media/world/${a.id}/../worlds.sqlite`,
    `/media/world/${a.id}/%2e%2e%2fworlds.sqlite`,
    `/media/world/${a.id}/..\\worlds.sqlite`,
    `${url.pathname}/../../worlds.sqlite`,
    url.pathname.replace(a.id, randomUUID()),
    `${url.pathname}%00.jpg`,
  ])
    assert.equal(f.store.assetFile(pathname, a.access), null, pathname);
  for (const source of [
    '/media/../worlds.sqlite',
    '/assets/bg/../../secret.jpg',
    '/media/%2e%2e/secret.jpg',
    'https://example.com/image.jpg',
  ]) {
    assert.throws(() => f.store.promote(a.id, source));
  }
  assert.throws(() => f.store.saveAsset(a.id, Buffer.from('asset'), '../bad'));
});

test('object location ownership and character hand ownership persist across travel and reopen', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  const other = f.store.open(OTHER);
  const objects: WorldObject[] = [
    {
      id: 'photo',
      kind: 'photo',
      caption: 'Our bridge',
      url: f.store.saveAsset(w.id, Buffer.from('photo')),
      owner: { kind: 'location', locationId: w.currentLocationId, anchor: 'table' },
    },
    { id: 'cup', kind: 'cup', owner: { kind: 'character', hand: 'left' } },
    { id: 'phone', kind: 'phone', owner: { kind: 'character', hand: 'right' } },
  ];
  f.store.update(w.id, 'objects', 'objects', (draft) => {
    draft.objects = objects;
  });
  const target = destination();
  f.store.arrive(w.id, 'travel', w.currentLocationId, target);
  assert.deepEqual(f.reopen().open(OWNER).objects, objects);
  assert.deepEqual(f.store.open(OTHER).objects, []);
  assert.deepEqual(f.store.read(other.id), other);
  const moved = f.store.update(w.id, 'move-cup', 'object.move', (draft) => {
    draft.objects[1].owner = { kind: 'location', locationId: target.id, anchor: 'bench' };
  });
  assert.deepEqual(f.reopen().open(OWNER).objects, moved.objects);
});

test('session travel handshake uses isolated storage without startup, providers or map jobs', async (t) => {
  const f = fixture(t);
  const { config } = await import('../server/src/config.js');
  const original = {
    worldDir: config.worldDir,
    assetsDir: config.assetsDir,
    cacheDir: config.cacheDir,
    seedApiKey: config.seedApiKey,
  };
  Object.assign(config, { worldDir: f.dir, assetsDir: f.assets, cacheDir: f.cache, seedApiKey: '' });
  const { worldStore } = await import('../server/src/world/runtime.js');
  const { ClientSession } = await import('../server/src/session.js');
  const db = worldStore();
  t.after(() => {
    db.close();
    Object.assign(config, original);
  });
  // Bypass constructors/start entirely: only the real state/ACK handlers run.
  // Every region is already ready, so drawVisitedRegions has no work to enqueue.
  function session() {
    const w = db.open(randomUUID());
    db.update(w.id, 'enter', 'enter', (draft) => {
      draft.entered = true;
      draft.locations[0].mapStatus = 'ready';
    });
    const target = destination();
    db.arrive(w.id, 'seed-visit', w.currentLocationId, target);
    const messages: DownMessage[] = [];
    const s = Object.create(ClientSession.prototype) as any;
    Object.assign(s, {
      worldId: w.id,
      entered: true,
      alive: true,
      worldError: false,
      travelIntents: new Set(),
      currentSceneUrl: target.url,
      latestSceneRequest: '',
      director: { noteUserActivity() {}, onMediaSettled() {}, sceneFailed() {}, sceneReady() {} },
      handleInterrupt() {},
      send(message: DownMessage) {
        messages.push(message);
      },
    });
    t.after(() => {
      if (s.travelTimer) clearTimeout(s.travelTimer);
    });
    return { s, w, messages };
  }
  await t.test('opening a map re-sends current visited locations without mutating the world', async () => {
    const { s, w, messages } = session();
    const before = db.read(w.id);
    await s.onClientMessage({ type: 'map.open', open: true });
    assert.equal(s.mapOpen, true);
    const snapshot = messages.find((m) => m.type === 'world');
    assert(snapshot?.type === 'world');
    assert.equal(snapshot.world.locations.length, 2);
    assert.equal(snapshot.world.currentLocationId, before.currentLocationId);
    assert.deepEqual(db.read(w.id), before);
  });
  await t.test('cancel before ACK, late ACK and failed preload do not record a visit', async () => {
    const { s, w, messages } = session();
    const before = db.read(w.id);
    await s.onClientMessage({ type: 'travel.request', locationId: w.currentLocationId, intentId: 'return' });
    const id = s.travel.id;
    assert.deepEqual(db.read(w.id), before);
    await s.onClientMessage({ type: 'travel.cancel', id: 'wrong-id' });
    assert.equal(s.travel.id, id);
    await s.onClientMessage({ type: 'travel.cancel', id });
    await s.onClientMessage({ type: 'scene.presented', id, ok: true });
    assert.equal(s.travel, undefined);
    assert.deepEqual(db.read(w.id), before);
    assert.ok(messages.some((m) => m.type === 'travel.cancelled' && m.id === id));
    await s.onClientMessage({ type: 'travel.request', locationId: w.currentLocationId, intentId: 'failed' });
    await s.onClientMessage({ type: 'scene.presented', id: s.travel.id, ok: false });
    assert.deepEqual(db.read(w.id), before);
  });
  await t.test('duplicate intent and ACK commit one visit; world is published before committed scene', async () => {
    const { s, w, messages } = session();
    const before = db.read(w.id);
    const request = { type: 'travel.request', locationId: w.currentLocationId, intentId: 'return' };
    await s.onClientMessage(request);
    const id = s.travel.id;
    await s.onClientMessage(request);
    assert.equal(s.travel.id, id);
    await s.onClientMessage({ type: 'scene.presented', id: 'stale', ok: true });
    assert.deepEqual(db.read(w.id), before);
    messages.length = 0;
    await s.onClientMessage({ type: 'scene.presented', id, ok: true });
    const committed = db.read(w.id);
    assert.equal(committed.revision, before.revision + 1);
    assert.equal(committed.locations[0].visits, 2);
    assert.equal(committed.currentLocationId, w.currentLocationId);
    const worldIndex = messages.findIndex((m) => m.type === 'world');
    const sceneIndex = messages.findIndex((m) => m.type === 'media.event' && m.event.committed);
    assert.ok(worldIndex >= 0 && sceneIndex > worldIndex);
    await s.onClientMessage({ type: 'scene.presented', id, ok: true });
    await s.onClientMessage(request);
    assert.equal(s.travel, undefined);
    assert.deepEqual(db.read(w.id), committed);
  });
  await t.test('origin changed during preparation rejects ACK without overwriting new location', async () => {
    const { s, w, messages } = session();
    await s.onClientMessage({ type: 'travel.request', locationId: w.currentLocationId, intentId: 'return' });
    const id = s.travel.id;
    const current = db.read(w.id);
    const changed = db.arrive(w.id, 'other-session', current.currentLocationId, destination('park'));
    await s.onClientMessage({ type: 'scene.presented', id, ok: true });
    assert.deepEqual(db.read(w.id), changed);
    assert.equal(s.travel, undefined);
    assert.ok(messages.some((m) => m.type === 'error' && m.code === 'world_storage'));
    assert.equal(
      messages.some((m) => m.type === 'media.event' && m.event.committed),
      false,
    );
  });
});

test('client restore retains persisted foreground after asynchronous background preload', async (t) => {
  const { ClientDirector } = await import('../web/src/state/directorClient.js');
  const { useStore } = await import('../web/src/state/store.js');
  const originalState = useStore.getState();
  const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const images: { onload?: () => void }[] = [];
  class FixtureImage {
    onload?: () => void;
    src = '';
    constructor() {
      images.push(this);
    }
  }
  Object.defineProperty(globalThis, 'Image', { configurable: true, writable: true, value: FixtureImage });
  t.after(() => {
    useStore.setState(originalState, true);
    if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage);
    else Reflect.deleteProperty(globalThis, 'Image');
  });
  const client = new ClientDirector(false) as any;
  client.latestScene = '';
  const location = { ...destination(), fgUrl: '/media/world/foreground.png' };
  useStore.getState().set({
    world: {
      id: 'fixture',
      revision: 1,
      currentLocationId: location.id,
      sceneInstanceId: 'scene',
      locations: [location],
      connections: [],
    },
    fg: null,
  });
  const sendMedia = (event: MediaEvent) => client.onMedia({ type: 'media.event', event });
  sendMedia({ id: 'restore', kind: 'scene', status: 'ready', scene_key: location.key, url: location.url });
  sendMedia({ id: 'restore-fg', kind: 'foreground', status: 'ready', scene_key: location.key, url: location.fgUrl });
  assert.equal(useStore.getState().fg?.url, location.fgUrl);
  assert.equal(images.length, 1);
  images[0].onload!();
  assert.equal(useStore.getState().bgUrl, location.url);
  assert.equal(useStore.getState().fg?.url, location.fgUrl);
});

test('random layout coordinates survive promotion and reopening', (t) => {
  const f = fixture(t);
  const w = f.store.open(OWNER);
  fs.writeFileSync(path.join(f.cache, 'media', 'scene_random_stage3_650_780.jpg'), Buffer.from('random'));
  const url = f.store.promote(w.id, '/media/scene_random_stage3_650_780.jpg');
  assert.match(url, /&layout=stage3_650_780$/);
  f.store.update(w.id, 'random-layout', 'media', (draft) => {
    draft.locations[0].url = url;
  });
  assert.equal(f.reopen().open(OWNER).locations[0].url, url);
  assert.equal(f.store.promote(w.id, url), url);
});
