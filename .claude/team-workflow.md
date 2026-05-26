# Ведар — Team Workflow & Operations Guide

> Обновлено: Май 2026 | Стек: Next.js 15, TypeScript, PostgreSQL, Timeweb Cloud

---

## 1. ДЕПЛОЙ

```bash
npx tsc --noEmit        # 0 ошибок — обязательно перед push
git push origin main    # → автодеплой Timeweb (~5-7 минут)
```

**Timeweb-специфика:**
- Timeweb игнорирует наш Dockerfile — использует свой auto-generated
- `@types/*` — в `dependencies`, НЕ `devDependencies` (`NODE_ENV=production`)
- Логи: Timeweb Cloud панель → App ID 159529

**Env переменные (только на Timeweb, никогда в коде):**

| Переменная | Назначение |
|-----------|-----------|
| `DATABASE_URL` | PostgreSQL подключение |
| `JWT_SECRET` | Подписание JWT токенов |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHANNEL_ID` | Telegram алерты |
| `CLOUDPAYMENTS_PUBLIC_ID`, `CLOUDPAYMENTS_SECRET` | Платёжная система |
| `CRON_SECRET` | Защита cron endpoints |
| `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Хранилище файлов |
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | Email |
| `NEXT_PUBLIC_YANDEX_MAPS_APIKEY`, `NEXT_PUBLIC_YANDEX_METRIKA_ID` | Яндекс сервисы |
| **AI провайдеры:** | |
| `OPENROUTER_API_KEY` | OpenRouter — основной провайдер (Gemini, GPT, Llama, DeepSeek) |
| `DEEPSEEK_API_KEY` | DeepSeek API напрямую |
| `GEMINI_API_KEY` | Google Gemini напрямую |
| `ANTHROPIC_API_KEY` | Claude API напрямую |
| `XAI_API_KEY` | xAI Grok |
| `XIAOMI_API_KEY` | MiMo (Xiaomi) |
| `MINIMAX_API_KEY` | MiniMax |
| `YANDEX_API_KEY`, `YANDEX_FOLDER_ID` | YandexGPT |

---

## 2. МИГРАЦИИ БД

```
Следующая миграция: 053_name.sql
Не трогать: 001–050
```

