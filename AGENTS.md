# 工程指南

暴雨夜咖啡馆 · 实时互动场景 demo。Node >= 22 / TypeScript strict / pnpm workspaces。

## 结构

- `server/` — HTTP + WS 会话服务器（tsx 直接跑 TS，无编译步骤）
- `shared/` — 前后端共享协议类型
- `web/` — Vite + React 19 + Three.js/VRM 前端（pnpm workspace `rainy-night-mira-web`）
- `scripts/` — 测试与探测脚本（tsx / node:test）
- `web/public/` — 静态资产；`mediapipe/`、`mock/` 为 vendored / fixture，不进 lint/format

## 常用命令

```bash
pnpm dev             # 同时起 server(8787) + vite(5173)
pnpm typecheck       # tsc --noEmit（根 + web）
pnpm lint            # eslint .（flat config，0 error 为通过）
pnpm lint:fix        # 自动修复
pnpm format          # prettier --write .
pnpm format:check    # prettier --check .
pnpm check           # typecheck + lint + format:check（提交前跑这个）
pnpm test            # node:test 单元测试（57 例，不需要起服务）
pnpm build           # web 生产构建（tsc -b && vite build）
```

## 约定

- 包管理器只用 **pnpm**（workspaces，根 `pnpm-lock.yaml` 为唯一锁文件，无 package-lock.json）。
- 未用变量/参数以 `_` 开头（lint 规则）。
- `as any` 允许但会 warning；测试/探测脚本中可接受。
- 构建产物、录制、缓存目录一律不进 git（见 `.gitignore`）。
