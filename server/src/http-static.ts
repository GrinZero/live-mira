import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// 静态文件服务原语：MIME、安全响应头、带流错误处理的 sendFile、分隔符边界的 safeJoin。
// 独立成模块以便脱离 server.listen 做单元测试。

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.vrm': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.pcm': 'application/octet-stream',
};

export const SEC_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(res: http.ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function sendFile(res: http.ServerResponse, file: string, privateAsset = false) {
  const ext = path.extname(file).toLowerCase();
  const stream = fs.createReadStream(file);
  // existsSync → open 之间文件可能消失（TOCTOU）：先挂错误处理，open 成功才写头
  stream.on('open', () => {
    res.writeHead(200, {
      ...SEC_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': privateAsset ? 'private, no-store' : ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    stream.pipe(res);
  });
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 404, { error: 'not found' });
    else res.destroy();
  });
}

export function safeJoin(root: string, p: string): string | null {
  const full = path.normalize(path.join(root, p));
  // 分隔符边界：startsWith(root) 会让同前缀兄弟目录（media_evil/）逃逸
  return full === root || full.startsWith(root + path.sep) ? full : null;
}
