# Ведар — путеводитель разработчика

> Единственный вход для нового человека: что это, как запустить, где что лежит,
> как устроены неочевидные части и как отлаживать. Всё остальное — по ссылкам
> отсюда. Цифры сняты 2026-09-10 переписью репозитория (команды в §9), не из
> памяти; когда они устареют — перемерить, не переписывать.
>
> Правила кода и запреты — `CLAUDE.md` (их здесь не дублируем). Схема базы —
> `docs/DB_SCHEMA.md` (порождается из настоящего PostgreSQL). Агенты — `AGENTS.md`.

---

## 0. Что это за платформа — за одну минуту

Ведар (KamchatourHub / TourHab / Volcano OS) — туристическая платформа Камчатки.
Стоит на одном требовании: **турист должен быть в безопасности**, поэтому карта,
маршрут и SOS обязаны работать без интернета.

У туриста ровно две дороги, и всё остальное существует ради них:

```
                 ┌─────────────────────────────────────────────────┐
  Турист зашёл → │ 1. Нашёл МАРШРУТ: карта + трек + опасности +   │ → пошёл сам
                 │    регистрация МЧС + полевой режим + SOS        │
                 ├─────────────────────────────────────────────────┤
                 │ 2. Купил ТУР у проверенного оператора:           │ → оператор
                 │    каталог → карточка → бронь → оплата           │   получил деньги
                 └─────────────────────────────────────────────────┘
```

Три сущности — три таблицы, и их нельзя смешивать (CLAUDE.md §4.1):

| Сущность | Таблица | Что это | Экран |
|---|---|---|---|
| Точка | `places` | географический факт: вулкан, озеро | `/places/[id]` |
| Маршрут | `kamchatka_routes` | путь между точками, трек, опасности | `/routes/[id]` |
| Тур | `operator_tours` | коммерческое предложение оператора | `/catalog/tours/[id]` |

Вокруг двух дорог выросли кабинеты (оператор, гид, жильё, снаряжение, перевозчик,
турагент, админ), ИИ-помощник Кузьмич и большой контур самонаблюдения (кроны,
переписи, сторожа). Их объём в §8 — там же честно сказано, что из этого нужно
туристу, а что машине.

---

## 1. Быстрый старт (локально, ~20 минут)

**Требования:** Node 22, PostgreSQL 16+ (расширения `pg_trgm`, `btree_gin`,
`uuid-ossp` — они в стандартной поставке), Python 3 (для скриптов CI).

```bash
npm ci
cp .env.example .env.local        # заполнить DATABASE_URL и JWT_SECRET — остальное по мере нужды
```

### 1.1 База: миграции с нуля НЕ проигрываются

Каталог `migrations/` начинается с `017_` — цепочка писалась поверх живой базы,
и первый же файл упадёт на несуществующей `bookings`. Штатный путь — baseline
прода плюс миграции новее него:

```bash
createdb vedar_dev
export DATABASE_URL=postgresql://user:pass@localhost:5432/vedar_dev

node scripts/bootstrap-from-baseline.js          # схема прода от 2026-08-15, помечает ВСЕ миграции применёнными
psql vedar_dev -c "DELETE FROM _migrations WHERE name >= '863'"   # 863 — первая после baseline
npm run migrate                                  # накатывает 863..N
```

Почему `863`: baseline снят 2026-08-15, последней миграцией того дня была 862
(`migrations/MIGRATION_ORDER.md`). Bootstrap помечает все файлы применёнными,
потому что его назначение — восстановление прода, а не dev-база; для dev
хвост надо «разпометить».

Данных в baseline нет. Каталог мест и маршрутов — импортами
(`npm run db:import:kamchatka-routes` и скрипты `scripts/import-*`), но для
работы над UI хватает пустой схемы и пары строк руками.

### 1.2 Запуск и гейт

```bash
npm run dev                # http://localhost:3000
npx tsc --noEmit           # 0 ошибок — обязательно
npx vitest run             # весь набор; один файл: npx vitest run tests/unit/имя.test.ts
npm run lint               # 0 ошибок; предупреждения не блокируют (CLAUDE.md §6)
```

Тесты на настоящем PostgreSQL (`tests/integration/*.pg.test.ts`) без переменной
пропускаются — это «не прогнано», а не «прошло»:

