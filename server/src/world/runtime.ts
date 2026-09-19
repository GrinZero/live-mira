import fs from 'node:fs';
import sharp from 'sharp';
import { arkImage, download } from '../ark.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { WorldStore } from './store.js';

let store: WorldStore | undefined;
export const worldStore = () => (store ??= new WorldStore(config.worldDir, config.assetsDir, config.cacheDir));
const jobs = new Set<string>();
const lastAttempts = new Map<string, number>();
let queue = Promise.resolve();

/** Immutable per-region images: drawing a new region never rewrites old tiles. */
export function drawVisitedRegions(worldId: string, notify: () => void, retryFailed = false) {
  const db = worldStore();
  const world = db.read(worldId);
  if (!world.entered) return;
  for (const location of world.locations) {
    const key = `${worldId}:${location.id}`;
    const retry =
      retryFailed &&
      config.mapImages &&
      location.mapStatus === 'failed' &&
      Date.now() - (lastAttempts.get(key) ?? 0) > 60_000;
    if ((location.mapStatus !== 'pending' && !retry) || jobs.has(key)) continue;
    const attemptId = `map:${location.id}:${Date.now()}`;
    lastAttempts.set(key, Date.now());
    if (lastAttempts.size > 512) lastAttempts.delete(lastAttempts.keys().next().value!);
    if (retry)
      db.update(worldId, `${attemptId}:start`, 'map.pending', (w) => {
        const l = w.locations.find((l) => l.id === location.id);
        if (l) l.mapStatus = 'pending';
      });
    jobs.add(key);
    queue = queue
      .then(async () => {
        try {
          if (!config.seedApiKey || !config.mapImages) throw new Error('map image provider unavailable');
          const url = new URL(location.url, 'http://local');
          const file = db.assetFile(url.pathname, url.searchParams.get('access') || '');
          const source = file ? fs.readFileSync(file) : undefined;
          const image = source
            ? `data:image/jpeg;base64,${(await sharp(source).resize(640, 640, { fit: 'inside' }).jpeg().toBuffer()).toString('base64')}`
            : undefined;
          let bytes: Buffer | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const result = await arkImage({
                prompt: `绘制一张夜间散步地图中的单个地点区域，地点：${location.name}。环境特征：${location.description.slice(0, 500)}。参考图仅用于地标外观，改画成俯视微缩插画。深靛蓝底色，暖琥珀灯光，细腻手绘纸张纹理，简洁地图符号，中央单个建筑或地点，四边留深蓝空地衔接邻区。不要人物、文字、标签、数字、边框、UI，不要新增其他可探索地点。`,
                image,
                size: '2048x2048',
              });
              bytes = await sharp(await download(result.url))
                .resize(640, 520, { fit: 'cover' })
                .webp({ quality: 85 })
                .toBuffer();
              const stats = await sharp(bytes).stats();
              if (stats.channels.every((c) => c.stdev < 3)) throw new Error('blank map region');
              break;
            } catch (e) {
              if (attempt === 1) throw e;
            }
          }
          const mapUrl = db.saveAsset(worldId, bytes!, '.webp');
          db.update(worldId, attemptId, 'map.ready', (w) => {
            const l = w.locations.find((l) => l.id === location.id);
            if (l) {
              l.mapUrl = mapUrl;
              l.mapStatus = 'ready';
            }
          });
        } catch {
          db.update(worldId, attemptId, 'map.failed', (w) => {
            const l = w.locations.find((l) => l.id === location.id);
            if (l) l.mapStatus = 'failed';
          });
          log('genimg', 'map drawing unavailable; visited location remains accessible');
        } finally {
          jobs.delete(key);
          notify();
        }
      })
      .catch(() => {
        jobs.delete(key);
      });
  }
}
