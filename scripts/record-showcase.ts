// 竖屏录屏 demo：playwright 录真实模式会话（mobile viewport + recordVideo）
// 注入（INJECT_JS 字符串原样进浏览器，不经 tsx 编译）：
//   getUserMedia 音频 → 共享 MediaStreamDestination（__speak 喂 wav，走真实 ASR/VAD/打断链路）
//   getUserMedia 视频 → canvas 人脸循环（对视追踪 / 预览面板有真实画面）
//   AudioNode.connect → 凡是接到 ctx.destination 的线同时进 MediaRecorder tap（抓 Mira 语音 + 雨声/BGM）
// 产物：output/showcase/showcase.mp4（画面 + 下行音频 + 上行语音混音）
// 用法: pnpm dev 起服务后 `tsx scripts/record-showcase.ts`
import { chromium, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT_DIR ?? path.join(ROOT, 'output/showcase');
const URL = process.env.URL ?? 'http://localhost:5173';
const ASSETS = process.env.ASSETS_DIR ?? '/tmp/mira-rec';
const VIEW = { width: 430, height: 932 };
const VID = { width: 860, height: 1864 };

const U = {
  greet: path.join(ASSETS, 'u1.wav'), // 开场语音：外面雨好大…能坐吗
  barge: path.join(ASSETS, 'u2.wav'), // 打断示范：她说话途中插话
  bye: path.join(ASSETS, 'u3.wav'), // 告别语音
  face: path.join(ASSETS, 'face.jpg'), // 对视摄像头假画面
};

const TEXT_BEATS = [
  '这么大的雨，你是一直在这里等人吗？',
  '给我看看你旅途中拍的照片吧', // 照片钩：show_photo
  '这张照片背后有什么故事吗？',
  '我们现在一起推门出去，沿着街道走到桥边看看吧。', // 转场钩：明确共同行动（含糊提议会被世界决策拒掉）
  '多跟我讲讲你自己吧，你平时都喜欢做什么？', // 长回答钩：给打断留窗口
];

// 浏览器注入层（纯 JS 字符串，绕开 tsx __name 序列化问题）
const INJECT_JS = `
window.__taps = [];
// 1) 下行音频 tap：所有接到 ctx.destination 的输出复制一份进 MediaStreamDestination
(function () {
  var origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, out, inp) {
    var r = origConnect.call(this, dest, out, inp);
    try {
      var ctx = this.context;
      if (dest === ctx.destination) {
        var tap = null;
        for (var i = 0; i < window.__taps.length; i++) if (window.__taps[i].ctx === ctx) tap = window.__taps[i];
        if (!tap) {
          tap = { ctx: ctx, msd: ctx.createMediaStreamDestination(), chunks: [], rec: null };
          window.__taps.push(tap);
        }
        origConnect.call(this, tap.msd);
      }
    } catch (e) {}
    return r;
  };
})();
window.__audioStart = function () {
  window.__audioStartAt = performance.now();
  for (var i = 0; i < window.__taps.length; i++) {
    var t = window.__taps[i];
    t.chunks = [];
    t.rec = new MediaRecorder(t.msd.stream, { mimeType: 'audio/webm;codecs=opus' });
    (function (tt) {
      tt.rec.ondataavailable = function (e) {
        if (e.data.size) tt.chunks.push(e.data);
      };
    })(t);
    t.rec.start(200);
  }
  return { taps: window.__taps.length, at: window.__audioStartAt };
};
window.__audioStop = function () {
  var jobs = window.__taps.map(function (t) {
    if (!t.rec) return Promise.resolve(null);
    return new Promise(function (res) {
      t.rec.onstop = res;
      t.rec.stop();
    }).then(function () {
      return new Blob(t.chunks).arrayBuffer();
    });
  });
  return Promise.all(jobs).then(function (bufs) {
    return bufs.map(function (buf) {
      if (!buf) return '';
      var bytes = new Uint8Array(buf);
      var bin = '';
      for (var i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
      return btoa(bin);
    });
  });
};
// 2) getUserMedia：音频 → 可控麦克风；视频 → canvas 人脸
navigator.mediaDevices.getUserMedia = function (c) {
  if (c && c.audio) {
    if (!window.__mic) {
      var mctx = new AudioContext();
      mctx.resume(); // MediaStreamDestination 只在 running 时推流
      window.__mic = { ctx: mctx, dest: mctx.createMediaStreamDestination() };
    }
    return Promise.resolve(window.__mic.dest.stream);
  }
  if (c && c.video) {
    var cv = document.createElement('canvas');
    cv.width = 320;
    cv.height = 240;
    var g = cv.getContext('2d');
    var img = new Image();
    img.src = window.__faceSrc || '';
    var t0 = performance.now();
    var draw = function () {
      var t = (performance.now() - t0) / 1000;
      g.fillStyle = '#ded9d2';
      g.fillRect(0, 0, 320, 240);
      if (img.complete && img.naturalWidth) {
        // 竖版人像横屏信箱：高度撑满 → 脸高约画面 0.4（≈0.5m 距离感），缓慢横移带视线变化
        var dx = Math.sin(t * 0.5) * 30;
        var dy = Math.cos(t * 0.33) * 9;
        var w2 = 240 * (img.naturalWidth / img.naturalHeight);
        g.drawImage(img, 160 - w2 / 2 + dx, dy + 28, w2, 240);
      } else {
        g.fillStyle = '#3a4150';
        g.beginPath();
        g.ellipse(160, 120, 70, 90, 0, 0, 7);
        g.fill();
      }
      requestAnimationFrame(draw);
    };
    draw();
    return Promise.resolve(cv.captureStream(30));
  }
  return Promise.reject(new DOMException('fake gUM: unsupported constraint', 'NotSupportedError'));
};
// 3) 上行语音：wav → __mic.dest（真实 capture worklet → sendAudio → ASR/VAD）
window.__speak = function (b64) {
  if (!window.__mic) return Promise.resolve(null);
  var bytes = Uint8Array.from(atob(b64), function (c) {
    return c.charCodeAt(0);
  });
  return window.__mic.ctx.decodeAudioData(bytes.buffer).then(function (buf) {
    var at = performance.now();
    var src = window.__mic.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(window.__mic.dest);
    src.start();
    return { at: at, dur: buf.duration };
  });
};
// 4) 状态快照（驱动节拍用）
window.__snap = function () {
  var s = window.__store.getState();
  return {
    phase: s.phase,
    entered: s.entered,
    bgKey: s.bgKey,
    photo: !!s.photo,
    eyeTracking: s.eyeTracking,
    sceneTransition: s.sceneTransition ? s.sceneTransition.phase : null,
    storyPhase: s.story ? s.story.phase : null,
    storyChoices: s.story && s.story.choices ? s.story.choices.length : 0,
    toast: s.toast,
    micMuted: s.micMuted,
    lastUser: s.subtitles && s.subtitles.length ? s.subtitles[s.subtitles.length - 1].text : '',
  };
};
`;

interface Snap {
  phase: string;
  entered: boolean;
  bgKey: string;
  photo: boolean;
  eyeTracking: boolean;
  sceneTransition: string | null;
  storyPhase: string | null;
  storyChoices: number;
  toast: string;
  micMuted: boolean;
  lastUser: string;
}

const T0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

async function snap(p: Page): Promise<Snap> {
  return (await p.evaluate('window.__snap()')) as Snap;
}

/** 轮询等条件成立；超时返回 false 继续录（不炸掉整场戏） */
async function waitFor(p: Page, cond: (s: Snap) => boolean, ms: number, label: string): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await snap(p);
    if (cond(s)) {
      log(`ok ${label}`);
      return true;
    }
    await p.waitForTimeout(300);
  }
  log(`TIMEOUT ${label}`);
  return false;
}

