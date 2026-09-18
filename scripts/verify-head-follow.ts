// Real renderer + camera lifecycle; controlled landmarks isolate tracking from camera hardware.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const out = 'output/playwright';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 }, permissions: ['camera'] });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5173/stage-check.html');
  await page.waitForFunction(() => !!(window as any).__actor);
  await page.locator('.eye-toggle').click();
  await page.waitForFunction(() => (window as any).__eye.state === 'on');
  await page.waitForTimeout(1000);
  assert.match(await page.locator('.eye-toggle').innerText(), /寻找人脸/);
  assert.equal(await page.evaluate(() => (window as any).__eye.gaze()), null);
  // Feed landmarks into the production detector, including bbox/eye-line extraction and EMA.
  await page.evaluate(() => {
    const w = window as any;
    w.__face = { x: 0.5, y: 0.5 };
    w.__eye.lm.detectForVideo = () => {
      if (!w.__face) return { faceLandmarks: [] };
      const { x, y } = w.__face;
      const f = Array.from({ length: 478 }, () => ({ x, y, z: 0 }));
      f[0] = { x: x - 0.16, y: y - 0.2, z: 0 };
      f[2] = { x: x + 0.16, y: y + 0.3, z: 0 };
      f[1] = { x, y: y + 0.1, z: 0 };
      return { faceLandmarks: [f], faceBlendshapes: [] };
    };
  });
  const pose = () =>
    page.evaluate(() => {
      const a = (window as any).__actor;
      const h = a.vrm.humanoid.getNormalizedBoneNode('head');
      return { x: h.rotation.x, y: h.rotation.y, tracking: a.gazeHead, sample: (window as any).__eye.gaze() };
    });
  const move = async (x: number, y: number, name: string) => {
    await page.evaluate(
      ({ x, y }) => {
        (window as any).__face = { x, y };
      },
      { x, y },
    );
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/head-${name}.png` });
    return pose();
  };
  const center = await move(0.5, 0.5, 'center');
  assert.equal(center.sample.gy, 0, 'neutral face must not imply looking down');
  assert.match(await page.locator('.eye-toggle').innerText(), /正在跟随/);
  const right = await move(0.25, 0.5, 'right');
  const left = await move(0.75, 0.5, 'left');
  assert.ok(right.y - left.y > 0.45, 'head must visibly turn across left/right');
  const up = await move(0.5, 0.25, 'up');
  const down = await move(0.5, 0.75, 'down');
  assert.ok(down.x - up.x > 0.3, 'head must visibly follow vertically');
  await page.evaluate(() => (window as any).__store.setState({ phase: 'thinking' }));
  const thinking = await move(0.25, 0.5, 'thinking');
  assert.ok(thinking.y > 0.2, 'thinking without action must retain follow');
  await page.evaluate(() => (window as any).__actor.playGesture({ hand_r: 'chest', hold_ms: 2500 }));
  await page.waitForTimeout(1100);
  const action = await pose();
  assert.ok(Math.abs(action.y) < 0.04, 'action must own the pose');
  await page.waitForTimeout(2500);
  const resumed = await pose();
  assert.ok(resumed.y > 0.2, 'follow must resume after action');
  await page.evaluate(() => {
    (window as any).__face = null;
  });
  await page.waitForTimeout(1600);
  const lost = await pose();
  assert.equal(lost.sample, null);
  assert.ok(Math.abs(lost.y) < 0.04);
  assert.match(await page.locator('.eye-toggle').innerText(), /寻找人脸/);
  await page.locator('.eye-toggle').click();
  assert.equal(await page.evaluate(() => (window as any).__eye.state), 'off');
  assert.equal(await page.evaluate(() => !!document.querySelector('video')), false);
  assert.equal(await page.evaluate(() => localStorage.getItem('mira.eye')), 'off');
  assert.deepEqual(errors, []);
  const result = {
    center,
    right,
    left,
    up,
    down,
    thinking,
    action,
    resumed,
    lost,
    errors,
    scope: 'Real VRM renderer and fake camera; controlled landmarks, not physical camera acceptance.',
  };
  fs.writeFileSync(`${out}/head-follow.json`, JSON.stringify(result, null, 2));
  console.log(
    'PASS: detection → head bones; visible X/Y, thinking, action override/resume, face loss, toggle cleanup.',
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
