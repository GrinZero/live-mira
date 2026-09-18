import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const out = 'output/playwright';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const delta3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:5173/stage-check.html');
  await page.waitForFunction(() => Boolean((window as any).__actor && (window as any).__store));

  const pose = () =>
    page.evaluate(() => {
      const a = (window as any).__actor;
      const ruLeg = a.vrm.humanoid.getNormalizedBoneNode('rightUpperLeg');
      const luLeg = a.vrm.humanoid.getNormalizedBoneNode('leftUpperLeg');
      const ruArm = a.vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
      const luArm = a.vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
      const hips = a.vrm.humanoid.getNormalizedBoneNode('hips');
      const spine = a.vrm.humanoid.getNormalizedBoneNode('spine');
      const group = a.vrm.scene.parent;
      return {
        rightUpperLeg: { x: ruLeg.rotation.x, y: ruLeg.rotation.y, z: ruLeg.rotation.z },
        leftUpperLeg: { x: luLeg.rotation.x, y: luLeg.rotation.y, z: luLeg.rotation.z },
        rightUpperArm: { x: ruArm.rotation.x, y: ruArm.rotation.y, z: ruArm.rotation.z },
        leftUpperArm: { x: luArm.rotation.x, y: luArm.rotation.y, z: luArm.rotation.z },
        hips: { x: hips.rotation.x, y: hips.rotation.y, z: hips.rotation.z },
        spine: { x: spine.rotation.x, y: spine.rotation.y, z: spine.rotation.z },
        rootY: a.vrm.scene.position.y,
        activeMotion: a.activeMotion?.action ?? null,
        standing: a.standing,
        group: { x: group.position.x, y: group.position.y, z: group.position.z, yaw: group.rotation.y },
      };
    });

  const rest = await pose();
  await page.evaluate(() =>
    (window as any).__actor.playMotion({ action: 'walk', direction: 'forward', style: 'brisk', duration_ms: 1800 }),
  );
  await page.waitForTimeout(360);
  const walkA = await pose();
  await page.waitForTimeout(240);
  const walkB = await pose();
  assert.ok(Math.abs(walkA.rightUpperLeg.x - walkB.rightUpperLeg.x) > 0.08, 'walk must animate the legs over time');
  assert.ok(Math.abs(walkA.leftUpperLeg.x - walkB.leftUpperLeg.x) > 0.08, 'walk must animate both legs over time');

  await page.evaluate(() =>
    (window as any).__actor.playMotion({ action: 'dance', style: 'playful', duration_ms: 1800 }),
  );
  await page.waitForTimeout(300);
  const danceA = await pose();
  await page.waitForTimeout(260);
  const danceB = await pose();
  assert.ok(delta3(danceA.rightUpperArm, danceB.rightUpperArm) > 0.08, 'dance must animate the arms over time');
  assert.ok(delta3(danceA.hips, danceB.hips) > 0.04, 'dance must animate the hips over time');

  await page.evaluate(() =>
    (window as any).__actor.playMotion({ action: 'turn', direction: 'left', duration_ms: 1400 }),
  );
  await page.waitForTimeout(520);
  const turn = await pose();
  assert.ok(Math.abs(turn.spine.y - rest.spine.y) > 0.08, 'turn must rotate the torso');

  await page.evaluate(() => (window as any).__actor.playMotion({ action: 'stand_up', duration_ms: 1000 }));
  await page.waitForTimeout(1450);
  const standing = await pose();
  assert.equal(standing.activeMotion, null, 'stand_up must finish');
  assert.equal(standing.standing, true, 'stand_up must persist the standing state');
  assert.ok(standing.rootY > rest.rootY + 0.1, 'stand_up must raise the body');

  await page.evaluate(() => {
    const actor = (window as any).__actor;
    actor.playMotion({ action: 'dance', duration_ms: 5000 });
    actor.setState('idle');
  });
  await page.waitForTimeout(180);
  const resetIdle = await pose();
  assert.equal(resetIdle.activeMotion, null, 'idle/reset must cancel runtime-owned motion immediately');
  assert.equal(resetIdle.standing, false, 'idle/reset must restore the baseline seated state');

  await page.evaluate(() =>
    (window as any).__store.setState({
      sceneTransition: { id: 'motion-check', phase: 'departing', startedAt: Date.now() },
    }),
  );
  await page.waitForTimeout(650);
  const departingA = await pose();
  await page.waitForTimeout(250);
  const departingB = await pose();
  assert.ok(
    departingB.group.x < -0.3 && departingB.group.z < -0.1,
    'departure must move the character out of the shot',
  );
  assert.ok(delta3(departingA.rightUpperLeg, departingB.rightUpperLeg) > 0.05, 'departure must carry a walk cycle');

  await page.evaluate(() =>
    (window as any).__store.setState({
      sceneTransition: { id: 'motion-check', phase: 'arriving', startedAt: Date.now() },
    }),
  );
  await page.waitForTimeout(180);
  const arriveStart = await pose();
  await page.waitForTimeout(1100);
  const arriveEnd = await pose();
  assert.ok(arriveStart.group.x < -0.45, 'arrival starts from the edge of the shot');
  assert.ok(
    Math.abs(arriveEnd.group.x) < Math.abs(arriveStart.group.x) * 0.35,
    'arrival moves back toward the settled mark',
  );
  await page.evaluate(() => (window as any).__store.setState({ sceneTransition: null }));

  await page.screenshot({ path: `${out}/motion-runtime.png` });
  assert.deepEqual(errors, []);
  const result = {
    rest,
    walkA,
    walkB,
    danceA,
    danceB,
    turn,
    standing,
    resetIdle,
    departingA,
    departingB,
    arriveStart,
    arriveEnd,
    errors,
    scope:
      'Real VRM renderer in Chromium; procedural motion and scene-transition locomotion, not physical-device acceptance.',
  };
  fs.writeFileSync(`${out}/motion-runtime.json`, JSON.stringify(result, null, 2));
  console.log(
    'PASS: walk, dance, turn, stand-up, reset cancellation, departure walk-out, and arrival walk-in all moved the real VRM runtime.',
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
