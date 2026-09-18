/* global window */
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text().slice(0, 200));
});
await p.goto('http://localhost:5174/stage-check.html?scene=/assets/bg/street_outside.jpg');
await p.waitForTimeout(2500);
await p.screenshot({ path: '/tmp/fg-0-cafe.png' });
await p.click('button');
await p.waitForTimeout(4500);
await p.screenshot({ path: '/tmp/fg-1-scene.png' });
await p.evaluate(() =>
  window.__media({
    id: 'fg1',
    kind: 'foreground',
    status: 'ready',
    url: '/assets/bg/hospital_corridor.jpg',
    scene_key: 'outside',
  }),
);
await p.waitForTimeout(1800);
await p.screenshot({ path: '/tmp/fg-2-plate.png' });
await p.evaluate(() =>
  window.__media({
    id: 'fg2',
    kind: 'foreground',
    status: 'ready',
    url: '/assets/bg/street_outside.jpg',
    scene_key: 'outside',
    self_band: true,
  }),
);
await p.waitForTimeout(1600);
await p.screenshot({ path: '/tmp/fg-3-selfband.png' });
await b.close();
console.log('done');
