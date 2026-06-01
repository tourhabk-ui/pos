# syntax=docker/dockerfile:1
FROM node:22-slim AS base

# ── 1. Dependencies ─────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

# No native-binding packages (bcrypt/sharp/canvas) — no build tools needed.
# images.unoptimized:true in next.config.ts excludes sharp (~33 MB).
COPY package.json package-lock.json* ./
RUN npm ci --prefer-offline

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

# curl for HEALTHCHECK only — no other runtime deps needed
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

# start.js: health proxy on :3000, Next.js on :3001
# Timeweb healthcheck timeout is 3 min — start-period covers build+migrate time
HEALTHCHECK --interval=10s --timeout=5s --start-period=180s --retries=6 \
  CMD curl -sf http://localhost:3000/api/health || exit 1

CMD ["node", "start.js"]
