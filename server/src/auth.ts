import crypto from 'node:crypto';
import type http from 'node:http';
import { config } from './config.js';

// 静态口令门禁：配置 ACCESS_TOKENS 才启用；未配置 = 本地开发全放行
export const authEnabled = config.accessTokens.length > 0;

const COOKIE = 'mira_auth';

// 常量时间比对：includes() 逐字符短路会泄露 token 前缀长度信息
function tokenEq(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function isAuthed(req: http.IncomingMessage): boolean {
  if (!authEnabled) return true;
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0 || part.slice(0, eq).trim() !== COOKIE) continue;
    try {
      const v = decodeURIComponent(part.slice(eq + 1).trim());
      if (config.accessTokens.some((t) => tokenEq(t, v))) return true;
    } catch {
      /* malformed cookie */
    }
  }
  return false;
}

export function validToken(t: string): boolean {
  return authEnabled && config.accessTokens.some((x) => tokenEq(x, t));
}

export function authCookie(token: string, secure: boolean): string {
  const s = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`;
  return secure ? `${s}; Secure` : s;
}

// 滑动窗口限流器：键空间有界——达到上限先清扫过期项，仍在窗口内的洪泛则整体清空
// （宁可误伤同窗口真用户，也不让 map 在分布式爆破下无界增长）
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
    private maxKeys = 4096,
  ) {}
  ok(key: string): boolean {
    const now = Date.now();
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (now > v.reset) this.hits.delete(k);
      if (this.hits.size >= this.maxKeys * 2) this.hits.clear();
    }
    const h = this.hits.get(key);
    if (!h || now > h.reset) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    return ++h.n <= this.limit;
  }
}

// /api/auth 防爆破：同 IP 10 分钟内最多 20 次尝试
const authAttempts = new RateLimiter(20, 600_000);
export function authThrottled(ip: string): boolean {
  return !authAttempts.ok(ip);
}
