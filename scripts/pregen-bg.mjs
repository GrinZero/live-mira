// 预生成默认场景背景：assets/bg/*.jpg（Seedream 4.5，2560x1440）
// 需要 SEED_API_KEY（.env）。幂等：已存在的场景跳过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ARK_BASE = process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3';
const MODEL = process.env.GENIMG_MODEL || 'doubao-seedream-4-5-251128';
const SIZE = process.env.GENIMG_SIZE || '2560x1440'; // Seedream 4.5 最小像素 3686400
const OUT_DIR = path.join(ROOT, 'assets', 'bg');

// 与 content/style.md 表格保持一致（scene_body）
const SCENES = {
  cafe_interior: '快打烊的咖啡馆内景，落地玻璃窗上雨痕密布，吧台上只剩一盏暖色吊灯，木桌椅与一台相机',
  street_outside: '咖啡馆门外的雨夜街道，积水路面反射霓虹，一把被风吹翻的伞，远处模糊人影，从玻璃内向外的视角',
  hospital_corridor: '深夜医院走廊，惨白顶灯与窗外雨夜的冷光，空座椅，尽头的自动门，安静而干净',
  closing_time: '打烊中的咖啡馆，倒扣在桌上的椅子，吧台只剩最后一盏灯，黑暗中雨声可闻',
};

const STYLE =
  '，暴雨夜晚的电影感场景，35mm 胶片颗粒质感，暖琥珀色室内光与冷蓝雨夜的色温对比，浅景深，湿润的霓虹反光，横构图，画面中不出现正脸人物，无文字无 UI';

if (!process.env.SEED_API_KEY) {
  console.warn('[bg] 无 SEED_API_KEY，跳过预生成（仓库已带预生成图则不影响运行）');
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  /* 无 sharp 直接存原始字节 */
}

for (const [key, body] of Object.entries(SCENES)) {
  const out = path.join(OUT_DIR, `${key}.jpg`);
  if (fs.existsSync(out) && fs.statSync(out).size > 50 * 1024) {
    console.log(`[bg] ${key} 已存在，跳过`);
    continue;
  }
  console.log(`[bg] 生成 ${key} …`);
  const res = await fetch(`${ARK_BASE}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.SEED_API_KEY}` },
    body: JSON.stringify({ model: MODEL, prompt: body + STYLE, size: SIZE, response_format: 'url' }),
  });
  const j = await res.json();
  const url = j?.data?.[0]?.url;
  if (!url) {
    console.error(`[bg] ${key} 失败:`, JSON.stringify(j).slice(0, 300));
    continue;
  }
  const img = Buffer.from(await (await fetch(url)).arrayBuffer());
  const jpg = sharp ? await sharp(img).jpeg({ quality: 86, mozjpeg: true }).toBuffer() : img;
  fs.writeFileSync(out, jpg);
  console.log(`[bg] ${key} → ${(jpg.length / 1024).toFixed(0)}KB`);
}
console.log('[bg] done');
