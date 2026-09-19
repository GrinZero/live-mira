import { layoutFromUrl, layoutToken } from '../../../shared/scene-layout.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WorldLocation, WorldObject, WorldView } from '../../../shared/world.js';

interface SavedWorld extends Omit<WorldView, 'travel'> {
  version: 1;
  access: string;
  entered: boolean;
  objects: WorldObject[];
  memory: { role: 'user' | 'mira' | 'narration'; text: string; ts: number; interrupted?: boolean }[];
}

export class WorldStore {
  private db: DatabaseSync;
  constructor(
    readonly dir: string,
    private assetsDir: string,
    private cacheDir: string,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'worlds.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, owner TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS active_worlds (owner TEXT PRIMARY KEY, world_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_events (world_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL,
        kind TEXT NOT NULL, PRIMARY KEY(world_id,seq), UNIQUE(world_id,event_id));`);
  }
  close() {
    this.db.close();
  }
  private owner(token: string) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256)
      throw new Error('无法保存相遇，请允许浏览器保存访问凭证后重试。');
    return createHash('sha256').update(token).digest('hex');
  }
  hasStory(token: string): boolean {
    const row = this.db
      .prepare(
        'SELECT data FROM worlds JOIN active_worlds ON worlds.id=active_worlds.world_id WHERE active_worlds.owner=?',
      )
      .get(this.owner(token)) as { data: string } | undefined;
    return row ? Boolean((JSON.parse(row.data) as SavedWorld).entered) : false;
  }
  open(token: string, fresh = false): SavedWorld {
    const owner = this.owner(token);
    const row = this.db
      .prepare(
        'SELECT data FROM worlds JOIN active_worlds ON worlds.id=active_worlds.world_id WHERE active_worlds.owner=?',
      )
      .get(owner) as { data: string } | undefined;
    if (row && !fresh) return JSON.parse(row.data) as SavedWorld;
    const now = Date.now();
    const id = randomUUID();
    const initial: WorldLocation = {
      id: randomUUID(),
      key: 'cafe_interior',
      name: '雨夜咖啡馆',
      description: '雨夜咖啡馆，窗边的桌子',
      url: '/assets/bg/cafe_interior.jpg',
      firstVisitedAt: now,
      lastVisitedAt: now,
      visits: 1,
      x: 0,
      y: 0,
      ...(fs.existsSync(path.join(this.assetsDir, 'bg/cafe_map.webp')) ? { mapUrl: '/assets/bg/cafe_map.webp' } : {}),
      mapStatus: fs.existsSync(path.join(this.assetsDir, 'bg/cafe_map.webp')) ? 'ready' : 'pending',
      environment: { rain: 1, dim: 0 },
    };
    const world: SavedWorld = {
      version: 1,
      id,
      revision: 0,
      access: randomBytes(32).toString('hex'),
      entered: false,
      currentLocationId: initial.id,
      sceneInstanceId: randomUUID(),
      locations: [initial],
      connections: [],
      objects: [],
      memory: [],
    };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO worlds VALUES (?,?,?,?)').run(id, owner, now, JSON.stringify(world));
      this.db
        .prepare('INSERT INTO active_worlds VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET world_id=excluded.world_id')
        .run(owner, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return world;
  }
  read(id: string): SavedWorld {
    const row = this.db.prepare('SELECT data FROM worlds WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new Error('相遇存档不存在。');
    return JSON.parse(row.data) as SavedWorld;
  }
  view(id: string): WorldView {
    const {
      id: worldId,
      revision,
      currentLocationId,
      sceneInstanceId,
      locations,
      connections,
      entered,
    } = this.read(id);
    // Initial location is not publicly visited until the entry gesture.
    return {
      id: worldId,
      revision,
      currentLocationId,
      sceneInstanceId,
      locations: entered ? locations : [],
      connections,
    };
  }
  update(id: string, eventId: string, kind: string, change: (world: SavedWorld) => void): SavedWorld {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const world = this.read(id);
      const seen = this.db.prepare('SELECT 1 FROM world_events WHERE world_id=? AND event_id=?').get(id, eventId);
      if (!seen) {
        change(world);
        world.revision++;
        this.db.prepare('UPDATE worlds SET updated=?,data=? WHERE id=?').run(Date.now(), JSON.stringify(world), id);
        this.db.prepare('INSERT INTO world_events VALUES (?,?,?,?)').run(id, world.revision, eventId, kind);
      }
      this.db.exec('COMMIT');
      return world;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  arrive(id: string, travelId: string, originId: string, target: WorldLocation): SavedWorld {
    return this.update(id, travelId, 'arrive', (w) => {
      if (w.currentLocationId !== originId) throw new Error('地点已经变化，请重新选择目的地。');
      let location = w.locations.find((l) => l.id === target.id);
      if (!location) {
        location = { ...target, visits: 0, firstVisitedAt: Date.now() };
        const n = w.locations.length;
        // Stable expanding square spiral; map is schematic, not geographical distance.
        let x = 0,
          y = 0,
          dx = 1,
          dy = 0,
          length = 1,
          walked = 0,
          turns = 0;
        for (let i = 0; i < n; i++) {
          x += dx;
          y += dy;
          walked++;
          if (walked === length) {
            [dx, dy] = [-dy, dx];
            walked = 0;
            if (++turns % 2 === 0) length++;
          }
        }
        location.x = x * 300;
        location.y = y * 250;
        w.locations.push(location);
      }
      location.visits++;
      location.lastVisitedAt = Date.now();
      if (
        !w.connections.some(
          (e) => (e.from === originId && e.to === target.id) || (e.to === originId && e.from === target.id),
        )
      )
        w.connections.push({ from: originId, to: target.id });
      w.currentLocationId = location.id;
      w.sceneInstanceId = randomUUID();
    });
  }
  saveAsset(id: string, bytes: Buffer, extension = '.jpg'): string {
    if (!['.jpg', '.png', '.webp'].includes(extension)) throw new Error('unsupported asset');
    const w = this.read(id);
    const name = createHash('sha256').update(bytes).digest('hex') + extension;
    const dir = path.join(this.dir, 'media', id);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name);
    if (!fs.existsSync(dest)) {
      const temp = `${dest}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temp, 'wx');
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, dest);
    }
    return `/media/world/${id}/${name}?access=${w.access}`;
  }
  promote(id: string, url: string): string {
    if (url.startsWith(`/media/world/${id}/`)) return url;
    const match = url.match(/^\/(assets\/bg|media)\/([a-zA-Z0-9_.-]+\.(?:jpg|jpeg|png|webp))$/);
    if (!match) throw new Error('场景资产无法保存。');
    const file = path.join(
      match[1] === 'media' ? path.join(this.cacheDir, 'media') : path.join(this.assetsDir, 'bg'),
      match[2],
    );
    const saved = this.saveAsset(
      id,
      fs.readFileSync(file),
      path.extname(file) === '.jpeg' ? '.jpg' : path.extname(file),
    );
    const layout = match[2].startsWith('scene_') ? layoutFromUrl(url) : null;
    if (layout) return `${saved}&layout=${layoutToken(layout)}`;
    return match[2].startsWith('scene_') && match[2].includes('_stage2_') ? `${saved}&layout=stage2` : saved;
  }
  assetFile(urlPath: string, access: string): string | null {
    const m = urlPath.match(/^\/media\/world\/([a-f0-9-]{36})\/([a-f0-9]{64}\.(?:jpg|png|webp))$/);
    if (!m || !/^[a-f0-9]{64}$/.test(access)) return null;
    let w: SavedWorld;
    try {
      w = this.read(m[1]);
    } catch {
      return null;
    }
    if (!timingSafeEqual(Buffer.from(w.access), Buffer.from(access))) return null;
    return path.join(this.dir, 'media', m[1], m[2]);
  }
}
