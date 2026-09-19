import fs from 'node:fs';
import sharp from 'sharp';
import { arkImage, download } from './ark.js';
import type { SceneLayout } from '../../shared/scene-layout.js';
import type { ForegroundPlan } from '../../shared/foreground-layout.js';

type Edit = (prompt: string, image: Buffer) => Promise<Buffer>;
const edit: Edit = async (prompt, image) => {
  const { url } = await arkImage({
    prompt,
    image: `data:image/jpeg;base64,${(await sharp(image).jpeg({ quality: 92 }).toBuffer()).toString('base64')}`,
    size: '2560x1440',
    timeoutMs: 90000,
  });
  return download(url);
};

export async function validateForegroundMask(mask: Buffer, layout: SceneLayout, plan: ForegroundPlan) {
  const { data, info } = await sharp(mask).resize(320, 180).greyscale().raw().toBuffer({ resolveWithObject: true });
  let area = 0,
    protectedArea = 0,
    outside = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x] < 128) continue;
      area++;
      const nx = x / info.width,
        ny = y / info.height;
      if (Math.abs(nx - layout.x) < 0.095 && ny > layout.footY - 0.64 && ny < layout.footY + 0.035) protectedArea++;
      // Permit natural contour variation, but not unrelated distant buildings/ground.
      const post = Math.abs(nx - plan.postX) < 0.09;
      const eave = ny < 0.16 && (plan.side === 'right' ? nx > plan.postX - 0.05 : nx < plan.postX + 0.05);
      if (!post && !eave) outside++;
    }
  const fraction = area / data.length;
  if (fraction < 0.012 || fraction > 0.26) throw new Error(`foreground_mask_coverage:${fraction.toFixed(3)}`);
  if (protectedArea > 8) throw new Error('foreground_mask_overlaps_actor');
  if (outside > area * 0.04) throw new Error('foreground_mask_outside_plan');
  return { coverage: fraction, protectedArea, outside };
}

// The planned near object is warm wood. Intersect the semantic proposal with
// its source colors and planned region, so bright sky is never mistaken for alpha.
export async function refineWoodMask(source: Buffer, proposal: Buffer, layout: SceneLayout, plan: ForegroundPlan) {
  const rgb = await sharp(source).removeAlpha().raw().toBuffer();
  const proposed = await sharp(proposal).resize(layout.width, layout.height).greyscale().raw().toBuffer();
  const data = Buffer.alloc(layout.width * layout.height);
  for (let y = 0; y < layout.height; y++)
    for (let x = 0; x < layout.width; x++) {
      const i = y * layout.width + x,
        nx = x / layout.width,
        ny = y / layout.height;
      const allowed =
        Math.abs(nx - plan.postX) < 0.09 ||
        (ny < 0.16 && (plan.side === 'right' ? nx > plan.postX - 0.05 : nx < plan.postX + 0.05));
      const r = rgb[i * 3],
        g = rgb[i * 3 + 1],
        b = rgb[i * 3 + 2];
      if (allowed && proposed[i] > 128 && r > b * 1.12 && r > g * 1.04) data[i] = 255;
    }
  return sharp(data, { raw: { width: layout.width, height: layout.height, channels: 1 } })
    .median(3)
    .blur(0.5)
    .png()
    .toBuffer();
}