/** 等 Mira 一回合说完：speaking 出现 → 回 listening（含 thinking 直接跳过的容错） */
async function waitTurn(p: Page, ms: number, label: string) {
  const spoke = await waitFor(p, (s) => s.phase === 'speaking', ms, `${label}:speaking`);
  if (!spoke) {
    await waitFor(p, (s) => s.phase === 'listening' || s.phase === 'idle', 15000, `${label}:settle`);
    return;
  }
  await waitFor(p, (s) => s.phase !== 'speaking', ms, `${label}:done`);
}

/** 喂一段 wav 当"用户语音"（真实上行：capture worklet → sendAudio → 服务端 ASR/VAD） */
async function speak(p: Page, wav: string, cues: { file: string; at: number }[]) {
  const b64 = fs.readFileSync(wav).toString('base64');
  await p.evaluate((d) => ((window as unknown as { __speakData: string }).__speakData = d), b64);
  const r = (await p.evaluate('window.__speak(window.__speakData)')) as { at: number; dur: number } | null;
  if (!r) {
    log('WARN no __mic — 语音上行不可用，跳过', path.basename(wav));
    return;
  }
  cues.push({ file: path.basename(wav), at: r.at });
  log(`speak ${path.basename(wav)} (${r.dur.toFixed(1)}s)`);
  await p.waitForTimeout(r.dur * 1000 + 400);
}

