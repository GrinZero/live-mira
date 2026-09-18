import { sceneDescription } from './story.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { arkImage, download } from './ark.js';
import { config } from './config.js';
import { log } from './log.js';
import type { MediaEvent } from '../../shared/protocol.js';

// 生图管线：主题 → 风格模板 → Seedream → 下载 → 质检 → 重试 → 缓存 → 降级
export interface GenImgDeps {
  styleTemplate: string;
  sceneBodies: Record<string, string>;
  sendMedia: (e: MediaEvent) => void;
  onDegrade: (reason: 'timeout' | 'bad', kind: MediaEvent['kind']) => void;
}

const inflight = new Map<string, Promise<void>>();

// theme 可能是 LLM 写的中文长句 → 文件名安全 key
function safeKey(theme: string): string {
  const ascii = theme.replace(/[^\w-]/g, '').slice(0, 24);
  return ascii || crypto.createHash('md5').update(theme).digest('hex').slice(0, 8);
}

export function buildPrompt(styleTemplate: string, sceneBodies: Record<string, string>, theme: string): string {
  const body = sceneBodies[theme] ?? theme;
  return styleTemplate.replace('{scene_body}', body.replace('{用户对话中提取的地点/线索}', ''));
}

async function qualityCheck(buf: Buffer, kind?: MediaEvent['kind']): Promise<{ ok: boolean; reason?: string }> {
  if (buf.length < 40 * 1024) return { ok: false, reason: `too_small:${buf.length}` };
  try {
    const img = sharp(buf);
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < 1024) {
      return { ok: false, reason: `bad_dims:${meta.width}x${meta.height}` };
    }
    if (kind === 'scene' && meta.width && meta.height) {
      const stripe = Math.floor(meta.width / 4);
      for (const left of [0, meta.width - stripe]) {
        const edge = await sharp(buf).extract({ left, top: 0, width: stripe, height: meta.height }).stats();
        if (edge.channels.every((c) => c.mean > 244 && c.stdev < 5)) return { ok: false, reason: 'blank_side_panel' };
      }
    }
    const stats = await img.stats();
    const stddev = stats.channels.reduce((s, c) => s + (c.stdev ?? 0), 0) / stats.channels.length;
    if (stddev < 8) return { ok: false, reason: `flat:${stddev.toFixed(1)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `decode:${(e as Error).message.slice(0, 80)}` };
  }
}

async function toJpeg(buf: Buffer): Promise<Buffer> {
  return sharp(buf).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

// 前景板与底图的配合度：只比画面上 2/3（下缘允许被前景元素改变）。
// 重采样到 48×27 会平均掉胶片颗粒/重绘纹理噪声，剩下的是结构性错位——
// 地平线移动、大件重排、色调跑偏。返回 MAE(0-255)，越小越配合。
async function plateDrift(base: Buffer, plate: Buffer): Promise<number> {
  const crop = async (buf: Buffer) => {
    const img = sharp(buf);
    const m = await img.metadata();
    const w = m.width ?? 1,
      h = Math.max(1, Math.floor((m.height ?? 1) * 0.66));
    return img
      .extract({ left: 0, top: 0, width: w, height: h })
      .resize(48, 27, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
  };
  const [a, b] = await Promise.all([crop(base), crop(plate)]);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// 结构漂移阈值：i2i 保构图的重绘一般 <30；重排过场景的都 >40（实测按 log 调）
const FG_DRIFT_MAX = 32;

// overlay = 当前场景的生成式变体叠层：以基底场景图为参考做图编辑（保构图只加元素），
// 无参考图时退化为"场景体+主题"文生图。silent=true 只做缓存预热，不下发媒体事件。
export interface GenImgOpts {
  caption?: string;
  contextId?: string;
  purpose?: 'moment' | 'photo';
  sceneKey?: string;
  // file/url = 当前正在显示的那张基底图（精确锚定，不用 scene_key 前缀猜缓存）
  overlay?: { base: string; file?: string; url?: string; ttlMs?: number };
  silent?: boolean;
}

export function buildMediaPrompt(
  kind: MediaEvent['kind'],
  style: string,
  bodies: Record<string, string>,
  theme: string,
  opts: GenImgOpts,
): string {
  const body = bodies[theme] ?? theme;
  if (kind === 'photo') {
    return (
      `直接呈现以下摄影主体的完整画面：${body}。主题中的地点和物件是最高优先级。` +
      (opts.purpose === 'moment'
        ? '这是眼前环境或物件的特写。'
        : '这是照片里的内容本身，不是有人在观看照片的场面；不要相框、纸边、手指、相机或额外的咖啡馆。') +
      '自然光影，细腻胶片质感。不要擅自改成雨夜霓虹街景。无UI。'
    );
  }
  if (kind === 'scene') {
    return (
      `空无一人的环境建立镜头，绝对不要任何人物、人体局部、人影、人物剪影。${buildPrompt(style, bodies, theme)}` +
      '手机竖屏9:16环境构图。人眼高度约1.5米的平视镜头，保持镜头水平；地平线在画面高度的40%附近。禁止贴地、仰拍或倾斜镜头。右侧中上部清楚展示地点特征，左侧中部留给前景角色。近处地面不超过下方三分之一，禁止巨大近景物件。完整连续的环境铺满整个画幅。左右边缘都是同一个真实场景的延续，有自然的地面、天空和环境细节。无人物，无白色留空，无拼贴，无分屏，无边框。不要标题、字母、数字、摄影参数、海报排版或文字水印。'
    );
  }
  return buildPrompt(style, bodies, theme);
}

const newId = () => `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export function createGenImg(deps: GenImgDeps) {
  const { styleTemplate, sceneBodies, sendMedia, onDegrade } = deps;
  const dir = path.join(config.cacheDir, 'media');
  fs.mkdirSync(dir, { recursive: true });

  // overlay 基底图：优先缓存里该场景已生成的图，退到打包资产
  function baseImageFile(base: string): string | undefined {
    const hit = fs.readdirSync(dir).find((n) => n.startsWith(`scene_${base}_`) && n.endsWith('.jpg'));
    if (hit) return path.join(dir, hit);
    const bundled = path.join(config.assetsDir, 'bg', `${base}.jpg`);
    return fs.existsSync(bundled) ? bundled : undefined;
  }

  function overlayPrompt(base: string, theme: string, refImage?: string): string {
    if (refImage) {
      return (
        `保持参考图的构图、光影、色调、视角完全不变，只在画面中合理地添加：${theme}。` +
        '新元素要与雨夜环境自然融合（湿润反光、胶片颗粒、浅景深），无文字无 UI。'
      );
    }
    const body = sceneBodies[base] ?? base;
    return buildPrompt(styleTemplate, sceneBodies, `${body}，${theme}`);
  }

  // foreground = 同场景的近景前景板：i2i 保构图，只在画面下缘加失焦前景元素；
  // 客户端只取底部羽化带，轻微错位被浅景深掩盖。无参考图时退化文生图（仍只用作前景带）。
  function foregroundPrompt(theme: string, refImage?: string): string {
    const place = theme.slice(0, 100);
    if (refImage) {
      return (
        `保持参考图的构图、光影、色调、视角完全不变，只在画面最下缘的近景处添加与该场景自然融合的失焦前景元素，` +
        `例如桌沿、吧台、栏杆、窗框边、被雨打湿的植物叶影——只占画面底部约四分之一，明显虚化。场景：${place}。不要人物，无文字，无UI。`
      );
    }
    return (
      `电影感空镜，画面下缘是失焦模糊的近景前景（桌沿、栏杆或植物叶影），中远景是环境：${place}。` +
      '浅景深，雨夜电影色调一致。不要人物，无文字，无UI。'
    );
  }

  async function attempt(prompt: string, image?: string, portrait = false): Promise<Buffer> {
    const { url } = await arkImage({ prompt, image, ...(portrait ? { size: '1440x2560' } : {}) });
    return download(url);
  }

  async function run(kind: MediaEvent['kind'], theme: string, opts: GenImgOpts) {
    const sceneKey = opts.sceneKey ?? (kind === 'scene' ? safeKey(theme) : kind);
    const key = `${kind}_${sceneKey}_${crypto
      .createHash('md5')
      .update(
        'composition-mobile-v4' +
          buildMediaPrompt(kind, styleTemplate, sceneBodies, theme, opts) +
          (opts.caption ?? ''),
      )
      .digest('hex')
      .slice(0, 10)}`;
    const id = newId();
    const file = path.join(dir, `${key}.jpg`);
    const url = `/media/${key}.jpg`;
    const emit = (status: MediaEvent['status'], extra: Partial<MediaEvent> = {}) => {
      if (opts.silent) return;
      sendMedia({
        id,
        kind,
        status,
        context_id: opts.contextId,
        purpose: opts.purpose,
        url,
        caption: opts.caption,
        subject: theme,
        scene_key: sceneKey,
        ttl_ms: opts.overlay?.ttlMs,
        ...extra,
      });
    };

    emit('generating');
    if (fs.existsSync(file)) {
      if (!opts.silent) {
        log('genimg', `cache hit ${key}`);
        emit('ready', { cached: true });
      }
      return;
    }

    // self-band 兜底：前景层直接复用当前底图 URL——同一张图，配合度由构造保证
    const emitSelfBand = () => {
      const self = opts.overlay?.url;
      if (self) {
        log('genimg', `fg self-band ${key}`);
        emit('ready', { url: self, self_band: true });
      } else emit('failed', { reason: 'no_base' });
    };

    let refImage: string | undefined;
    let refBuf: Buffer | undefined;
    let prompt = buildMediaPrompt(kind, styleTemplate, sceneBodies, theme, opts);
    if (opts.overlay) {
      const baseFile = opts.overlay.file ?? baseImageFile(opts.overlay.base);
      if (baseFile) {
        refBuf = fs.readFileSync(baseFile);
        refImage = `data:image/jpeg;base64,${refBuf.toString('base64')}`;
      }
      prompt =
        kind === 'foreground' ? foregroundPrompt(theme, refImage) : overlayPrompt(opts.overlay.base, theme, refImage);
    }
    // 前景板必须锚定正在显示的那张底图；没有可参照基底就不生图，直接落 self-band
    if (kind === 'foreground' && !refBuf) {
      emitSelfBand();
      return;
    }
    // 前景板与叠层跟随基底真实画幅（竖屏场景配竖屏编辑）
    let portrait = kind === 'scene' || kind === 'foreground';
    if ((kind === 'foreground' || kind === 'overlay') && refBuf) {
      try {
        const m = await sharp(refBuf).metadata();
        portrait = (m.height ?? 1) >= (m.width ?? 1);
      } catch {
        /* keep default */
      }
    }
    log('genimg', `start ${key}${refImage ? ' [i2i]' : ''}`, { prompt: prompt.slice(0, 140) });
    const t0 = Date.now();

    let tryN = 0;
    while (tryN < 2) {
      try {
        const raw = await attempt(prompt, refImage, portrait);
        const qc = await qualityCheck(raw, kind);
        if (!qc.ok) {
          log('genimg', `qc fail ${key} ${qc.reason} (try ${tryN})`);
          if (++tryN < 2) continue;
          if (kind === 'foreground') {
            emitSelfBand();
            return;
          }
          emit('failed', { reason: qc.reason });
          if (kind !== 'overlay') onDegrade('bad', kind);
          return;
        }
        const jpg = await toJpeg(raw);
        // 前景板的硬约束：与底图做结构漂移校验，不配合宁可退化也不错位上屏
        if (kind === 'foreground' && refBuf) {
          const drift = await plateDrift(refBuf, jpg);
          if (drift > FG_DRIFT_MAX) {
            log('genimg', `fg drift ${key} mae=${drift.toFixed(1)} (try ${tryN})`);
            if (++tryN < 2) continue;
            emitSelfBand();
            return;
          }
          log('genimg', `fg match ${key} mae=${drift.toFixed(1)}`);
        }
        fs.writeFileSync(file, jpg);
        log('genimg', `ready ${key} ${(jpg.length / 1024).toFixed(0)}KB in ${Date.now() - t0}ms`);
        emit('ready');
        return;
      } catch (e) {
        log('genimg', `error ${key} try${tryN}: ${(e as Error).message.slice(0, 160)}`);
        // 前景板的图编辑失败 = 无法保证配合 → 直接落 self-band，不退化文生图
        if (kind === 'foreground' && refImage) {
          emitSelfBand();
          return;
        }
        // 图编辑失败（参数不支持/图过大等）→ 退化文生图重试，不占重试次数
        if (refImage) {
          refImage = undefined;
          prompt = overlayPrompt(opts.overlay!.base, theme);
          continue;
        }
        tryN++;
      }
    }
    if (kind === 'foreground') {
      emitSelfBand();
      return;
    }
    emit('failed', { reason: 'timeout_or_api' });
    if (kind !== 'overlay') onDegrade('timeout', kind);
  }

  return {
    // 同 key 并发生图去重；命中在途任务（多为静默预热）时，非静默调用落定后补发结果
    generate(kind: MediaEvent['kind'], theme: string, opts: GenImgOpts = {}) {
      if (kind === 'scene' && !sceneDescription(theme)) {
        log('genimg', 'rejected empty scene description');
        if (!opts.silent)
          sendMedia({
            id: newId(),
            kind,
            status: 'failed',
            context_id: opts.contextId,
            reason: 'invalid_scene_description',
          });
        return;
      }
      const sceneKey = opts.sceneKey ?? (kind === 'scene' ? safeKey(theme) : kind);
      const key = `${kind}_${sceneKey}_${crypto
        .createHash('md5')
        .update(
          'composition-mobile-v4' +
            buildMediaPrompt(kind, styleTemplate, sceneBodies, theme, opts) +
            (opts.caption ?? ''),
        )
        .digest('hex')
        .slice(0, 10)}`;
      const file = path.join(dir, `${key}.jpg`);
      const url = `/media/${key}.jpg`;

      const prev = inflight.get(key);
      if (prev) {
        if (opts.silent) return;
        const id = newId();
        const evt = (status: MediaEvent['status'], extra: Partial<MediaEvent> = {}) =>
          sendMedia({
            id,
            kind,
            status,
            context_id: opts.contextId,
            purpose: opts.purpose,
            url,
            caption: opts.caption,
            subject: theme,
            scene_key: sceneKey,
            ttl_ms: opts.overlay?.ttlMs,
            ...extra,
          });
        evt('generating');
        const next = prev.then(
          () =>
            evt(
              fs.existsSync(file) ? 'ready' : 'failed',
              fs.existsSync(file) ? { cached: true } : { reason: 'unavailable' },
            ),
          () => evt('failed', { reason: 'unavailable' }),
        );
        inflight.set(key, next);
        void next.finally(() => {
          if (inflight.get(key) === next) inflight.delete(key);
        });
        return;
      }

      const p = run(kind, theme, opts);
      inflight.set(key, p);
      void p.finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
      });
    },
  };
}

export type GenImg = ReturnType<typeof createGenImg>;
