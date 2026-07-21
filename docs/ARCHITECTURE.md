# Архитектура Ведар (KamchatourHub / TourHab / Volcano OS)

> Живой словарь доменов и карта кода. Пишется по факту после реорга «застывших
> метаний» (Этапы 0–8). Правило: **один домен — одно место**.
> Где расходится с `CLAUDE.md` по путям `lib/services/*` — **актуален этот файл**
> (`CLAUDE.md` заморожен несгораемым списком реорга; §4 там указывает старые
> плоские пути до доменного разбиения).

Обновлено: июль 2026 · Стек и правила — `CLAUDE.md`, память — `.claude/MEMORY.md`.

---

## 1. Три сущности данных (master)

Точка, маршрут и тур — разные вещи, три таблицы. Подробности и связи — `CLAUDE.md §4.1`.

| Сущность | Master-таблица | Что это |
|----------|---------------|---------|
| **Точка/локация** | `places` | Гео-факт: вулкан, озеро, источник. Постоянна. |
| **Маршрут** | `kamchatka_routes` | Путь между точками. Может меняться. |
| **Тур** | `operator_tours` | Коммерческий продукт оператора. Цена, слоты, бронь. |

Карточки: точка — `app/places/[id]`, маршрут — `app/routes/[id]`, тур — `app/marketplace|catalog/tours/[id]`.
`agent_route_knowledge` — VIEW (UNION `places` + `kamchatka_routes`), писать в master-таблицы.

---

## 2. Домены и правило размещения

**Правило:** доменная логика живёт в `lib/<домен>/` или `lib/services/<домен>/`; UI — в
`components/<домен>/`; страницы — в `app/`. Новый код домена кладём рядом с существующим,
не заводим второе место.

### 2.1 Подбор тура — 3 движка + Кузьмич (не трогать границы)

```
ЛИДЫ    lib/services/operators/lead-processor.service.ts — квалификация лида → 3 тура + PDF
ПЛАНЕР  lib/planner/  — планирование поездки (engine · compose · data · intelligence · interests). Баррел: lib/planner
ПОИСК   lib/search/   — поиск туров (tour-search · tour-recommend). Баррел: lib/search
КУЗЬМИЧ lib/kuzmich/  — чат-поверхность, зовёт движки выше; своего подбора НЕТ
```
Отдельно: `lib/routes/catalog-query.ts` — поиск МАРШРУТОВ/МЕСТ (другой домен, не туры).
Запрещено заводить новый «движок подбора» вне этих трёх — расширять существующий.

### 2.2 Безопасность (safety-first, offline-first)

- Детерминированные гварды (не самоотчёт модели): `lib/safety/sos-detector.ts`
  (`withSosBlock`/`detectEmergency`), `lib/safety/emergency-numbers.ts` (единый источник
  экстренных номеров, 112-first), `lib/safety/safety-selfcheck.ts` (синтетический прогон
  инвариантов, cron `app/api/cron/safety-check`).
- Экран без связи: `app/offline/page.tsx` (112 tap-to-call, ноль сети/JS/БД, precache).
- Safety-сервисы данных: `lib/services/safety/` (сейсмика, воздух, погода зон, KVERT ACC,
  покрытие спасателей, контакты).

### 2.3 Честные цифры

Единый источник — `lib/stats/platform-counts.ts` (+ `lib/stats/element-groups.ts`).
Потребители: `app/page.tsx`, `app/_home/data.ts`, `components/homepage/EditorialSection.tsx`.
Guard-тест `tests/unit/platform-counts.test.ts` не даёт разнобою вернуться.

---

## 3. Карта lib/services/ (после реорга, Этапы 4–8)

Домены — в подпапках; core/platform — в корне (не разбросан, уже «одно место»).