// Small disocclusions only: extend neighboring background through the hidden strip.
// This is a fallback when the image editor redraws the very post we asked to remove.
export async function extendBehindMask(source: Buffer, mask: Buffer, layout: SceneLayout) {
  const rgb = await sharp(source).removeAlpha().raw().toBuffer();
  const m = await sharp(mask).greyscale().raw().toBuffer();
  const out = Buffer.from(rgb),
    w = layout.width,
    h = layout.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (m[y * w + x] < 16) continue;
      const start = x;
      while (x < w && m[y * w + x] >= 16) x++;
      const end = x;
      for (let xx = start; xx < end; xx++) {
        let a = y * w + Math.max(0, start - Math.max(2, Math.round(w * 0.015))),
          b = y * w + Math.min(w - 1, end + Math.max(2, Math.round(w * 0.015)));
        if (start === 0 || end === w) {
          let yy = y;
          while (yy < h - 1 && m[yy * w + xx] >= 16) yy++;
          a = b = yy * w + xx;
        }
        const t = (xx - start + 1) / (end - start + 1);
        for (let c = 0; c < 3; c++)
          out[(y * w + xx) * 3 + c] = Math.round(rgb[a * 3 + c] * (1 - t) + rgb[b * 3 + c] * t);
      }
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

// Extract RGB from the master itself: no recolored, independently generated plate.
// Background replacement is restricted to the mask; all other pixels stay exact.
export async function splitForeground(
  master: Buffer,
  layout: SceneLayout,
  plan: ForegroundPlan,
  artifactPrefix: string,
  runEdit: Edit = edit,
) {
  const source = await sharp(master).resize(layout.width, layout.height).removeAlpha().png().toBuffer();
  fs.writeFileSync(`${artifactPrefix}.master.png`, source);
  const side = plan.side === 'right' ? '右' : '左';
  const rawMask = await runEdit(
    `把这张图改成只有两个纯色的大块剪影图。先把整张画布全部涂成纯黑色。然后沿原图中图宽${Math.round(plan.postX * 100)}%附近的那一根最近的${side}侧木柱外轮廓，画出一个实心纯白色的柱子剪影，包含它连接的最上方近处屋檐。白色形状里没有纹理，没有阴影，没有黑色线条。除此之外全部保持纯黑，没有天空、庭院、房屋、地板、门、植物的轮廓。黑底白色剪纸形状，二值语义分割蒙版，严禁黑白摄影、素描、灰度照片。白色实心形状必须与参考图对应物件的位置和尺寸完全重合。输出16:9，仅两种颜色，纯黑背景，纯白剪影`,
    source,
  );
  fs.writeFileSync(`${artifactPrefix}.mask-raw.png`, rawMask);
  const mask = await refineWoodMask(source, rawMask, layout, plan);
  const quality = await validateForegroundMask(mask, layout, plan);
  fs.writeFileSync(`${artifactPrefix}.mask.png`, mask);
  const alpha = await sharp(mask).greyscale().raw().toBuffer();
  const foreground = await sharp(source)
    .joinChannel(alpha, { raw: { width: layout.width, height: layout.height, channels: 1 } })
    .png()
    .toBuffer();
  // Mark exactly the region to remove, instead of asking the model to guess it again.
  const marked = await sharp({
    create: { width: layout.width, height: layout.height, channels: 3, background: '#ff00cc' },
  })
    .joinChannel(alpha, { raw: { width: layout.width, height: layout.height, channels: 1 } })
    .png()
    .toBuffer();
  const reference = await sharp(source)
    .composite([{ input: marked }])
    .png()
    .toBuffer();
  const fill = await runEdit(
    '仅修复参考图中的紫红色区域：这些区域是已移除的近处门柱和屋檐，请补全它们后方自然延续的远处庭院、建筑、天空或地面。保持镜头、透视和所有非紫红区域完全不变。不再画门柱、屋檐或其他替代物，不添加人物。消除所有紫红标记，输出完整真实环境图。',
    reference,
  );
  fs.writeFileSync(`${artifactPrefix}.fill-raw.png`, fill);
  let fillRgb = await sharp(fill).resize(layout.width, layout.height).removeAlpha().png().toBuffer();
  const fillPixels = await sharp(fillRgb).raw().toBuffer();
  let visible = 0,
    retainedWood = 0;
  for (let i = 0; i < alpha.length; i++)
    if (alpha[i] > 128) {
      visible++;
      if (fillPixels[i * 3] > fillPixels[i * 3 + 2] * 1.12 && fillPixels[i * 3] > fillPixels[i * 3 + 1] * 1.04)
        retainedWood++;
    }
  const usedEdgeFill = retainedWood / Math.max(1, visible) > 0.45;
  const repairMask = await sharp(mask).threshold(16).dilate(5).blur(0.5).png().toBuffer();
  const repairAlpha = await sharp(repairMask).greyscale().raw().toBuffer();
  if (usedEdgeFill) fillRgb = await extendBehindMask(source, repairMask, layout);
  const patch = await sharp(fillRgb)
    .joinChannel(repairAlpha, { raw: { width: layout.width, height: layout.height, channels: 1 } })
    .png()
    .toBuffer();
  const background = await sharp(source)
    .composite([{ input: patch }])
    .png()
    .toBuffer();
  fs.writeFileSync(`${artifactPrefix}.quality.json`, JSON.stringify({ ...quality, usedEdgeFill }, null, 2));
  return { background, foreground };
}
