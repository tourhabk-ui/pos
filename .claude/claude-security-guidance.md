# Security guidance — Ведар (Kamchatka tourism platform)

## Stack

Next.js 15 App Router, TypeScript strict, PostgreSQL (direct SQL via pg), JWT auth.
Production: Timeweb Cloud Docker container.

## Critical rules

### SQL
- ALL queries must use parameterized form: `$1, $2` — never string concatenation or template literals with user input
- Public route reads: only via `v_kamchatka_routes_api` view, never direct `kamchatka_routes`
- Explicit columns only — no `SELECT *` in production API routes

### Authentication
- Every protected API route must call `requireAuth`, `requireAdmin`, or `requireOperator` from `lib/auth/middleware.ts`
- JWT is verified server-side only — never trust client-supplied user IDs without verification
- Admin routes (`/api/admin/*`) must use `requireAdmin`
- Operator routes (`/api/operator/*`) must use `requireOperator`

### AI providers
- Never call `callOpenrouter`, `callAnthropicRaw`, `callDeepSeek`, `callMiMo` directly in app/ or lib/ (except `lib/ai/providers.ts` and health-probe files)
- Always use `callAIWaterfall()`, `callAIFast()`, or `callAIWithModel()` for AI calls

### Secrets
- No hardcoded API keys, JWT secrets, or credentials anywhere in code
- Keys only via `process.env.*` read through functions in `lib/ai/provider-config.ts`

### Input validation
- All API routes must validate input with Zod schemas
- UUIDs from URL params must be validated with regex or `z.string().uuid()` before use in SQL

### Payments
- `app/api/payments/` — CloudPayments webhook. Never modify HMAC verification logic
- `app/api/safety/sos` — emergency endpoint. No changes without explicit authorization

## Known safe patterns (do not flag)

- `as any` in `components/shared/LeafletMap.tsx` — Leaflet incomplete @types, justified
- Hex colors in LeafletMap SVG/Canvas code — CSS vars not accessible in JS canvas context
- `console.log` in `lib/database/migrate.ts` and `scripts/` — CLI deployment tools, intentional
- Emoji in `app/api/admin/` Telegram alert routes — intentional for Telegram formatting
- `FROM bookings` and `FROM tours` — these are compat VIEWs (migration 132), not missing tables