async function type(p: Page, text: string) {
  await p.fill('.inputbar input', text);
  await p.press('.inputbar input', 'Enter');
  log(`type "${text}"`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--headless=new', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir: path.join(OUT, 'raw'), size: VID },
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') log('[console]', m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => log('[pageerror]', e.message.slice(0, 200)));

  await ctx.addInitScript({ content: INJECT_JS });

  const faceB64 = fs.readFileSync(U.face).toString('base64');
  const cues: { file: string; at: number }[] = [];

  log('goto', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (b64) => ((window as unknown as { __faceSrc: string }).__faceSrc = `data:image/jpeg;base64,${b64}`),
    faceB64,
  );

  // 进场页停留一拍（让观众看清标题）→ 轻触进入
  await page.waitForSelector('.enter-btn:not([disabled])', { timeout: 60000 });
  await page.waitForTimeout(1800);
  await page.click('.enter-btn');
  log('enter');

  // 引擎起来后开录下行音频
  await waitFor(page, (s) => s.entered, 20000, 'entered');
  const rec = (await page.evaluate('window.__audioStart()')) as { taps: number; at: number };
  log('audio tap', JSON.stringify(rec));
  if (!rec.taps) log('WARN: no audio tap — 视频将无下行声音');
  const eye = await snap(page);
  log('eyeTracking:', eye.eyeTracking, 'micMuted:', eye.micMuted);

  // B1 开场白
  await waitTurn(page, 60000, 'greeting');
  await page.waitForTimeout(800);

  // B2 语音回合（真 ASR）
  await speak(page, U.greet, cues);
  await waitTurn(page, 60000, 'voice1');
  await page.waitForTimeout(600);

  // B3 文字回合
  await type(page, TEXT_BEATS[0]);
  await waitTurn(page, 60000, 'text1');
  await page.waitForTimeout(600);

  // B4 照片钩：等她掏照片（生图异步，给足窗口）
  await type(page, TEXT_BEATS[1]);
  const gotPhoto = await waitFor(page, (s) => s.photo, 75000, 'photo card');
  if (gotPhoto) await page.waitForTimeout(4500); // 照片卡在画面里停一拍
  await waitTurn(page, 60000, 'photo-talk');

  // B5 照片故事
  await type(page, TEXT_BEATS[2]);
  await waitTurn(page, 60000, 'photo-story');
  await page.waitForTimeout(600);

  // B6 转场钩：明确共同行动 → 生图 → departing → arriving 换底图
  const before = (await snap(page)).bgKey;
  await type(page, TEXT_BEATS[3]);
  const moved = await waitFor(page, (s) => s.bgKey !== before, 90000, 'scene change');
  if (moved) {
    await waitFor(page, (s) => !s.sceneTransition, 20000, 'transition settle');
    await page.waitForTimeout(1500);
  }
  await waitTurn(page, 60000, 'scene-talk');

  // B7 打断示范：她开口 1.4s 后插话（本地 VAD → interrupt）
  await type(page, TEXT_BEATS[4]);
  const speaking = await waitFor(page, (s) => s.phase === 'speaking', 30000, 'barge target');
  if (speaking) {
    await page.waitForTimeout(1400);
    await speak(page, U.barge, cues);
    log('barged in');
  }
  await waitTurn(page, 60000, 'post-barge');
  await page.waitForTimeout(600);

  // B8 机会主义：若有"此刻"选项漂着就点一个，不然直接告别
  const s8 = await snap(page);
  if (s8.storyPhase === 'invitation' && s8.storyChoices > 0 && (await page.$('.encounter-choices .say'))) {
    await page.click('.encounter-choices .say');
    log('picked encounter choice');
    await waitTurn(page, 60000, 'choice');
  }

  // B9 告别（语音）
  await speak(page, U.bye, cues);
  await waitTurn(page, 60000, 'farewell');
  await page.waitForTimeout(2500);

  // 收尾：取下行音频 → 关页 → 合成
  const audio = ((await page.evaluate('window.__audioStop()')) as string[]) ?? [];
  audio.forEach((b64, i) => fs.writeFileSync(path.join(OUT, `page-audio-${i}.webm`), Buffer.from(b64, 'base64')));
  fs.writeFileSync(path.join(OUT, 'cues.json'), JSON.stringify({ audioStartAt: rec.at, cues }, null, 2));
  log('audio tracks:', audio.length, 'cues:', cues.length);

  await ctx.close();
  await browser.close();

  // ffmpeg 合成：video.webm + 下行音频(adelay=tap起点) + 各用户语音(adelay=注入时刻)
  const rawDir = path.join(OUT, 'raw');
  const video = fs.readdirSync(rawDir).find((f) => f.endsWith('.webm'));
  if (!video) throw new Error('no recorded video');
  const inputs = ['-i', path.join(rawDir, video)];
  const filters: string[] = [];
  let mixIn = '';
  audio.forEach((_, i) => {
    inputs.push('-i', path.join(OUT, `page-audio-${i}.webm`));
    filters.push(`[${i + 1}:a]adelay=${Math.round(rec.at)}|${Math.round(rec.at)}[a${i}]`);
    mixIn += `[a${i}]`;
  });
  cues.forEach((c, i) => {
    inputs.push('-i', path.join(ASSETS, c.file));
    const d = Math.round(c.at);
    filters.push(`[${audio.length + 1 + i}:a]adelay=${d}|${d}[u${i}]`);
    mixIn += `[u${i}]`;
  });
  const audioMap = mixIn
    ? `-filter_complex "${filters.join(';')};${mixIn}amix=inputs=${audio.length + cues.length}:normalize=0[aout]" -map 0:v -map "[aout]"`
    : '-filter_complex "anullsrc=r=48000:cl=mono[aout]" -map 0:v -map "[aout]" -shortest';
  const cmd = `ffmpeg -y -v error ${inputs.join(' ')} ${audioMap} -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 160k "${path.join(OUT, 'showcase.mp4')}"`;
  log('mux:', cmd);
  execFileSync('bash', ['-c', cmd], { stdio: 'inherit' });
  log('done →', path.join(OUT, 'showcase.mp4'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
