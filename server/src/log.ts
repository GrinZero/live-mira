import { traceEvent } from './telemetry.js';
import type { LogEntry } from '../../shared/protocol.js';

const BUF_MAX = 800;
const buf: LogEntry[] = [];
const subs = new Set<(e: LogEntry) => void>();

export function log(cat: LogEntry['cat'], msg: string, data?: unknown) {
  traceEvent(`log.${cat}`, { msg, data });
  const e: LogEntry = { ts: Date.now(), cat, msg, data };
  buf.push(e);
  if (buf.length > BUF_MAX) buf.shift();
  const slim = data === undefined ? '' : ` ${JSON.stringify(data)?.slice(0, 300)}`;
  console.log(`[${new Date(e.ts).toISOString().slice(11, 23)}][${cat}] ${msg}${slim}`);
  for (const fn of subs) {
    try {
      fn(e);
    } catch {
      /* noop */
    }
  }
}

export function tail(n = 200): LogEntry[] {
  return buf.slice(-n);
}
export function subscribe(fn: (e: LogEntry) => void) {
  subs.add(fn);
  return () => subs.delete(fn);
}
