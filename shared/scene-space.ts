import { SCENE_LAYOUT, type SceneLayout } from './scene-layout.js';

// All geometry is normalized source-image space, shared with the actor guide.
export function sceneSpace(theme: string, s: SceneLayout = SCENE_LAYOUT) {
  const sheltered =
    /屋檐下|檐下|屋檐.*看雨|躲雨|避雨|廊下|门廊|雨棚下|under (?:the |an? )?(?:eaves|awning)|porch|veranda/i.test(theme);
  if (!sheltered) return null;
  return {
    left: Math.max(0.015, s.x - 0.23),
    right: Math.min(0.985, s.x + 0.23),
    roofY: Math.max(0.025, s.footY - s.actorHeight - 0.09),
    floorBack: s.footY - 0.15,
    floorFront: Math.min(0.98, s.footY + 0.11),
  };
}

export function sceneSpacePrompt(theme: string, s: SceneLayout = SCENE_LAYOUT) {
  const space = sceneSpace(theme, s);
  if (!space) return '';
  return `空间关系硬约束：这是人物与镜头一起位于屋檐下的机位，不是从街上远看建筑。草图橙色顶板代表真实屋顶下表面，绿色地板代表与它对应的遮雨廊下地面，二者必须围绕紫红人物框建造。屋顶投影与干燥地板覆盖图宽${space.left * 100}%至${space.right * 100}%，屋檐下缘在图高${space.roofY * 100}%附近，高于人物框头顶；廊下地面延伸到图高${space.floorFront * 100}%，超过脚底锚点。人物框全部在遮雨区域内部，不能放在檐外、台阶外或湿路面上。立柱只在两侧边界，台阶和滴水线在脚点前方或侧方，均不得穿过人物框。用约1.65米成人校准同深度建筑：门高约2.1米、檐下净高约2.4米，不把人物配成巨人或小人。雨幕、积水和明显湿反光在遮雨区外，框内地面干燥连续。保留这些真实建筑结构，仅去掉草图颜色和线条。`;
}
