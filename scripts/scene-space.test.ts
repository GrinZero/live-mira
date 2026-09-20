import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomSceneLayout } from '../shared/scene-layout.js';
import { sceneSpace, sceneSpacePrompt } from '../shared/scene-space.js';
import { sceneGuide } from '../server/src/scene-guide.js';
import { buildMediaPrompt } from '../server/src/genimg.js';

test('shelter contains the entire actor and feet across randomized positions', async () => {
  for (const n of [0, 0.25, 0.5, 0.75, 1]) {
    const layout = randomSceneLayout(() => n);
    const space = sceneSpace('咖啡馆屋檐下看雨', layout)!;
    assert.ok(space.left < layout.x - 0.08);
    assert.ok(space.right > layout.x + 0.08);
    assert.ok(space.roofY < layout.footY - layout.actorHeight);
    assert.ok(space.floorBack < layout.footY && space.floorFront > layout.footY);
    const { data, info } = await sharp(await sceneGuide(layout, undefined, '屋檐下看雨'))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => [
      ...data.subarray(
        (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels,
        (Math.floor(y * info.height) * info.width + Math.floor(x * info.width)) * info.channels + 3,
      ),
    ];
    assert.deepEqual(pixel(layout.x, space.roofY / 2), [206, 136, 58]);
    assert.deepEqual(pixel(layout.x, layout.footY + 0.05), [83, 129, 107]);
  }
});

test('shelter constraints resolve scene aliases and do not leak into photos or open scenes', () => {
  assert.equal(sceneSpace('开阔海边步道'), null);
  assert.equal(sceneSpacePrompt('开阔海边步道'), '');
  const bodies = { shelter: '咖啡馆屋檐下看雨' };
  assert.match(buildMediaPrompt('scene', '{scene_body}', bodies, 'shelter', {}), /人物框全部在遮雨区域内部/);
  assert.doesNotMatch(buildMediaPrompt('photo', '{scene_body}', bodies, 'shelter', {}), /空间关系硬约束/);
});
