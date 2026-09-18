import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { config, hasKeys } from './config.js';
import { log, tail, subscribe } from './log.js';
import { ClientSession, getSession, liveSessionCount } from './session.js';
import { authEnabled, isAuthed, validToken, authCookie, authThrottled, RateLimiter } from './auth.js';
import { safeJoin, sendFile, sendJson } from './http-static.js';
import type { UpMessage } from '../../shared/protocol.js';

// HTTP：静态（web/dist）+ /assets + /media + /api/* ；WS：/ws
function readBody(req: http.IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('session', `http req fail ${req.url}: ${(e as Error).message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let p: string;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad_request' });
  }

  // 口令换 cookie：始终开放
  if (p === '/api/auth') {
    if (req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '?';
      if (authThrottled(ip)) return sendJson(res, 429, { ok: false, error: 'too_many_attempts' });
      let token = '';
      try {
        token = String(JSON.parse(await readBody(req)).token ?? '');
      } catch {
        /* noop */
      }
      if (!validToken(token)) return sendJson(res, 401, { ok: false });
      const secure =
        req.headers['x-forwarded-proto'] === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': authCookie(token, secure) });
      res.end('{"ok":true}');
      return;
    }
    return sendJson(res, 200, { required: authEnabled, ok: isAuthed(req) });
  }

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, keys: hasKeys(), mock: config.mockMode, ts: Date.now() });
  }

  // 门禁：/api/* /media/* /mock/* 需 cookie；静态外壳与 /assets（含打包产物、VRM）保持开放
  const gated = p.startsWith('/api/') || p.startsWith('/media/') || p.startsWith('/mock/');
  if (gated && !isAuthed(req)) return sendJson(res, 401, { error: 'unauthorized' });

  if (p === '/api/logs') {
    return sendJson(res, 200, tail(Number(url.searchParams.get('n') ?? 300)));
  }
  if (p.startsWith('/assets/')) {
    const f = safeJoin(config.assetsDir, p.slice(8));
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(res, f);
  }
  if (p.startsWith('/media/')) {
    const f = safeJoin(path.join(config.cacheDir, 'media'), p.slice(7));
    if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(res, f);
  }
  // 静态站点（生产模式服务 web/dist；dev 由 vite 代理 /assets /media /api /ws）
  const root = config.webDist;
  let f = safeJoin(root, p === '/' ? '/index.html' : p);
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return sendFile(res, f);
  f = path.join(root, 'index.html');
  if (fs.existsSync(f)) return sendFile(res, f);
  sendJson(res, 404, { error: 'not found (run `pnpm build` or use `pnpm dev`)' });
}

const wss = new WebSocketServer({ noServer: true });

type AliveWs = WebSocket & { isAlive?: boolean };

// 心跳：30s 一轮 ping，上一轮未 pong 的连接 terminate → 触发 close → 会话宽限销毁。
// 没有它，NAT/弱网下的半开 TCP 永远不触发 close，会话和付费 duplex 连接会常驻泄漏。
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const w = ws as AliveWs;
    if (w.isAlive === false) {
      w.terminate();
      continue;
    }
    w.isAlive = false;
    w.ping();
  }
}, 30_000);
heartbeat.unref();

// 新建会话按 IP 限流：duplex 连接是付费资源，hello→断连 循环可刷量
const helloLimiter = new RateLimiter(12, 60_000);

// WS 升级握手也要过门禁：所有付费 API 调用都经由 /ws
server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
  if (p !== '/ws' || !isAuthed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  (ws as AliveWs).isAlive = true;
  ws.on('pong', () => {
    (ws as AliveWs).isAlive = true;
  });
  let session: ClientSession | null = null;
  let resetting: Promise<void> | null = null;
  let connToken = ''; // 本连接首个 hello 绑定的会话令牌；reset 重建会话时沿用同一所有权
  let unsubLogs: (() => void) | undefined;
  const tag = `c${Math.random().toString(36).slice(2, 7)}`;
  log('ws', `client connected ${tag}`);

  const onMessage = async (raw: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
      await session?.onClientMessage(raw as Buffer);
      return;
    }
    let msg: UpMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // 日志下行按需订阅：默认不广播——日志含所有会话的对话内容，
    // 无条件下发等于把每个用户的对话实时推给所有在线客户端
    if (msg.type === 'debug') {
      if (!unsubLogs) {
        unsubLogs = subscribe((e) => {
          if (ws.readyState === ws.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'log', entry: e }));
            } catch {
              /* noop */
            }
          }
        });
      }
      return;
    }
    // reset 进行中的上行先等它落定，确保落在崭新的会话上（enter 不会打到半毁的旧会话）
    if (resetting) await resetting;
    if (!session) {
      if (msg.type !== 'hello') return;
      // 会话恢复：同进程内同 session_id + 会话令牌匹配 → 复用（浏览器断线重连场景）
      const prev = msg.session_id ? getSession(msg.session_id) : undefined;
      if (prev && msg.session_id) {
        if (!prev.owns(msg.client_token)) {
          log('ws', `reattach denied ${msg.session_id} (token mismatch)`);
        } else {
          log('ws', `reattach session ${msg.session_id}`);
          session = prev;
          session.attach(ws);
          return;
        }
      }
      const ip = req.socket.remoteAddress ?? '?';
      if (!helloLimiter.ok(ip)) {
        ws.send(JSON.stringify({ type: 'error', code: 'busy', message: '连接太频繁，稍后再来' }));
        ws.close();
        return;
      }
      if (liveSessionCount() >= config.maxSessions) {
        ws.send(JSON.stringify({ type: 'error', code: 'busy', message: '今夜客满，换个时间再来吧' }));
        ws.close();
        return;
      }
      session = new ClientSession(tag);
      connToken = msg.client_token ?? '';
      await session.start(ws, msg);
      return;
    }
    if (msg.type === 'reset') {
      // 整场归零：销毁当前会话（关 duplex、摘出 sessions），同一连接上原地重建
      log('ws', `reset ${tag}`);
      const old = session;
      resetting = (async () => {
        await old.destroy().catch((e) => log('session', `reset destroy fail: ${(e as Error).message}`));
        const fresh = new ClientSession(tag);
        session = fresh;
        await fresh
          .start(ws, { client_token: connToken })
          .catch((e) => log('session', `reset start fail: ${(e as Error).message}`));
      })();
      try {
        await resetting;
      } finally {
        resetting = null;
      }
      return;
    }
    await session.onClientMessage(msg);
  };

  // async 监听器不能裸挂：rejection 在 Node ≥15 是 unhandledRejection → 进程崩溃
  ws.on('message', (raw, isBinary) => {
    void onMessage(raw, isBinary).catch((e) => log('ws', `msg fail ${tag}: ${(e as Error).message}`));
  });

  ws.on('close', () => {
    unsubLogs?.();
    log('ws', `client gone ${tag}`);
    // 宽限 8s 供重连续接；超时销毁（先 session.close 再断连）
    session?.detach(ws);
  });
  ws.on('error', () => unsubLogs?.());
});

server.listen(config.port, () => {
  log('session', `rainy-night-mira server on http://localhost:${config.port} (keys=${hasKeys()} auth=${authEnabled})`);
});
