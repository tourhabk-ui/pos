# syntax=docker/dockerfile:1
# node:22-slim — совместимо с Timeweb (они используют node:24-slim, 22 LTS стабильнее)
FROM node:22-slim AS base

# ── 1. Dependencies ─────────────────────────────────────────────
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ── 2. Build ─────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS="--max-old-space-size=3072"
ENV WEBPACK_PARALLELISM=1

RUN npm run build

# ── 3. Runner ─────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static     ./.next/static
COPY --from=builder /app/public           ./public
COPY --from=builder /app/migrations                       ./migrations
COPY --from=builder /app/scripts/migrate-standalone.js    ./scripts/migrate-standalone.js
COPY --from=builder /app/start.js                         ./start.js

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# start.js: health proxy на :3000, Next.js на :3001
# Критично для Timeweb healthcheck (таймаут 3 минуты)
CMD ["node", "start.js"]