**Применение:**
1. Создать `migrations/0NN_name.sql` с `BEGIN; ... COMMIT;`
2. Создать `app/api/mig0NN/route.ts` (GET endpoint читает файл, выполняет SQL)
3. Задеплоить → `https://vedarai.ru/api/mig0NN`
4. Убедиться в идемпотентности (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`)

**Применённые миграции (ключевые):**
- 040–041: operator_tours, tour_availability, operator_bookings
- 045: v_route_marketplace (источник: operator_tours)
- 048: loyalty_transactions, promo_codes, referrals
- 050: octo_api_keys, tour_options, octo_booking_log
- 051: tour_payments, operator_payouts
- 052: operator_applications, profile_status, onboarding_completed
- 053: octo_webhook_log, webhook_url/secret в octo_api_keys
- 054: agent_clients, agent_bookings, agent_commissions, commission_payouts
- 055: tour_pricing_rules, agent_referral_links, agent_referral_events

---

## 3. CRON ЗАДАЧИ (cron-job.org)

| URL | Интервал | Назначение |
|-----|----------|-----------|
| `/api/cron/leads-followup?secret=<CRON_SECRET>` | каждые 30 мин | Уведомление операторов о лидах |
| `/api/cron/payouts?secret=<CRON_SECRET>` | каждый час | HELD→RELEASED после 36ч |

**Диагностика:** лог на cron-job.org → должен быть HTTP 200.

---

## 4. КОНТЕНТ

### Новая точка/место (`places`)
```sql
INSERT INTO places (name, lat, lng, location_type, description, zone, is_visible)
VALUES ('Вулкан Корякский', 53.322, 158.686, 'volcano',
  'Описание ≥300 символов...', 'avachinsky', TRUE);
-- После вставки создать профили:
INSERT INTO location_safety_profile (agent_route_id, ...) VALUES (NEW.ark_id, ...);
INSERT INTO location_real_time_status (agent_route_id, ...) VALUES (NEW.ark_id, ...);
```

### Новый маршрут (`kamchatka_routes`)
```sql
INSERT INTO kamchatka_routes (title, description, distance_km, difficulty, zone, is_visible)
VALUES ('Маршрут к кратеру', 'Описание...', 12.5, 'hard', 'avachinsky', TRUE);
-- Связать с точками через route_waypoints
INSERT INTO route_waypoints (route_id, place_id, position) VALUES (route_id, place_id, 0);
```

> ⚠️ `agent_route_knowledge` — теперь VIEW (Migration 663). Прямой INSERT запрещён.
> Старая таблица: `_agent_route_knowledge_legacy` — не трогать.

### Не применённые seed-скрипты (ждут операторов)
- `scripts/seed-operator-topkam.sql`
- `scripts/seed-operator-kamchatintour.sql`
- `scripts/seed-operator-vulkangid.sql`
- `scripts/seed-operator-kamchatka-wild.sql`

---

## 5. ИНСТРУМЕНТЫ РАЗРАБОТЧИКА

### PostgreSQL MCP (Claude Code)
Настроен в `.claude/settings.json`. При старте сессии Claude Code автоматически
подключается к БД через `@modelcontextprotocol/server-postgres` (читает `DATABASE_URL`).
Позволяет напрямую запрашивать схему, данные и планы запросов из чата.
```
/mcp  — проверить статус подключения
```

### Claude Code Router
Шаблон конфига в `.claude/ccr-config.json`. Маршрутизация по типу задачи:
- `default` → OpenRouter / Claude Sonnet (стандарт)
- `background` → DeepSeek (дешевле для агентов и cron)
- `think` → Claude Opus (архитектурные решения)
- `longContext` → Gemini Flash (большие файлы)

Установка: `npm install -g claude-code-router`
Скопировать `ccr-config.json` в `~/.claude-code-router/config.json` с реальными ключами.

### AI Waterfall (lib/ai/providers.ts)
Все AI-вызовы в продакшн-коде — только через `callAIWaterfall()` или `callAIFast()`.
Прямые вызовы (`callDeepSeek`, `callOpenrouter` и т.д.) — только в `lib/ai/providers.ts`.
Порядок fallback: OpenRouter → DeepSeek → Gemini → MiMo → GLM → Nvidia → MuseSpark → Yandex → MiniMax → Anthropic.
Диагностика: `GET /api/ai/health?token=kamhub-debug-2026`

---

## 6. АРХИТЕКТУРНЫЕ ПРАВИЛА

```
ЗАПРЕЩЕНО:
  import pool from                   →  import { pool } from '@/lib/db-pool'
  SELECT * FROM kamchatka_routes     →  только v_kamchatka_routes_api
  FROM bookings                      →  только FROM operator_bookings (колонка: booking_status, не status)
  FROM tours                         →  только FROM operator_tours
  INSERT INTO agent_route_knowledge  →  писать в places / kamchatka_routes
  callDeepSeek() / callOpenrouter()  →  только callAIWaterfall() / callAIFast()
  fetch('https://vedarai.ru')        →  в server components таймаутит — import { query }
  console.log в app/                 →  запрещён (console.error — допустим только в catch)
  Хардкод hex цветов                 →  только var(--token)
  Glassmorphism                      →  абсолютно запрещён
  Эмодзи в .tsx                      →  только lucide-react иконки
  any в TypeScript                    →  только unknown + type guards
  JSONB ->  оператор                 →  предпочитать ->> для строк
```

**Паттерн API route:**
```typescript
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
export const dynamic = 'force-dynamic';

const Schema = z.object({ ... });

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const parsed = Schema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: '...' }, { status: 400 });
  const { rows } = await pool.query('SELECT ... WHERE id = $1', [parsed.data.id]);
  return NextResponse.json({ success: true, data: rows[0] });
}
```

**Публичные API роуты** — добавлять в `middleware.ts` массив `PUBLIC_API_ROUTES`.

---

## 7. ФИНАНСОВЫЙ КОНТУР

```
Турист платит → CloudPayments webhook → tour_payments (HELD)
Тур + 36ч → cron/payouts → tour_payments (RELEASED)
Admin trigger → operator_payouts (PENDING→PAID)
```

**Комиссия:** 15% → 12% (100k/мес) → 10% (500k) → 8% (1M).
Функция: `recalculate_commission(partner_id)` — вызывается автоматически.

---

## 8. OCTO API

**Файлы:** `lib/octo/` (auth, schemas, service, mappers, webhooks) + `app/api/octo/`

**Создать API ключ для OTA:** `POST /api/admin/octo-keys`

**Self-certification (не пройдена):**
1. Установить OCTO test suite
2. Запустить тесты против staging
3. Подать заявку Tiqets/Headout Partnership

---

## 9. СПЛАВЫ — СТАТУС

| Что | Статус |
|-----|--------|
| 84 маршрута `boat_trip` в knowledge base | В БД, видны на карте |
| `scripts/seed-place-bystraya-splav.sql` | Закомичен, применить psql |
| Тур "Голубые озёра + сплав" (topkam) | В seed-скрипте, не применён |
| Специализированный оператор сплавов | **Нет** — искать |

**Следующий шаг:** связаться с Катериной (источник данных о Быстрой — Telegram-группа операторов) как потенциальным оператором сплавов.

---

> vedarai.ru | Admin: /hub/admin | App ID: 159529 | Branch: main (auto-deploy) | MCP: postgres | AI: callAIWaterfall()