```bash
KERNEL_PG_TEST_URL=postgresql://user:pass@localhost:5432/vedar_test bash scripts/ci/run-pg-tests.sh
```

Перед коммитом хуки сами гоняют `tsc` (`.claude/settings.json`) и ищут секреты
в стейдже (`.husky/pre-commit`). Коммит с ошибкой типов не пройдёт.

### 1.3 Переменные окружения

Имена — в `.env.example` (117 штук). Для локальной работы нужны две:
`DATABASE_URL`, `JWT_SECRET`. Всё остальное подключает возможности: ключи
ИИ-провайдеров (`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, …), боты
(`TELEGRAM_BOT_TOKEN`, `MAX_BOT_TOKEN`), платежи (`CLOUDPAYMENTS_*`), `CRON_SECRET`
(без него кроны отвечают 401, а супервизор в `start.js` не стартует).

Секреты никогда не пишутся в код и не передаются в `?secret=` — только заголовок
`Authorization: Bearer`. На проде они живут в панели Timeweb, в CI — в секретах
репозитория; это РАЗНЫЕ ключи намеренно (CLAUDE.md §8, «Два ключа»).

---

## 2. Карта репозитория — что где

```
app/                    Next.js 15 App Router: страницы и API
  page.tsx              главная (components/homepage/*)
  routes/ places/ catalog/ marketplace/ map/ on-route/ sos/ offline/ …   ← экраны туриста
  hub/<роль>/           кабинеты: tourist admin operator guide agent stay gear carrier
  api/**/route.ts       759 API-роутов (cron 183, admin 155, operator 36, safety 21, …)
components/             174 React-компонента по доменам (field/ safety/ map/ booking/ homepage/ shared/ …)
lib/                    609 модулей без React — вся логика
  auth/  db-pool.ts database.ts types/db-rows.ts        доступ, БД, типы строк
  routes/ map/ geo/ offline/ on-route/ planner/ search/  маршруты, карта, офлайн, подбор
  safety/ services/safety/                                SOS, алерты, МЧС, ledger
  kuzmich/ ai/                                            Кузьмич и ИИ-провайдеры
  agents/                                                 кроны, эволюция, ядро агентов (30 тыс. строк)
  payments/ tours/ leads/ partners/ notifications/        коммерция
migrations/             463 SQL-файла, только вперёд, следующий = max + 1
lib/database/baseline/  снимок схемы прода (восстановление; см. §1.1)
lib/database/*.sql      МЁРТВЫЕ объявления раннего этапа — не накатываются (lib/db/unmigrated-tables.ts)
scripts/                95 скриптов: импорты, переписи, CI (scripts/ci/*), миграции для Docker
tests/unit/             965 файлов, из них 272 называют себя «сторож» — текстовые проверки правил
tests/integration/      10 файлов *.pg.test.ts — только на настоящем PostgreSQL
.github/workflows/      140 workflow: 45 cron-*, остальные — замеры и починки прода по маркерам
.github/triggers/       77 маркеров *.json — «кнопка на проде» из репозитория (§4.5)
infra/                  Cloudflare-воркеры (ai-relay, safety-relay), MCP-postgres
public/                 sw.js (service worker), emergency.html, тайлы/глифы карты, картинки
docs/                   этот файл, DB_SCHEMA.md, ARCHITECTURE.md и исторические отчёты (§10)
```

Соглашение страниц: `page.tsx` — серверный (metadata, SSR-выборка), логика с
`useState` — в соседнем `_XxxClient.tsx`. Домен живёт в ОДНОМ месте
(`docs/ARCHITECTURE.md` §2) — новый код кладём рядом с существующим, не заводим
второе.

---

## 3. Две дороги туриста — по коду

### 3.1 Дорога 1: маршрут с картой и безопасностью

| Шаг | Экран | Откуда данные | Ключевые модули |
|---|---|---|---|
| Ищет | `/routes` (SSR), `/map`, `/places` | `lib/routes/catalog-query.ts`, `v_kamchatka_routes_api` | `lib/routes/*` |
| Смотрит маршрут | `/routes/[id]` → `_RouteDetailClient.tsx` | `GET /api/routes/[id]`: трек, точки (`route_waypoints` с родом `link_kind`), опасности, паспорт, `navigability`, живые алерты | `lib/map/line-standard.ts` (вид линии = её происхождение, §12), `lib/routes/navigability`, `lib/routes/track-evidence` |
| Готовится | `/routes/[id]/prepare`, `/register` (МЧС) | `trip_preparation_*`, `route_registrations`, `lib/safety/mchs-registration.ts` | `lib/preparation/*` |
| Берёт с собой | «Сохранить полевой пакет», `/offline/manage` | `lib/offline/field-pack.ts`, `tiles.ts`, `saved-map.ts` — IndexedDB + Cache Storage | `lib/offline/useOfflineRegion.ts` |
| Идёт | `/on-route` (полевой режим) | трек из пакета, GPS, `components/field/*`, `lib/on-route/*` | `FieldCompass`, `RouteProgressBar`, `RecoveryCard` |
| Беда | кнопка SOS в шапке → `/sos`, офлайн → `/emergency` | §4.1 | `components/shared/EmergencyAction.tsx` |

Что здесь запрещено: рисовать линию не через `trackLine()`; своя SOS-кнопка;
коммерция на карточке точки (CLAUDE.md §9, §12).

### 3.2 Дорога 2: купить тур

| Шаг | Экран | Что происходит | Где |
|---|---|---|---|
| Витрина | `/catalog` (SSR) | `lib/search/tour-search` по `operator_tours` (только `is_active`, не удалённые) | `lib/tours/marketplace-page.ts` |
| Карточка | `/catalog/tours/[id]` = `/marketplace/tours/[id]` → `_TourDetailClient.tsx` | единственная реализация карточки (CLAUDE.md §11); статус дня из `/api/public/safety-status` | `components/booking/TourPaymentModal.tsx` |
| Даты | `GET /api/tours/[id]/slots` | реальная занятость из `tour_availability` | `lib/services/tours/*` |
| Бронь | `POST /api/bookings/tour` | пишет `operator_bookings` (`booking_status`), `tour_payments`, реферал турагента | `app/api/bookings/tour/route.ts` |
| Оплата | CloudPayments / СБП Точка | вебхуки в `app/api/payments/*` (§7, не трогать): ставят `paid_at`, комиссия — ТОЛЬКО `recordCommissionFromBooking()` | `lib/payments/*` |
| Заявка без брони | `POST /api/leads` | `leads` → квалификация `lead-processor.service.ts` → Telegram оператору | `lib/notifications/lead-notify.ts` |
| После | `/hub/tourist/bookings`, `/booking-success/[id]` | напоминания — кроны `tour-reminder`, `tour-review-request` | |

Оператор видит бронь в `/hub/operator` (25 страниц): туры, слоты, брони, выплаты
(`operator_payouts`, крон `payouts` — внешний, cron-job.org).

### 3.3 Кузьмич — поверх обеих дорог

Чат-помощник (web `/kuzmich`, виджет, Telegram `@kuzmichai_bot`, MAX). Общий мозг —
`lib/kuzmich/core.ts`, инструменты — `tool-loop.ts` + `tool-schemas.ts`
(поиск туров, занятость, безопасность мест, жильё, снаряжение, трансферы, план
поездки). Своего подбора у него нет — зовёт движки `lib/planner`, `lib/search`.
Критичные факты (телефоны, цены, места) — только из инструментов; поверх любого
ответа стоит детерминированный SOS-детектор (`lib/safety/sos-detector.ts`),
который добавляет 112/МЧС при признаках беды даже при мёртвом ИИ.

---

## 4. Неочевидные механизмы

### 4.1 SOS и офлайн-очередь

Одна кнопка на всю платформу — `components/shared/EmergencyAction.tsx`
(сторож `sos-always-reachable`). Копии запрещены: у трёх копий уже расходилось
поведение (#887).

```
нажал SOS
 ├─ есть сеть  → /sos: GPS → POST /api/safety/sos (публичный, §7) → INSERT sos_events
 │               → крон sos-events-bridge (каждые 30 мин) → шина агентов → Telegram/МЧС
 └─ нет сети   → /emergency (public/emergency.html, 34 КБ, в precache SW)
                 или инлайн-панель экрана (onOfflineFallback)
                 → queueSOS(): IndexedDB «kh-pending-v1», store pending_sos
                 → registerSOSSync(): Background Sync 'sos-sync' (public/sw.js)
                 → iOS не умеет Background Sync → installSOSFlush(): дослыв на 'online' и при старте
                 → сервер ответил 429 (уже принят) → запись удаляется, это успех
```

Файл — `lib/offline/pending-queue.ts`. Чужой SOS (QR-эстафета `SosQrScanner`,
меш `hooks/use-mesh.ts`, WebRTC P2P) хранится в той же очереди с полем `relay`
и уходит в `POST /api/mesh/sos-relay` — там дедуп по `sos_id`. Меш и эстафета
анонимны by design (`lib/auth/public-api-routes.ts`). Подробно — `.claude/MESH.md`.

Rate-limit SOS: 1 сигнал в 10 минут на пользователя или IP, в памяти процесса.

### 4.2 Офлайн вообще

- `public/sw.js` — service worker: precache ключевых страниц (`/emergency`,
  `/safety/offline`, `/offline`), кэш API `kh-api-v1`, тайлы зум 7–9 при установке.
- `lib/offline/db.ts` — IndexedDB; `tiles.ts`/`saved-map.ts` — регионы карты
  (зум 10+ по маршруту); `field-pack.ts` — «полевой пакет» маршрута: манифест +
  трек + точки, чтобы `/on-route` жил без сети.
- `lib/offline/last-fix.ts`, `breadcrumbs.ts` — последняя позиция и след,
  читаются из `emergency.html`.
- Правило UI: нет данных → скелетон или честная пустота, никогда не выдуманный
  контент (`.claude/skills/vedar-design`).

### 4.3 Доступ: JWT, Edge и роли

- Вход выдаёт JWT (HS256, `lib/auth.ts`, §7) в httpOnly-куку `auth_token`,
  `sameSite: lax` — это и есть CSRF-защита (сторож `auth-cookie-samesite`).
- `middleware.ts` (Edge, §7): `/hub/*` и `/profile` требуют JWT; API вне реестра
  `PUBLIC_API_ROUTES` (`lib/auth/public-api-routes.ts`) требует JWT; префиксы
  `/api/tourist`, `/api/operator`, `/api/admin`, `/api/guide`, `/api/agent` —
  ещё и роль. `/api/cron/*` и `/api/admin/*` пускают `CRON_SECRET` в заголовке
  `Authorization: Bearer` (так ходят workflow).
- Внутри роутов — `requireAuth / requireRole / requireAdmin / requireOperator /
  requireAgent` из `lib/auth/middleware.ts`. Оба слоя обязательны: Edge — дверь,
  хелпер — проверка внутри.
- Роли: `tourist`, `operator`, `guide`, `agent` (турагент), `transfer_operator`,
  `admin`; партнёры жилья/снаряжения — через `partners.partner_type`.
  Кабинеты по роли — `lib/auth/role-routes.ts`.

### 4.4 База данных

- Прямой SQL, без ORM: `import { pool } from '@/lib/db-pool'` или
  `query()` из `lib/database.ts`; типы строк — `lib/types/db-rows.ts`.
- Только параметры `$1`; интервалы — `make_interval`/`$1::interval`, не
  конкатенация; имя таблицы никогда не интерполируется.
- **Судить статикой запрещено.** Моки отвечают `{rowCount: 0}` на любой текст:
  неоднозначная колонка (42702) и вывод типов (42P08) ловятся только настоящей
  базой. Запрос новой формы → pg-тест в `tests/integration/*.pg.test.ts`
  (образец: `alert-dedup.pg.test.ts`, своя база, DDL из миграций) или прогон
  `GET /api/cron/sql-shape-check` на проде.
- Схема прода ≠ сумма миграций: 30 таблиц живут без `CREATE TABLE` в
  `migrations/` (`lib/db/unmigrated-tables.ts`, список заморожен сторожем
  `schema-coverage` и может только сокращаться). Судья расхождений —
  `GET /api/cron/schema-drift` на проде.
- Миграции: идемпотентны (`IF NOT EXISTS`), применяются `start.js` при каждом
  деплое повыражённо под SAVEPOINT (`scripts/migrate-standalone.js`); отказ
  пишется в `_migration_failures`. Файлы с `CONCURRENTLY` идут вне транзакции.
- `agent_route_knowledge` — VIEW над `places` + `kamchatka_routes`; `bookings`,
  `tours` — старые базовые таблицы, в новом коде запрещены.
- Справочник всех 237 таблиц с колонками и FK — `docs/DB_SCHEMA.md`
  (`npm run db:schema-doc`, сторож свежести `tests/unit/db-schema-doc.test.ts`).

### 4.5 Кроны: три планировщика и маркеры

Под `/api/cron/` 183 роута, а расписаний три, и они намеренно дублируют друг
друга — доставка расписания GitHub давала 1–4 % запрошенного:

| Планировщик | Где объявлен | Что гоняет |
|---|---|---|
| GitHub Actions | `.github/workflows/cron-*.yml` (45) | всё, кроме safety-разряда; реестр живости — `lib/agents/cron-registry.ts` |
| cron-job.org | `.github/cronjob-jobs.json`, сверка `cronjob-sync.yml` | safety-разряд и `payouts` (внешний: идёт ли — «не знаю», проверять по следу в данных) |
| супервизор в контейнере | `start.js`, `SAFETY_JOBS` | `safety-ingest` каждые 5 мин, `sos-events-bridge`, `danger-analysis`, `rescue`, `watchdog`, `checkin-watchdog` |

Дубля нет: каждый safety-роут сперва берёт аренду окна
(`lib/agents/cron-lease.ts`). Род каждого роута — `lib/agents/cron-schedulers.ts`
(`workflow` / `stage` / `external` (6) / `manual` (81)); новый роут без
объявления — красный (`cron-scheduler-declared`). Возможности роута
(пишет ли в БД, зовёт ли ИИ) — `lib/agents/cron-capability-registry.ts`.

**Маркеры.** Прод недостижим ни из среды разработчика (403), ни `workflow_dispatch`
через интеграцию. Поэтому «нажать кнопку на проде» = изменить
`.github/triggers/<имя>.json` в `main`: workflow с `paths:` на этот файл
просыпается, ждёт свежую сборку (`scripts/wait-for-deploy.sh` по `/version.json`),
зовёт роут с `Bearer $CRON_SECRET` и кладёт ответ в step summary и аннотацию
`::notice`. Универсальный замер — `prod-check.json` (любой GET с счётчиком `run`).
Пишущие разборы — сухой прогон по умолчанию (`images-repack.json: mode: dry`).

### 4.6 ИИ-провайдеры

- Вызовы только через `callAIWaterfall()` / `callAIFast()` / `callAIDecision()`
  (`lib/ai/providers.ts`); прямые `callDeepSeek()` и т. п. — только внутри
  providers и health-проб. Модель выбирается по каталогу
  (`lib/ai/model-resolver.ts`), id не хардкодятся.
- 152-ФЗ: реестр хостов с юрисдикцией `lib/agents/compliance/provider-registry.ts`
  (новый провайдер без записи — тест красный), ПД перед промптом — `redactPII()`
  (`lib/security/pii-redact.ts`, сканер `pii-flow-scanner`).
- С прода часть провайдеров гео-закрыта; обход — воркеры `infra/ai-relay`
  (`ANTHROPIC_BASE_URL`, `OPENROUTER_BASE_URL`) и шлюз Timeweb. Кто где считает
  и чьим ключом — CLAUDE.md §8 «Два ключа».
- Решатель эволюции (судья находок) — `callAIDecision`, флагман через
  OpenRouter (вендор задаётся в workflow, не id).

### 4.7 Деплой

```
push в main → Timeweb (приложение Tourhab, id 198048) собирает Dockerfile
  builder: scripts/write-version.js (→ /version.json: commit, built_at) → next build (standalone)
  runner:  public + .next/standalone + .next/static + migrations + migrate-standalone.js + start.js
start.js: прокси на $PORT (health 200 сразу) → migrate-standalone.js → node server.js :3001 → SAFETY_JOBS
```

Ограничения жёсткие: standalone ≤ 50 МБ, `images.unoptimized: true` (без sharp
в сборке), в runner нет `tsx` — только CJS. Сборка идёт ~12 мин; `version.json`
сейчас отдаёт `commit: unknown` (#1762), поэтому ожидание сборки сверяется по
`built_at`. На Timeweb `ignoreBuildErrors=true` — строгость держит локальный
`tsc` и CI, не сборка прода.

CI (`ci.yml`): `ci` (tsc + vitest), `lint`, `kernel-pg` (pg-тесты на сервисе
PostgreSQL) — только при изменении `*.ts/tsx/js/mjs`. Маркер-онли PR получает
лишь `gate` + `check`. После мержа `post-merge.yml` обновляет цифры README.

### 4.8 Сторожа — как читать падение

272 файла в `tests/unit/` — не юнит-тесты функций, а текстовые проверки правил:
читают исходник и падают, если правило нарушено (нет `Bearer`, есть `FROM bookings`,
роут без объявления, линия карты собрана руками). Каждый падает с текстом,
называющим правило и файл-источник; чинить нужно правило или код, а не тест.
Прежде чем добавлять новый сторож, проверить, что его ещё нет: их уже больше,
чем правил, которые они держат (§8).

---

## 5. Отладка

### 5.1 Локально

| Симптом | Куда смотреть |
|---|---|
| `tsc` красный | `npx tsc --noEmit \| head`; типы строк — `lib/types/db-rows.ts` |
| один тест | `npx vitest run tests/unit/имя.test.ts` (подстрока пути, не glob) |
| SQL падает только на проде | воспроизвести на настоящем PG: `KERNEL_PG_TEST_URL=… npx vitest run pg.test.ts` |
| 401 на `/api/cron/*` | нет `CRON_SECRET` или он в `?secret=` вместо заголовка |
| страница 500 после миграции | `_migration_failures`; миграция не идемпотентна |
| колонка «есть в коде, нет в базе» | сторож `sql-phantom-columns` + `docs/DB_SCHEMA.md` |

### 5.2 Прод (без доступа к контейнеру)

| Что нужно | Как |
|---|---|
| та ли сборка | `https://vedarai.ru/version.json` (`built_at`), `GET /api/health` |
| любой GET с прода | маркер `.github/triggers/prod-check.json` → workflow `prod-check.yml` → аннотация |
| логи контейнера | маркер `timeweb-deploy-logs.json` → `timeweb-deploy-logs.yml` |
| здоровье ИИ, ключи, кроны | `/hub/admin/health` (admin), `GET /api/cron/health` |
| конвейер безопасности | `/hub/admin/safety` вкладка «Журнал» = `GET /api/admin/safety/ledger`; маркер `safety-ledger-check.json` |
| дрейф схемы | `GET /api/cron/schema-drift`, `GET /api/cron/sql-shape-check` |
| перепись каталога | `GET /api/cron/catalog-census`, `channel-readiness`, `route-lay-census` |
| статус CI | логи задания (`get_job_logs`), не `check_runs` — те кэшируются на десятки минут (`.claude/MEMORY.md`) |

Правило замера: результат, который не удалось получить, называется
«непоказателен», а не «не починено» и не «работает» (CLAUDE.md §4.0).

### 5.3 Типичные ловушки, уже оплаченные

- `UPDATE t SET col = GREATEST(col, $1) FROM (SELECT …) prev` — голая `col` в SET
  при двух одноимённых колонках даёт 42702 на КАЖДЫЙ вызов; юниты зелёные
  (моки). 20 часов без алертов, 09.09.
- `INSERT … SELECT $1 … WHERE NOT EXISTS (… = $1)` без якоря типа — 42P08,
  запрос не выполняется никогда (воронка была пуста с заведения).
- Маркер-онли PR не гоняет `ci` — сторож, читающий текст workflow, ломается молча.
- `wait-for-deploy` принимает чужую более новую сборку за свою (#1762).
- Регистрация без транзакции: строка в `users` есть, профиля нет, повтор — 409
  навсегда.

---

## 6. Как вносить изменения

1. Ветка от `main`, коммиты с понятным русским сообщением.
2. Перед кодом — план, если трогаешь схему, авторизацию, API или бронирование
   (CLAUDE.md §5). Схема — только новой миграцией `max + 1`.
3. Гейт: `npx tsc --noEmit` → `npx vitest run` → `npm run lint`; pg-тесты, если
   менял SQL новой формы.
4. PR по шаблону (`.github/pull_request_template.md`). Мержит человек; merge в
   `main` = деплой.
5. Работа по находке эволюции (issue с меткой `evo`) — сначала комментарий-заявка
   в issue, потом код (CLAUDE.md §8, оплачено двойной работой 08.09).
6. Не трогать §7: `middleware.ts`, `lib/auth.ts`, `app/api/payments/`,
   `app/api/safety/sos`, старые миграции.

---

## 7. Агенты и самонаблюдение — коротко

Реестр — `AGENTS.md`, книга — `docs/AGENTS_BOOK.md`. Что нужно знать сразу:

- **Watchdog** (каждые 30 мин, три планировщика) — единственный сторож
  операционной безопасности: SOS без ответа, брони без подтверждения, мёртвые
  safety-кроны, удержанные платежи. Алерты в Telegram.
- **Safety Ingest** (каждые 5 мин) — сейсмика, МЧС, пожары → `external_alerts`;
  журнал решений — `safety_decision_events` (append-only).
- **Editor** (ночью) — дописывает короткие описания туров. **Scout Digest** — дайджест
  отрасли в Telegram. **Эволюция** (`cron-evo.yml`, `evo-*`) — сканирует репозиторий,
  судья оценивает находки, они выносятся в GitHub Issues с меткой `evo`, реализует
  Claude Code через `claude.yml`.
- **Ядро агентов** (`lib/agents/kernel`) — задачи, события, эффекты с
  идемпотентностью; действия агентов с последствиями идут через
  `governed-action.ts` (политика allow/deny, человек подтверждает мерж).

---

## 8. Слои в цифрах: что служит туристу, а что машине

Перепись 2026-09-10 (команды в §9). Смысл таблицы — не «много/мало», а
пропорция: где лежит масса кода относительно двух дорог туриста.

| Слой | Страниц | API-роутов | Строк кода | Кому служит |
|---|---:|---:|---:|---|
| Экраны туриста (`app/*` вне hub, кроме legal) | 87 | — | — | туристу |
| `lib/routes` + `lib/map` + `lib/offline` + `lib/safety` + `components/field` + `components/safety` | — | routes 11, safety 21, places 7 | ~21 800 | туристу (обе дороги) |
| Кабинет туриста `/hub/tourist` | 18 | tourist 13, bookings 13, trips 7 | 5 800 | туристу после покупки |
| Кабинет оператора `/hub/operator` | 25 | operator 36, hub/operator 18 | 9 700 | оператору (дорога 2) |
| Кабинеты партнёров (guide, stay, gear, carrier, agent) | 31 | guide 10, stay 12, gear 7, agent 13 | — | партнёрам |
| Админка `/hub/admin` + `/api/admin` | 48 | 155 | 21 600 + 16 700 | владельцу и агентам |
| Кроны `/api/cron` | — | 183 (из них 81 ручных переписей) | 24 800 | машине |
| `lib/agents` (кроны, эволюция, ядро, разведка) | — | — | 30 800 | машине |
| Workflow + маркеры | — | — | 140 + 77 файлов | машине (106 workflow ходят на прод) |
| Сторожа `tests/unit` | — | — | 113 700 строк тестов всего | правилам |

Из 759 роутов экраны туриста зовут ~37 префиксов; чаще всего `routes`, `safety`,
`public`, `places`, `leads`, `field-check`. Всё, что под `cron` и `admin` (338
роутов, 45 % API), турист не видит никогда.

**Что из этого можно сложить** (кандидаты на разбор, решение — владельца;
ничего не удалено этим документом):

- 81 ручная перепись под `/api/cron/` — оставить те, у которых есть читатель
  (маркер или экран), остальные — в один общий `census`-роут с параметром или
  удалить.
- 140 workflow: 34 не ходят на прод и 45 — расписания, которые safety-разряд
  уже дублирует супервизором; ревизия расписаний по `cron-registry`.
- `lib/database/*.sql` (3 400 строк мёртвых объявлений) — после сверки
  `schema-drift` каждую таблицу либо в настоящую миграцию, либо удалить.
- `docs/`: из 24 файлов живых пять (этот, `DB_SCHEMA`, `ARCHITECTURE`,
  `AGENTS_BOOK`, `EXPORT_CENSUS`); отчёты 2026-03…06 — в `docs/archive/`.
- Хабы из одной страницы (`/hub/carrier`, `/hub/fishing`, `/hub/safety`) —
  либо дорастить, либо свести в соседний.
- Мораторий на новые сторожа и переписи до конца этой чистки: их прирост
  быстрее прироста правил.

---

## 9. Как перемерить цифры этого файла

```bash
find app -name page.tsx | wc -l                                   # страниц
find app -name page.tsx ! -path 'app/hub/*' | wc -l               # экранов туриста
for d in app/hub/*/; do echo "$d $(find $d -name page.tsx | wc -l)"; done
find app/api -name route.ts | wc -l                               # API
find app/api -name route.ts | awk -F/ '{print $3}' | sort | uniq -c | sort -rn | head
ls migrations/*.sql | wc -l; ls migrations | tail -1
ls .github/workflows | wc -l; ls .github/triggers | wc -l
grep -l 'vedarai.ru' .github/workflows/*.yml | wc -l              # ходят на прод
find tests/unit -name '*.test.ts*' | wc -l; grep -rl 'сторож' tests/unit | wc -l
grep -cE "kind: 'manual'" lib/agents/cron-schedulers.ts
for d in lib/agents lib/safety lib/offline app/api/cron app/hub/admin; do printf '%s ' $d; find $d -type f \( -name '*.ts' -o -name '*.tsx' \) | xargs cat | wc -l; done
npm run db:schema-doc                                             # схема (нужна база, §1.1)
```

---

## 10. Указатель документов

| Файл | Что там | Живой? |
|---|---|---|
| `CLAUDE.md` | правила кода, запреты, решения владельца с датами, стандарты карточек и карты | да, главный |
| `docs/DB_SCHEMA.md` | все таблицы, колонки, FK, ER-ядро — из настоящей базы | да, генерируется |
| `docs/ARCHITECTURE.md` | домены `lib/`, итоги реорга, «один домен — одно место» | да |
| `AGENTS.md`, `docs/AGENTS_BOOK.md` | реестр и книга агентов, кроны, эволюция | да |
| `README.md` | витрина: цифры (обновляет `post-merge.yml`), стек, хабы | да |
| `.claude/DESIGN_SYSTEM.md`, `DESIGN.md`, скилл `vedar-design` | токены, `ds-*`, вкус | да |
| `.claude/MEMORY.md` | межсессионная память агентов: ловушки, ожидания | да |
| `.claude/MESH.md`, `mesh-stage2-architecture.md` | SOS без связи: QR, WebRTC, LoRa | да |
| `docs/EXPORT_CENSUS.md` | перепись неиспользуемого кода и что с ним сделали | да (21–22.08) |
| `docs/REACHABILITY_AUDIT.md` | какие страницы/API/компоненты недостижимы | замер 22.08 |
| `docs/FIELD_CONFIDENCE_NAVIGATOR_PLAN.md`, `FIELD_CHECK_FCN.md`, `manual-field-check.md` | полевой режим: план и чек-листы проверки руками | да |
| `docs/offline-map-hosting.md`, `SPRINT1_DAYS4-5_OFFLINE_MAP.md` | своя карта PMTiles в S3, история офлайн-карты | первое да |
| `docs/OPERATOR_ONBOARDING.md`, `*_AGREEMENT_TEMPLATE.md` | для операторов и юристов, не для кода | да |
| `migrations/MIGRATION_ORDER.md` | исторический (001–080) | нет |
| `docs/PHASE_1_*`, `SESSION_26_MAR_2026.md`, `FINANCIAL_STRATEGY_*`, `AI_INDUSTRY_SIGNALS_*`, `REORG_STAGE0_*`, `ACTIVATION_CHECKLIST.md` | отчёты своего дня | нет, кандидаты в `archive/` |
| `SECURITY.md`, `PRODUCT.md` | политика уязвимостей; продуктовый тезис | да |
