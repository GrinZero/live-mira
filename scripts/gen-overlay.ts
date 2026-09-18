// 离线生成 overlay 变体图（与线上同管线：i2i 参考图编辑 → 文本兜底 → 质检 → 缓存）。
// 用法: tsx scripts/gen-overlay.ts [sceneKey=cafe_interior] [subject] [ttl_ms]
// 产物: cache/media/overlay_<scene>_<hash>.jpg —— stdout 打出对应 media.event，可直接塞进 mock session.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenImg } from '../server/src/genimg.js';
import { loadContent } from '../server/src/content.js';
import { config } from '../server/src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'cafe_interior';
const subject = process.argv[3] ?? '落地玻璃外，一只湿淋淋的黑猫贴着玻璃走过，在门口垫子处停留回望';
const ttl = Number(process.argv[4] ?? 10000);

const content = loadContent();
const genimg = createGenImg({
  styleTemplate: content.styleTemplate,
  sceneBodies: content.sceneBodies,
  sendMedia: (e) => {
    console.log('[media]', JSON.stringify(e));
    if (e.status === 'ready' && e.url) {
      const name = e.url.replace('/media/', '');
      const src = path.join(config.cacheDir, 'media', name);
      const dstDir = path.join(ROOT, 'web', 'public', 'mock', 'media');
      fs.mkdirSync(dstDir, { recursive: true });
      const dst = path.join(dstDir, name);
      fs.copyFileSync(src, dst);
      console.log(`\ncopied → web/public/mock/media/${name}`);
      console.log(
        'mock event:\n' +
          JSON.stringify({
            type: 'media.event',
            payload: { type: 'media.event', event: { ...e, url: `/mock/media/${name}` } },
          }),
      );
      process.exit(0);
    }
    if (e.status === 'failed') {
      console.error('generation failed');
      process.exit(1);
    }
  },
  onDegrade: () => {},
});

genimg.generate('overlay', subject, { sceneKey: base, overlay: { base, ttlMs: ttl } });
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 120000);
