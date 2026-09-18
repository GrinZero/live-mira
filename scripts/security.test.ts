import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { safeJoin, sendFile } from '../server/src/http-static.js';
import { RateLimiter } from '../server/src/auth.js';
import { ClientSession } from '../server/src/session.js';

// 安全回归：路径边界、流错误、限流器有界性、会话所有权、detach 身份校验

test('safeJoin rejects same-prefix sibling directories (media_evil escape)', () => {
  const root = path.join(os.tmpdir(), 'media');
  assert.equal(safeJoin(root, 'a.jpg'), path.join(root, 'a.jpg'));
  assert.equal(safeJoin(root, '..'), null);
  assert.equal(safeJoin(root, '../media_evil/x.jpg'), null);
  assert.equal(safeJoin(root, '../../etc/passwd'), null);
  assert.equal(safeJoin(root, 'sub/../../media_evil/x'), null);
  assert.equal(safeJoin(root, ''), root); // 根自身合法
});

test('sendFile answers 404 instead of crashing when the stream fails to open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sendfile-'));
  const missing = path.join(dir, 'gone.png');
  const res = {
    headersSent: false,
    code: 0,
    writeHead(this: { code: number; headersSent: boolean }, c: number) {
      this.code = c;
      this.headersSent = true;
    },
    end() {},
    destroy() {},
  };
  sendFile(res as unknown as http.ServerResponse, missing);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(res.code, 404);
});

test('RateLimiter enforces the window and keeps its key space bounded', () => {
  const rl = new RateLimiter(3, 60_000, 8);
  assert.equal(rl.ok('a'), true);
  assert.equal(rl.ok('a'), true);
  assert.equal(rl.ok('a'), true);
  assert.equal(rl.ok('a'), false); // 第 4 次超窗限
  assert.equal(rl.ok('b'), true); // 不同键互不影响
  for (let i = 0; i < 20000; i++) rl.ok(`flood-${i}`);
  assert.equal(rl.ok('a'), true); // 洪泛清扫后老键可重新计数（窗口未过期语义内）
});

// ClientSession 私有字段注入：只验 owns/detach 的所有权语义，不触碰 duplex
type SessionPriv = {
  clientToken: string;
  ws?: unknown;
  graceTimer?: NodeJS.Timeout;
  owns(t?: string): boolean;
  detach(ws: unknown): void;
  destroy(): Promise<void>;
};
const asPriv = (s: ClientSession) => s as unknown as SessionPriv;
const fakeWs = () => ({ readyState: 1, send() {}, close() {}, ping() {} });

test('session ownership requires a non-empty exact token match', async () => {
  const s = asPriv(new ClientSession('t'));
  try {
    assert.equal(s.owns('anything'), false); // 空令牌会话拒绝一切 reattach
    s.clientToken = 'tok-1';
    assert.equal(s.owns('tok-1'), true);
    assert.equal(s.owns('tok-2'), false);
    assert.equal(s.owns(undefined), false);
    assert.equal(s.owns(''), false);
  } finally {
    await s.destroy();
  }
});

test('detach only arms the grace timer for the current controlling socket', async () => {
  const s = asPriv(new ClientSession('t'));
  try {
    const old = fakeWs();
    const cur = fakeWs();
    s.ws = old;
    s.detach(cur); // 非当前控制端：不得启动宽限销毁
    assert.equal(s.graceTimer, undefined);
    s.ws = cur;
    s.detach(old); // 被踢旧连接的迟到 close：同样不得误杀
    assert.equal(s.graceTimer, undefined);
    s.detach(cur); // 当前控制端断开：进入 8s 宽限
    assert.ok(s.graceTimer);
  } finally {
    if (s.graceTimer) clearTimeout(s.graceTimer);
    await s.destroy();
  }
});
