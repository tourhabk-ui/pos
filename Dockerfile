# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

# ── 1. Dependencies ─────────────────────────────────────────────
FROM base AS deps
# Устойчивость к недоступности dl-cdn.alpinelinux.org (Fastly; с билд-серверов
# Timeweb периодически TLS-ошибки — деплой 19.07 падал именно здесь): при
# провале переключаем apk-репозитории на зеркало Яндекса, оно из РФ стабильно.
RUN apk add --no-cache libc6-compat || \
    (sed -i 's#https://dl-cdn.alpinelinux.org#https://mirror.yandex.ru/mirrors#g' /etc/apk/repositories \
     && apk add --no-cache libc6-compat)
WORKDIR /app

COPY package.json package-lock.json* ./
# Skip onnxruntime GPU binary download (times out on Timeweb build servers)
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
# Устойчивость к флапу сети на билд-серверах Timeweb: реестр npm иногда
# отваливается по таймауту (ETIMEDOUT / "Exit handler never called"), и весь
# деплой падает. Ретраи с бэкоффом + длинные таймауты переживают такой обрыв;
# --no-audit/--no-fund убирают лишние сетевые походы.
RUN npm ci --no-audit --no-fund \
  --fetch-retries=5 \
  --fetch-retry-factor=3 \
  --fetch-retry-mintimeout=20000 \
  --fetch-retry-maxtimeout=120000

# ── 2. Build ─────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=3072"
ENV WEBPACK_PARALLELISM=1

# Версионный маркер деплоя: vedarai.ru/version.json — какой коммит и когда
# собран. Workflows ждут нужную версию вместо слепых таймеров (deploy-race).
# sha берётся из .git/HEAD (re-include в .dockerignore): Timeweb собирает
# в detached HEAD, значит там чистый sha; иначе — 'unknown' (локальный билд).
RUN node -e "const fs=require('fs');let sha='unknown';try{const h=fs.readFileSync('.git/HEAD','utf8').trim();if(/^[0-9a-f]{40}$/.test(h))sha=h;}catch(e){};fs.mkdirSync('public',{recursive:true});fs.writeFileSync('public/version.json',JSON.stringify({commit:sha,built_at:new Date().toISOString()}));"

# Вызываем локальный бинарь next напрямую, а НЕ через npx: npx при неполном
# node_modules лезет в реестр за next и виснет по ETIMEDOUT. Локальный путь
# гарантированно не ходит в сеть на этапе сборки.
RUN rm -rf .next && node_modules/.bin/next build

# ── 3. Runner ─────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

# libc6-compat needed for sharp / native modules at runtime
RUN apk add --no-cache libc6-compat

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public           ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static     ./.next/static
COPY --from=builder /app/migrations                       ./migrations
COPY --from=builder /app/scripts/migrate-standalone.js    ./scripts/migrate-standalone.js
COPY --from=builder /app/start.js                         ./start.js

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# start.js: lightweight health proxy on :3000 that instantly answers
# /api/health while Next.js boots on :3001. Critical for Timeweb
# healthcheck which times out after 3 minutes.
CMD ["node", "start.js"]
