import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Local, always-on OTLP JSON journal. No sampling and no global log-ring dependency.
const context = new AsyncLocalStorage<{ trace: SessionTrace; spanId: string }>();
const nano = () => (BigInt(Date.now()) * 1000000n).toString();
const id = () => randomBytes(8).toString('hex');
const root = () => path.join(config.recordingsDir, 'traces');
const owner = (token: string) => createHash('sha256').update(token).digest('hex');
export function sanitize(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') };
  if (typeof value === 'string')
    return value
      .replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=]+/g, '[binary omitted]')
      .replace(/([?&](?:access|token|key|signature)=)[^&\s"']+/gi, '$1[redacted]')
      .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /^(authorization|.*api.?key|client_token|accessToken|audio)$/i.test(k) ? '[redacted]' : sanitize(v),
      ]),
    );
  return value;
}
const attrs = (data: unknown) => [
  { key: 'mira.data', value: { stringValue: JSON.stringify(sanitize(data)) ?? 'null' } },
];
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: ReturnType<typeof attrs>;
  status: { code: number; message?: string };
}
export class SessionTrace {
  readonly traceId = randomBytes(16).toString('hex');
  readonly rootId = id();
  private file = '';
  private pending = Promise.resolve();
  private failure = '';
  private active = new Map<string, Span>();
  private started = nano();
  bind(token: string) {
    const dir = path.join(root(), owner(token));
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.file = path.join(dir, `${this.traceId}.jsonl`);
      this.write(this.rootSpan(false));
    } catch (e) {
      this.failure = String(e);
    }
  }
  private rootSpan(ended: boolean): Span {
    return {
      traceId: this.traceId,
      spanId: this.rootId,
      name: 'mira.session',
      kind: 1,
      startTimeUnixNano: this.started,
      endTimeUnixNano: nano(),
      attributes: attrs({ ended, recordingError: this.failure || undefined }),
      status: { code: 0 },
    };
  }
  private write(span: Span) {
    if (!this.file || this.failure) return;
    const line = JSON.stringify(span) + '\n';
    this.pending = this.pending
      .then(() => fs.promises.appendFile(this.file, line, { mode: 0o600 }))
      .catch((e) => {
        this.failure = String(e);
        console.error('Session diagnostics write failed', e);
      });
  }
  run<T>(fn: () => T): T {
    return context.run({ trace: this, spanId: this.rootId }, fn);
  }
  event(name: string, data?: unknown) {
    const now = nano();
    this.write({
      traceId: this.traceId,
      spanId: id(),
      parentSpanId: context.getStore()?.trace === this ? context.getStore()!.spanId : this.rootId,
      name,
      kind: 1,
      startTimeUnixNano: now,
      endTimeUnixNano: now,
      attributes: attrs(data),
      status: { code: 0 },
    });
  }
  async operation<T>(name: string, data: unknown, fn: () => Promise<T>): Promise<T> {
    const span: Span = {
      traceId: this.traceId,
      spanId: id(),
      parentSpanId: context.getStore()?.trace === this ? context.getStore()!.spanId : this.rootId,
      name,
      kind: 1,
      startTimeUnixNano: nano(),
      endTimeUnixNano: nano(),
      attributes: attrs({ input: data, inProgress: true }),
      status: { code: 0 },
    };
    this.active.set(span.spanId, span);
    this.write(span);
    return context.run({ trace: this, spanId: span.spanId }, async () => {
      try {
        const result = await fn();
        span.attributes = attrs({ input: data, output: result });
        span.status = { code: 1 };
        return result;
      } catch (e) {
        span.attributes = attrs({ input: data, error: String(e) });
        span.status = { code: 2, message: String(sanitize(String(e))) };
        throw e;
      } finally {
        span.endTimeUnixNano = nano();
        this.active.delete(span.spanId);
        this.write(span);
      }
    });
  }
  async flush(ended = false) {
    this.write(this.rootSpan(ended));
    for (const span of this.active.values()) this.write({ ...span, endTimeUnixNano: nano() });
    await this.pending;
    if (this.failure) throw new Error(`Diagnostics incomplete: ${this.failure}`);
  }
}
export function traceEvent(name: string, data?: unknown) {
  context.getStore()?.trace.event(name, data);
}
export function traceOperation<T>(name: string, data: unknown, fn: () => Promise<T>): Promise<T> {
  return context.getStore()?.trace.operation(name, data, fn) ?? fn();
}
export async function listTraces(token: string) {
  const dir = path.join(root(), owner(token));
  if (!fs.existsSync(dir)) return [];
  return Promise.all(
    (await fs.promises.readdir(dir))
      .filter((f) => /^[a-f0-9]{32}\.jsonl$/.test(f))
      .map(async (f) => ({ id: f.slice(0, -6), updatedAt: (await fs.promises.stat(path.join(dir, f))).mtimeMs })),
  );
}
export async function exportTrace(token: string, traceId: string) {
  if (!/^[a-f0-9]{32}$/.test(traceId)) return null;
  const file = path.join(root(), owner(token), `${traceId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  const spans = new Map<string, Span>();
  const text = await fs.promises.readFile(file, 'utf8');
  // A crash or concurrent append may leave an incomplete final line.
  const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
  for (const line of lines.filter(Boolean)) {
    const span = JSON.parse(line) as Span;
    spans.set(span.spanId, span);
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'rainy-night-mira' } },
            { key: 'mira.export.incomplete_tail', value: { boolValue: text.length > 0 && !text.endsWith('\n') } },
            { key: 'mira.session.id', value: { stringValue: traceId } },
          ],
        },
        scopeSpans: [{ scope: { name: 'mira.session-diagnostics', version: '1' }, spans: [...spans.values()] }],
      },
    ],
  };
}
