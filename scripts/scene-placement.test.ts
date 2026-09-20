import test from 'node:test';
import assert from 'node:assert/strict';
import { companionFrame, layoutFromUrl, sceneFrame, SCENE_LAYOUT } from '../shared/scene-layout.js';
import { stagingFor } from '../web/src/scene/staging.js';
import { isTravelAction } from '../server/src/story.js';

const legacyCafe = '/media/world/saved/4e03031463d164b2fb5da70f7e1fb0bd4894e244b744d520af71fe2ad11db7b7.jpg';

test('saved cafe photograph places feet in the aisle, outside the foreground table', () => {
  const layout = layoutFromUrl(legacyCafe);
  assert.ok(layout, 'the exact saved photograph needs an explicit calibration');
  assert.ok(layout.x >= 0.65 && layout.x <= 0.72);
  assert.ok(layout.footY >= 0.84 && layout.footY <= 0.9);
  assert.deepEqual(layoutFromUrl(legacyCafe + '?access=fixture&layout=stage3_304_830'), layout);
  const frame = sceneFrame(2048, 1016, layout);
  assert.ok(frame.actorX > 0.65, 'feet must not land on the left table');
});

test('unknown images cannot silently opt into an uncalibrated full-body shot', () => {
  const staging = stagingFor('unknown-place');
  assert.ok(staging.distance.landscape < 2, 'keep a companion close-up until ground is calibrated');
  assert.equal(staging.shadow, 0, 'do not invent a ground contact on furniture');
});

test('actor scale stays registered to the photograph across aspect ratios', () => {
  for (const [w, h] of [
    [2048, 1016],
    [3440, 1440],
    [390, 844],
  ]) {
    const frame = sceneFrame(w, h, SCENE_LAYOUT);
    assert.ok(Math.abs(frame.actorHeight * h - frame.height * SCENE_LAYOUT.actorHeight) < 1e-8);
  }
});

test('outdoor close-ups crop actor and photograph together without revealing feet or clipping the head', () => {
  for (const [w, h] of [
    [2048, 1016],
    [3440, 1440],
    [390, 844],
    [844, 390],
  ]) {
    for (const layout of [SCENE_LAYOUT, layoutFromUrl(legacyCafe)!]) {
      const f = companionFrame(w, h, layout);
      assert.ok(f.actorHeight >= 1.3 && f.footY > 1.2);
      assert.ok(Math.abs(f.footY - f.actorHeight - 0.04) < 1e-8);
      assert.ok(Math.abs(f.actorHeight * h - f.height * layout.actorHeight) < 1e-8);
      assert.ok(Math.abs(f.actorX * w - (f.left + f.width * layout.x)) < 1e-8);
      assert.ok(f.left <= 0 && f.top <= 0 && f.left + f.width >= w && f.top + f.height >= h);
    }
  }
});

test('looking at an object or taking it out is not travel even with a confident model action', () => {
  for (const text of ['拿出来看看', '看看这张旧照片', '把照片拿到桌上', '回头看看窗外', '把照片递过来']) {
    assert.equal(isTravelAction(text, 'action', 0.99), false, text);
  }
  for (const text of ['我们去咖啡馆外面的屋檐下看看雨吧', '走到桥边看看', '带我去你说的那个地方', '出去走走吧']) {
    assert.equal(isTravelAction(text, 'action', 0.99), true, text);
  }
});
