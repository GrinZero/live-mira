import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 轻量 .env 解析（不引依赖）
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const config = {
  root: ROOT,
  port: Number(process.env.PORT || 8787),
  doubaoApiKey: process.env.DOUBAO_API_KEY || '',
  seedApiKey: process.env.SEED_API_KEY || '',
  typesafeApiKey: process.env.TYPESAFE_API_KEY?.trim() || '',
  jevEnabled: process.env.JEV_ENABLED !== '0' && Boolean(process.env.TYPESAFE_API_KEY?.trim()),
  typesafeModel: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
  duplexUrl: process.env.DUPLEX_URL || 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
  duplexModel: process.env.DUPLEX_MODEL || '1.2.6.1',
  voice: process.env.MIRA_VOICE || 'zh_female_vv_jupiter_bigtts',
  // 打字注入的"用户话音"：用 jupiter 家族男声，和 Mira 的 vv 音色区分开
  //（实测 duplex 1.2.6.1 只认 *_jupiter_bigtts；moon/mars 音色静默不出声）
  injectVoice: process.env.INJECT_VOICE || 'zh_male_yunzhou_jupiter_bigtts',
  arkBase: process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com/api/v3',
  directorModel: process.env.DIRECTOR_MODEL || 'doubao-seed-1-6-flash-250828',
  genimgModel: process.env.GENIMG_MODEL || 'doubao-seedream-4-5-251128',
  genimgSize: process.env.GENIMG_SIZE || '2560x1440',
  contentDir: path.join(ROOT, 'content'),
  assetsDir: path.join(ROOT, 'assets'),
  cacheDir: path.join(ROOT, 'cache'),
  worldDir: path.resolve(process.env.WORLD_DATA_DIR || path.join(ROOT, 'data/worlds')),
  webDist: path.join(ROOT, 'web', 'dist'),
  recordingsDir: path.join(ROOT, 'recordings'),
  accessTokens: (process.env.ACCESS_TOKENS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean),
  maxSessions: Math.max(1, Number(process.env.MAX_SESSIONS || 10)),
  record: process.env.RECORD === '1',
  mapImages: process.env.MAP_IMAGES !== '0',
  mockMode: process.env.MOCK === '1' || !process.env.DOUBAO_API_KEY,
  // ASR 判停平滑窗（上游默认 1500ms）：调大让用户句间停顿/续说不被切成独立回合
  vadSmoothMs: Math.max(0, Number(process.env.VAD_SMOOTH_MS ?? 2500)),
};

export function hasKeys() {
  return Boolean(config.doubaoApiKey && config.seedApiKey);
}
