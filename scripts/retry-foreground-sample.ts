import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { arkImage, download } from '../server/src/ark.js';
import { splitForeground } from '../server/src/foreground.js';
import { layoutFromUrl } from '../shared/scene-layout.js';
import { planForeground } from '../shared/foreground-layout.js';
const manifest = 'output/playwright/foreground/porch.json';
const e = JSON.parse(fs.readFileSync(manifest, 'utf8'));
const file = path.join('cache', e.url.replace('/media/', 'media/'));
const prefix = file.replace(/\.jpg$/, '');
const layout = layoutFromUrl(e.url)!;
const layers = await splitForeground(
  fs.readFileSync(`${prefix}.master.png`),
  layout,
  planForeground(e.subject, layout)!,
  `${prefix}.repaired`,
  async (prompt, image) => {
    if (prompt.includes('两个纯色')) return fs.readFileSync(`${prefix}.mask-raw.png`);
    if (fs.existsSync(`${prefix}.fill-raw.png`)) return fs.readFileSync(`${prefix}.fill-raw.png`);
    const { url } = await arkImage({
      prompt,
      image: `data:image/jpeg;base64,${(await sharp(image).jpeg({ quality: 92 }).toBuffer()).toString('base64')}`,
      size: '2560x1440',
      timeoutMs: 90000,
    });
    return download(url);
  },
);
fs.writeFileSync(`${prefix}.foreground.png`, layers.foreground);
fs.writeFileSync(file, await sharp(layers.background).jpeg({ quality: 86 }).toBuffer());
e.foreground_url = e.url.replace(/\.jpg$/, '.foreground.png');
fs.writeFileSync(manifest, JSON.stringify(e, null, 2));
console.log('foreground prepared', e.foreground_url);
