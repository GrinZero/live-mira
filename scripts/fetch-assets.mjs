// 拉取角色模型资产：assets/mira.vrm
// 来源：VRoid Studio 官方示例 AvatarSample_A（VRM 0.x，含 humanoid 骨骼/表情/视线）
//   条款：pixiv 官方示例模型，免费、商用可、可修改/再分发、无需署名
//   https://vroid.pixiv.help/hc/en-us/articles/4402394424089
// 镜像：madjin/vrm-samples（GitHub）
// 幂等：文件已存在且体积正常则跳过。无需 API key。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'mira.vrm');
const URL_VRM = 'https://raw.githubusercontent.com/madjin/vrm-samples/master/vroid/stable/AvatarSample_A.vrm';
const EXPECTED_MIN = 10 * 1024 * 1024;

if (fs.existsSync(OUT) && fs.statSync(OUT).size > EXPECTED_MIN) {
  console.log(`[assets] mira.vrm 已存在（${(fs.statSync(OUT).size / 1e6).toFixed(1)}MB），跳过`);
  process.exit(0);
}

console.log('[assets] 下载 AvatarSample_A.vrm → assets/mira.vrm …');
const res = await fetch(URL_VRM, { headers: { 'User-Agent': 'live-demo-asset-fetch/1.0' } });
if (!res.ok) {
  console.error(`[assets] 下载失败 HTTP ${res.status} —— 请手动从 ${URL_VRM} 获取后放入 assets/mira.vrm`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < EXPECTED_MIN) {
  console.error(`[assets] 文件过小（${buf.length}B），疑似 404/LFS 指针，未写入`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);
console.log(`[assets] done ${(buf.length / 1e6).toFixed(1)}MB`);
