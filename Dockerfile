# syntax=docker/dockerfile:1

# ---- 构建阶段：全量依赖 + check + 前端构建 ----
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm check && pnpm build

# ---- 运行阶段：仅生产依赖 + 产物，非 root 运行 ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN pnpm install --frozen-lockfile --prod
COPY server ./server/
COPY shared ./shared/
COPY content ./content/
COPY assets ./assets/
COPY --from=build /app/web/dist ./web/dist
# cache/（生图落盘）与 recordings/（可选录制）运行期写入
RUN mkdir -p cache recordings && chown -R node:node /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
