// 拉取视线追踪资产：web/public/mediapipe/{wasm/,face_landmarker.task}
// wasm 来自 node_modules/@mediapipe/tasks-vision（版本锁定，随 npm install 就位）；
// face_landmarker.task 为 Google 官方模型（float16，含虹膜，~4MB），本地自托管不走 CDN。
// 幂等：文件已存在且体积正常则跳过。无需 API key。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'public', 'mediapipe');
const WASM_SRC = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_MIN = 2 * 1024 * 1024;

if (!fs.existsSync(WASM_SRC)) {
  console.error('[vision] 未找到 @mediapipe/tasks-vision，请先 npm install');
  process.exit(1);
}
fs.mkdirSync(path.join(OUT, 'wasm'), { recursive: true });
for (const f of fs.readdirSync(WASM_SRC)) {
  const dst = path.join(OUT, 'wasm', f);
  const src = path.join(WASM_SRC, f);
  if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) continue;
  fs.copyFileSync(src, dst);
  console.log(`[vision] wasm/${f}`);
}

const model = path.join(OUT, 'face_landmarker.task');
if (fs.existsSync(model) && fs.statSync(model).size > MODEL_MIN) {
  console.log('[vision] face_landmarker.task 已存在，跳过');
  process.exit(0);
}
console.log('[vision] 下载 face_landmarker.task …');
const res = await fetch(MODEL_URL, { headers: { 'User-Agent': 'live-demo-asset-fetch/1.0' } });
if (!res.ok) {
  console.error(
    `[vision] 下载失败 HTTP ${res.status} —— 请手动从 ${MODEL_URL} 获取后放入 web/public/mediapipe/face_landmarker.task`,
  );
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < MODEL_MIN) {
  console.error(`[vision] 文件过小（${buf.length}B），未写入`);
  process.exit(1);
}
fs.writeFileSync(model, buf);
console.log(`[vision] done ${(buf.length / 1e6).toFixed(1)}MB`);
