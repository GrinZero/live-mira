import { traceOperation } from './telemetry.js';
import { config } from './config.js';

// 方舟 API 客户端：chat/completions（导演决策）+ images/generations（Seedream）
export async function arkChat(opts: {
  model?: string;
  system: string;
  user: string;
  image?: string;
  images?: string[];
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  return traceOperation('provider.arkChat', opts, async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 5000);
    try {
      const res = await fetch(`${config.arkBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.seedApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model || config.directorModel,
          messages: [
            { role: 'system', content: opts.system },
            {
              role: 'user',
              content:
                opts.image || opts.images?.length
                  ? [
                      { type: 'text', text: opts.user },
                      ...(opts.images ?? [opts.image!]).map((url) => ({ type: 'image_url', image_url: { url } })),
                    ]
                  : opts.user,
            },
          ],
          max_tokens: opts.maxTokens ?? 400,
          temperature: opts.temperature ?? 0.7,
          thinking: { type: 'disabled' },
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`ark chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const d = (await res.json()) as { choices: { message: { content: string } }[] };
      return d.choices[0]?.message?.content ?? '';
    } finally {
      clearTimeout(timer);
    }
  });
}

export interface ArkImageResult {
  url: string;
  size: string;
}

export async function arkImage(opts: {
  prompt: string;
  size?: string;
  timeoutMs?: number;
  image?: string; // Seedream 图编辑：参考图（URL 或 base64 data URI）
}): Promise<ArkImageResult> {
  return traceOperation('provider.arkImage', opts, async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60000);
    try {
      const res = await fetch(`${config.arkBase}/images/generations`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.seedApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.genimgModel,
          prompt: opts.prompt,
          size: opts.size || config.genimgSize,
          response_format: 'url',
          watermark: false,
          ...(opts.image ? { image: opts.image } : {}),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`ark image ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const d = (await res.json()) as { data: { url: string; size: string }[] };
      const item = d.data?.[0];
      if (!item?.url) throw new Error('ark image: empty data');
      return item;
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function download(url: string, timeoutMs = 30000): Promise<Buffer> {
  return traceOperation('provider.download', { url, timeoutMs }, async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`download ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  });
}
