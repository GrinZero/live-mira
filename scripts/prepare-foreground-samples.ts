// Real image-provider samples; explicit invocation only, no changes to active worlds.
import fs from 'node:fs';
import path from 'node:path';
import { createGenImg } from '../server/src/genimg.js';
import { loadContent } from '../server/src/content.js';
import type { MediaEvent } from '../shared/protocol.js';

const dir = path.resolve('output/playwright/foreground');
fs.mkdirSync(dir, { recursive: true });
const samples = [
  {
    name: 'porch',
    theme:
      '雨夜的木质门廊，镜头在廊下看向湿润花园和远处小屋，暖色壁灯照亮干燥的木地板。最近的一根木门柱和屋檐形成侧边框景，人物站位处平整开阔，没有横栏。',
  },
  {
    name: 'promenade',
    theme:
      '雨后的开阔海边步道，夜色中暖色路灯向远处延伸，海面平静，地面平整、没有近景遮挡物，不需要前景，栏杆与长椅都在站位之后的远处。',
  },
];
for (const sample of samples.filter((s) => !process.argv[2] || s.name === process.argv[2])) {
  const result = await new Promise<MediaEvent>((resolve) => {
    const gen = createGenImg({
      ...loadContent(),
      sendMedia: (e) => {
        console.log(JSON.stringify(e));
        if (e.status === 'ready' || e.status === 'failed') resolve(e);
      },
      onDegrade: () => {},
    });
    gen.generate('scene', sample.theme, { sceneKey: `depth_${sample.name}` });
  });
  fs.writeFileSync(path.join(dir, `${sample.name}.json`), JSON.stringify(result, null, 2));
  if (result.status !== 'ready') throw new Error(`sample failed: ${sample.name}`);
}
