import { traceOperation, traceEvent } from './telemetry.js';
import { sceneSpacePrompt } from '../../shared/scene-space.js';
import { sceneGuide, GUIDE_INSTRUCTION } from './scene-guide.js';
import {
  sceneLayoutPrompt,
  randomSceneLayout,
  layoutToken,
  layoutFromUrl,
  type SceneLayout,
} from '../../shared/scene-layout.js';
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
  layoutRandom?: () => number;
  styleTemplate: string;
  sceneBodies: Record<string, string>;
  sendMedia: (e: MediaEvent) => void;
  onDegrade: (reason: 'timeout' | 'bad', kind: MediaEvent['kind']) => void;
}

const inflight = new Map<string, Promise<void>>();
const sceneLayouts = new Map<string, SceneLayout>();

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
      if (Math.abs(meta.width / meta.height - 16 / 9) > 0.03) return { ok: false, reason: 'scene_aspect_mismatch' };
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
  layout?: SceneLayout;
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
      `照片内容：${body}。以真实摄影表现主题本身，自然材质、可信光照和镜头景深。` +
      (opts.purpose === 'moment'
        ? '这是眼前物件或环境的特写，主体清晰。'
        : '独立照片构图，不包含相框、纸边、手指或观看照片的人。') +
      '忠实遵守主题的时间、天气和地点，不套用场景站位、咖啡馆布景或固定雨夜色调。除非主题明确要求，不添加人物。无文字无UI。'
    );
  }
  if (kind === 'foreground') {
    return `以前景参考底图为唯一依据，保持构图、视角、材质、光照和色调完全不变。只在最下缘添加符合该地点的少量失焦近景物件：${body}。不要重画中远景，不遮挡预留站位及接地点，不添加人物，无文字无UI。`;
  }
  if (kind === 'overlay') {
    return `编辑当前底图，只添加事件：${body}。保留参考图原有风格、镜头、空间布局、地面和人物站位，不转换成插画，不重新设计场景。新元素遵循原图材质和光照。无额外文字无UI。`;
  }
  return buildPrompt(style, bodies, theme) + sceneLayoutPrompt(opts.layout) + sceneSpacePrompt(body, opts.layout);
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
    return (
      buildMediaPrompt('overlay', styleTemplate, sceneBodies, theme, {}) +
      (refImage ? '' : `环境：${sceneBodies[base] ?? base}。`)
    );
  }

  function foregroundPrompt(theme: string, _refImage?: string): string {
    return buildMediaPrompt('foreground', styleTemplate, sceneBodies, theme, {});
  }

  async function attempt(prompt: string, image?: string, portrait = false, scene = false): Promise<Buffer> {
    const { url } = await arkImage({
      prompt,
      image,
      ...(scene ? { size: '2560x1440' } : portrait ? { size: '1440x2560' } : {}),
    });
    return download(url);
  }

  async function run(kind: MediaEvent['kind'], theme: string, opts: GenImgOpts, key: string) {
    const sceneKey = opts.sceneKey ?? (kind === 'scene' ? safeKey(theme) : kind);
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
    if (kind === 'scene') {
      refImage = `data:image/png;base64,${(await sceneGuide(opts.layout, undefined, sceneBodies[theme] ?? theme)).toString('base64')}`;
      prompt = GUIDE_INSTRUCTION + prompt;
    }
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
        let raw = await attempt(prompt, refImage, portrait, kind === 'scene');
        if (kind === 'scene') {
          fs.writeFileSync(path.join(dir, `${key}.layout.png`), await sharp(raw).png().toBuffer());
          // The layout pass may retain guide marks. Clean them in a separate edit
          // before caching or publishing; never expose the layout draft.
          raw = await attempt(
            sceneSpacePrompt(sceneBodies[theme] ?? theme, opts.layout) +
              '精确清理这张环境图：若草图包含橙色顶板、绿色地板，必须转化为真实屋顶和干燥廊下地面，不能删掉对应建筑结构。移除所有紫红色矩形框、青色或蓝绿色椭圆标记、构图网格和辅助线，用周围相同的地面或背景无缝补全。保持所有建筑、镜头、透视、画幅、地面位置、材质和光照不变。不要添加人物或人体局部，不要重新构图。只输出清理后的同一张环境图。',
            `data:image/jpeg;base64,${(await toJpeg(raw)).toString('base64')}`,
            false,
            true,
          );
        }
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
        // AI placement review is disabled: do not block travel or regenerate
        // the scene based on a model verdict. Basic image QC above still applies.
        const jpg = await toJpeg(
          kind === 'scene' ? await sharp(raw).resize(2560, 1440, { fit: 'cover' }).toBuffer() : raw,
        );
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
        if (refImage && kind !== 'scene') {
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
    // 新照片和事件叠层独立生图；场景和前景缓存可复用。同 key 并发生图去重；命中在途任务（多为静默预热）时，非静默调用落定后补发结果
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
      const baseKey = `${kind}_${sceneKey}_${crypto
        .createHash('md5')
        .update(
          'cinematic-spatial-background-v10-geometry-checked' +
            buildMediaPrompt(kind, styleTemplate, sceneBodies, theme, opts) +
            (opts.caption ?? '') +
            (opts.overlay?.url ?? opts.overlay?.file ?? opts.overlay?.base ?? ''),
        )
        .digest('hex')
        .slice(0, 10)}${kind === 'photo' || kind === 'overlay' ? `_${crypto.randomUUID()}` : ''}`;
      let key = baseKey;
      if (kind === 'scene') {
        const prefix = `${baseKey}_stage3_`;
        const cached = fs
          .readdirSync(dir)
          .find((name) => name.startsWith(prefix) && /_stage3_\d{3}_\d{3}\.jpg$/.test(name));
        const layoutKey = path.join(dir, baseKey);
        const layout =
          (cached && layoutFromUrl(`/${cached}`)) ||
          sceneLayouts.get(layoutKey) ||
          randomSceneLayout(deps.layoutRandom);
        sceneLayouts.set(layoutKey, layout);
        opts = { ...opts, layout };
        key = cached ? cached.slice(0, -4) : `${baseKey}_${layoutToken(layout)}`;
      }
      const file = path.join(dir, `${key}.jpg`);
      const url = `/media/${key}.jpg`;

      const prev = inflight.get(key);
      if (prev) {
        traceEvent('media.join_inflight', { kind, key, contextId: opts.contextId });
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

      const p = traceOperation('media.generate', { kind, theme, opts, key }, () => run(kind, theme, opts, key));
      inflight.set(key, p);
      void p.finally(() => {
        if (inflight.get(key) === p) inflight.delete(key);
        sceneLayouts.delete(path.join(dir, baseKey));
      });
    },
  };
}

export type GenImg = ReturnType<typeof createGenImg>;