| Подпапка | Файлы |
|----------|-------|
| `tours/` | tour.service, booking.service, booking-funnel-stages, dynamic-pricing, tours-visitkamchatka |
| `routes/` | route-description-cache, route-preflight-safety, routes-geometry-health, places-quality, geocode |
| `safety/` | emergency-contacts, rescue-coverage, seismic-feed, seismic-parser, air-quality, zone-weather, kvert-vona |
| `operators/` | operator-registry.service (+.test), partner.service, lead-processor.service, notification.service, operator-tour-scraper, review.service, support.service, chat.service |
| `ingest/` | visitkamchatka-{importer,audit,gpx-importer,guides,operators}, idilesom-importer, legislation-importer, osm-traces-scout, firecrawl, mistral-ocr, wikimedia-photos, ai-image-generator |
| корень (core/platform) | payment, search, rag, analytics, flights, hotels, insurance, transfers, travelpayouts, profanity-filter, query-expansion-health, data-inventory, data-repair, offline-readiness, intelligence-monitor, `_helpers`, `_errors`, `index` (barrel) |

Баррел `lib/services/index.ts` реэкспортит доменные сервисы по новым путям.

---

## 4. Ключевые модули вне services

| Домен | Путь |
|-------|------|
| БД | `lib/db-pool.ts` (`import { pool }`), `lib/database.ts`, типы строк — `lib/types/db-rows.ts` |
| Auth | `lib/auth.ts` (JWT, §7 заморожен), `lib/auth/` (helpers, jwt, middleware, роли), `lib/auth/middleware.ts` |
| Мониторинг | `lib/monitoring/logger.ts` |
| AI-провайдеры | `lib/ai/providers.ts` — только через `callToolsWaterfall`/`callAIFast` (Qwen→DeepSeek→OpenRouter) |
| PDF / нотификации | `lib/pdf/proposal-generator.ts`, `lib/notifications/lead-notify.ts` |
| Агенты | `lib/agents/` (watchdog, editor, scout-digest) — реестр в `AGENTS.md` |

---

## 5. Несгораемое (реорг не трогает)

`migrations/` (только вперёд) · API-пути `app/api/**/route.ts` (боты/вебхуки/cron заморожены —
внутри меняем только импорты) · существующие 301 в `next.config.js` (только добавлять) ·
sitemap-URL (переезд → обязательный 301) · `CLAUDE.md`/`AGENTS.md` · SSR-листинги
`/routes`,`/operators`,`/catalog` · SOS-флоу `/sos`,`/emergency` (отдельным PR + полевой тест).

---

## 6. Статус реорга

| Этап | Что | Статус |
|------|-----|--------|
| 0 | Инвентаризация (`docs/REORG_STAGE0_INVENTORY.md`) | ✅ |
| 1 | Двойные X.ts+X/ (удалить мёртвые половины) | ✅ |
| 2 | `home-v7` → `app/_home` (+301) | ✅ |
| 3 | Честные цифры (единый источник) | ✅ |
| 4–8 | Расформировать `lib/services/` по доменам | ✅ |
| 9 | Развести route-дубли (+301) | ⏳ user-facing URL — по решению владельца |
| 10 | Удалить подтверждённо-мёртвое | ⏳ пофайловое «да» владельца (см. инвентарь Этапа 0) |
| 11 | Этот файл | ✅ |

**Остаток (владельцу на решение):**
- **Этап 9** — кандидаты на 301: `/dashboard`→`/hub` (вероятный legacy-дубль). Пары
  `/ai-tools`↔`/tools` и `/on-route`↔`/trip`↔`/planning` — проверить, дубли ли (разное
  назначение возможно). `/emergency`↔`/sos` — отдельно (§7 + полевой тест).
- **Этап 10** — мёртвые кандидаты из инвентаря: barrel'ы (уже сняты в Этапе 1), кластер
  `lib/agents/scheduler`+`agencies/*` (остатки удалённого «совета»), `lib/env.ts`,
  `lib/events/subscribers.ts`, `lib/middleware/{validation,rate-limit}` — удалять только
  после пофайлового подтверждения.
