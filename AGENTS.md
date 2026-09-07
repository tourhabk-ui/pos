# KamchatourHub — AI Agents

> Реестр рабочих AI-агентов платформы.
> Обновлено: август 2026

---

## ЧТО ЗДЕСЬ ВООБЩЕ УСТРОЕНО (словарь харнеса)

Реестр ниже перечисляет файлы. Этот раздел объясняет НАЗНАЧЕНИЕ частей — чтобы
новый человек (или новый агент) понимал систему, а не заучивал список путей.

Словарь взят из разбора «What is a Harness?» (earendil.com, 20.08.2026).
Формула там: **агент = модель + харнес**. Модель делают лаборатории, харнес —
мы. Полезно потому, что даёт имена тому, что у нас уже построено вразнобой.

| Компонент харнеса | Что это | Где у нас |
|---|---|---|
| **System Prompt** | правила «первого дня»: кто ты, что можно и нельзя | `CLAUDE.md`, `.claude/DESIGN_SYSTEM.md`, скиллы `kamchatka` и `vedar-design` |
| **Tools** | код, который модель может позвать; когда звать — решает модель | движки `lib/*` (planner, search, routes, security), кроны, сторожа `tests/unit/*` |
| **Agentic Loop** | задача → план → инструмент → проверка → повтор, пока не готово | эволюция: Growth Scan → судья (`scripts/evo-judge.ts`) → `lib/agents/evo/issue-reporter.ts` → кодер (`.github/workflows/claude.yml`) → PR |
| **Translation Layer** | возможность сменить модель, не переписывая систему | `callAIDecision` + водопад, `lib/ai/model-resolver.ts` (подбор по каталогу, без хардкода id) |

### Три поправки к этому словарю, купленные опытом

Разбор описывает харнес как чистую победу пользователя. По нашим замерам у неё
есть цена, и её надо назвать, иначе словарь станет рекламой.

**1. Сменная модель — не равная модель.** «Работает с любой моделью» верно по
механике и обманчиво по существу. Разбор находок 19.08 шёл тремя моделями
сразу, и единственное «по делу» вынес `deepseek-v4-flash` — слабая запасная
ступень водопада, — обосновав неверно. Вердикт той же формы, в том же отчёте,
но другой цены. Отсюда правило: **модель подписывается рядом с каждым
вердиктом**, а отход вниз по водопаду печатается причиной. Тихая подмена
сильной модели на слабую — потеря качества, которую нечем заметить.

**2. Локальность данных харнесом не решается.** «Данные остаются у тебя» — про
ноутбук, а у нас прод в РФ и решатель за границей. Значение имеет не кто
отправил промпт, а в какую юрисдикцию он ушёл. Это закрывает не нейтральность
инструмента, а замороженный реестр хостов с юрисдикциями —
`lib/agents/compliance/provider-registry.ts` (152-ФЗ) и `redactPII`
(`lib/security/pii-redact.ts`) перед
отправкой.

**3. Слабое звено цикла — не дизайн, а питание.** Наш Agentic Loop построен
целиком и стоит без движения, когда на ключе кончаются кредиты: `.github/workflows/claude.yml`
падает с `Credit balance is too low`, и находки копятся неразобранными. Смена
харнеса этого не лечит — упрётся в тот же счёт с другим провайдером.

### Чем мы владеем, а чем нет

Владеем: правилами, инструментами, циклом, порядком выбора моделей. Не владеем:
самими моделями, их доступностью из РФ и балансом счёта. Практический вывод —
всё, на что мы влияем, должно **говорить о своём состоянии словами**: какая
модель ответила, почему не первая ступень, что значит ноль в этом прогоне
(CLAUDE.md §4.0). Инструмент, который об этом молчит, отдаёт власть обратно.

---

## РАБОЧИЕ АГЕНТЫ

### Cron-агенты (автономные)

| Агент | Файл | Cron | Что делает |
|-------|------|------|------------|
| **Watchdog** | `lib/agents/watchdog.ts` | каждые 30 мин | Бронирования без подтверждения >24ч, операторы без ответа >48ч, лиды >2ч, SOS >30 мин. Алерты в Telegram. |
| **Editor** | `lib/agents/editor.ts` | 02:00 UTC | Туры с описанием <300 символов → AI-рерайт → `route_description_cache`. Smoke-test: проверяет что записи реально попали в БД, при тихом отказе → Telegram алерт. |
| **Kuzmich Place Enricher** | `lib/agents/kuzmich-place-enricher.ts` | 04:00 UTC | Генерирует `kuzmich_review` для мест без него. 20 мест за запуск. |
| **Scout Digest** | `lib/agents/scout-digest.ts` | стадия `runEvoOrchestrator`, 4×/сутки (`evo.run` с cron-job.org); своего крона нет с 29.08, ручной прогон — маркер `.github/triggers/scout-digest.json` | 15 источников (`RSS_SOURCES`) + safety-слой для раздела «Камчатка»: RSS (Habr AI, Simon Willison, Hugging Face, MarkTechPost, HN, OpenAI, Google AI, DeepMind, Турпром, RATA, Skift, Product Hunt) + Telegram-превью (РСТ, Минэк-туризм, Vibecoding) → дедупликация URL (TTL 30д) → AI-синтез → Telegram. Гео-закрытые для РФ источники (t.me, openai.com) — через реле Cloudflare `infra/safety-relay` (`SCOUT_RELAY_BASE`, клиент `lib/agents/scout-relay.ts`); проверка реле с прода — `GET /api/cron/scout-relay-check`. Kamgov/ATOR сняты 01.08 (ленты умерли). |
| **Scout Innovator** | `lib/agents/scout-innovator.ts` | 08:00 UTC | Анализ трендов + платформы → структурированные proposals → GitHub Issues (`agent-proposal`). Дедуп по открытым issues (Jaccard ≥ 0.5) + critic-gate (отсев нарушающего CLAUDE.md/готового) + task-locking (кросс-прогонный дедуп). |
| **Danger Analyst** | `lib/agents/agencies/danger-analyst-agency.ts` | каждые 30 мин | Анализ опасностей по зонам маршрутов, данные в `v_current_danger`. |
| **Industry Intel** | `lib/telegram/industry-channels.ts` | 1–2×/сутки | Чтение 10 отраслевых TG-каналов через MTProto → market-intelligence в `agent_memory`. Нужны `TG_API_*`. `/api/cron/industry-intel`. |
| **Legislation Sync** | `lib/services/legislation-importer.ts` | 1×/неделю | Парсинг законодательства (Путешествуем.рф) → `legislation_docs` → контекст Кузьмича со ссылкой. Нужны `FIRECRAWL_API_KEY` + URL'ы. `/api/cron/legislation-sync`. |
| **Memory Reflector** | `lib/agents/memory-reflector.ts` | 1×/сутки | Истекающие intel-сигналы → durable insight-страницы в `agent_knowledge`. `/api/cron/memory-reflect`. |
| **Contradiction Scanner** | `lib/agents/memory-contradiction.ts` | 1×/сутки | Safety: прямые противоречия в данных → флаг в `agent_knowledge` + алерт. `/api/cron/memory-contradiction`. |
| **Editor Eval** | `lib/agents/eval/editor-regression.ts` | on-demand | Регрессионный TSR + Wilson CI + LLM-judge качества Editor до выкатки промпта. `/api/cron/editor-eval?judge=1`. |

GitHub Actions: `.github/workflows/cron-watchdog.yml`, `cron-editor.yml`, `cron-scout-digest.yml`, `cron-scout.yml`, `cron-kuzmich-places.yml`
Новые croны (Industry Intel, Legislation Sync, Memory Reflector, Contradiction Scanner, Editor Eval) — через cron-job.org; настройка в [`docs/ACTIVATION_CHECKLIST.md`](./docs/ACTIVATION_CHECKLIST.md).

### Loop-агенты (GitHub Actions, loop engineering)

Петли, работающие с репозиторием, а не с БД платформы. Уровень автономии L2:
LLM-петля готовит изменения draft-PR'ом, мержит человек. Детерминированные
шаги (удаление веток) — L3. §7-границы (payments, SOS, middleware, auth)
вшиты в промпты: петля останавливается и зовёт человека.

| Петля | Workflow | Триггер | Что делает |
|-------|----------|---------|------------|
| **CI Sweeper** | `.github/workflows/ci-sweeper.yml` | CI завершился с failure | Читает лог падения, чинит: PR-ветка → коммит в неё с маркером `[ci-sweep]`; main → hotfix draft-PR «ГОРЯЧО». Одна попытка на ран (маркер в коммите глушит рекурсию), флаки → rerun. |
| **Issue Triage** | `.github/workflows/issue-triage.yml` | 21:00 UTC ежедневно + маркер | Размечает открытые issues без `triaged`: тип/объём, safety/money/L → `needs-owner` (бота не запускать), тривиальные S/M → `agent-proposal` (запуск конвейера claude.yml). Кода не касается: permissions только issues. |
| **Post-Merge Cleanup** | `.github/workflows/post-merge.yml` | PR смержен | Детерминированно (без LLM, L3) удаляет смерженную `claude/*` ветку; ветки с новыми коммитами после мержа и ручные ветки не трогает. |
| **Weekly Chronicle** | `.github/workflows/weekly-chronicle.yml` | вс 20:00 UTC + маркер | Собирает смерженные за неделю PR → дописывает «Хронику недели» в `.claude/MEMORY.md` draft-PR'ом. Межсессионная память агентов живёт в репо, а не только в compaction-саммари. |

### Ежедневный брифинг (общая память агентов)

Каждый cron-агент на старте вызывает `readAgentBriefing(agentId)` из `lib/agents/warmup.ts`.
Возвращает: состояние платформы (counts из БД) + статусы агентов + Repo State (12 таблиц, дерево файлов, 10 production-эндпоинтов) + **must-have туристический контекст** (сезонность, логистика, безопасность, инструменты платформы, ценовые ориентиры).

**Repo Scanner** (`lib/agents/repo-scanner.ts`): ежедневное сканирование вызывается из `writeDailyBriefing()`.
- `scanDbSchema()` — drift-детектор, читает `information_schema.columns`
- `scanRepoTree()` — дерево файлов через GitHub API
- `scanProductionHealth()` — 10 публичных GET эндпоинтов, таймаут 5с
- Результат пишется в `agent_knowledge` slug=`repo-scan/YYYY-MM-DD`

### Kuzmich (AI-ассистент туристов)

Мультиканальный чат-бот. Все каналы используют общий мозг: `lib/kuzmich/core.ts`

| Канал | Endpoint | Статус |
|-------|----------|--------|
| Веб (полная страница) | `/kuzmich` | Работает |
| Виджет (все страницы) | `components/kuzmich/KuzmichWidget.tsx` в `layout.tsx` | Работает |
| Telegram | `/api/telegram/kuzmich` | Активен (разговоры сегодня) |
| MAX (VK) | `/api/max/kuzmich` | Активен (разговоры вчера) |
| WhatsApp | `/api/whatsapp/kuzmich` | Код готов |

Возможности: текст + фото (Gemini Vision), инлайн-бронирование с QR-оплатой (Точка Банк), UTM-трекинг, долгосрочная память (`user_ai_memory`), поиск туров из БД.

### Danger Analyst

| Файл | Cron | Что делает |
|------|------|------------|
| `lib/agents/agencies/danger-analyst-agency.ts` | 30 мин (cron-job.org) | Анализ опасностей по зонам маршрутов |

Endpoint: `/api/cron/danger-analysis`

### Platform Agent (диспетчер)

`lib/agents/platform-agent.ts` — маршрутизирует запросы к нужному agency по intent.

| Agency | Файл | Интенты | Канал |
|--------|------|---------|-------|
| **Operator** | `agencies/operator-agency.ts` | `op_tours_summary`, `op_bookings_today`, `op_revenue`, `op_create_tour`, `op_fill_ai`, `op_add_slots` | `/hub/operator/ai-assist` |
| **Tourist** | `agencies/tourist-agency.ts` | Рекомендации туров | Kuzmich |
| **Guide** | `agencies/guide-agency.ts` | Гид по маршрутам | PlatformAgent |
| **Rescue** | `agencies/rescue-agency.ts` | SOS-консультации | PlatformAgent |
| **Lead** | `agencies/lead-agency.ts` | Обработка лидов | PlatformAgent |
| **Marketing** | `agencies/marketing-agency.ts` | Маркетинг | PlatformAgent |
| **Transfer** | `agencies/transfer-operator-agency.ts` | Трансферы | PlatformAgent |

---

## AGENT BRAIN (память агентов)

Два слоя хранения знаний:

| Слой | Таблица | TTL | Назначение |
|------|---------|-----|------------|
| Оперативная | `agent_memory` | 7 дней | Наблюдения, текущие данные, recall по agent_id |
| Постоянная | `agent_knowledge` | навсегда | Compiled truth + timeline, Russian FTS |

**KnowledgeBase** (`lib/agents/memory/agent-knowledge.ts`):
- `upsert()` — создать/обновить страницу знаний
- `search()` — полнотекстовый поиск (tsvector + ILIKE fallback)
- `appendTimeline()` — добавить запись в хронологию
- `link()` — связать страницы между собой

**MCP-инструменты** (в `lib/mcp/dev-tools/server.ts`):
`brain_search`, `brain_get`, `brain_upsert`, `brain_timeline`, `brain_list`

**Slug convention:**

| Тип | Паттерн | Пример |
|-----|---------|--------|
| operator | `operators/{slug}` | `operators/fishingkam` |
| route | `routes/{slug}` | `routes/avachinsky-volcano` |
| intel | `intel/{domain}/{YYYY-MM}` | `intel/ai_tech/2026-04` |
| decision | `decisions/{id}/{topic}` | `decisions/bm-2026-04-11/pricing` |
| pattern | `patterns/{agent}/{slug}` | `patterns/eco/seasonal-load` |
| insight | `insight/{YYYY-MM-DD}/{n}` | `insight/2026-06-29/0` (Memory Reflector) |
| contradiction | `contradiction/{YYYY-MM-DD}/{n}` | `contradiction/2026-06-29/0` (Contradiction Scanner) |

---

## AI WATERFALL

```
Tier 1 (гонка): OpenRouter + DeepSeek + Gemini + MiMo + GLM
Tier 2 (гонка): YandexGPT + MiniMax
Tier 3 (последовательно): Anthropic
```

| Провайдер | Env | Статус |
|-----------|-----|--------|
| OpenRouter | `OR_API_KEY` | Tier 1 |
| DeepSeek | `DEEPSEEK_API_KEY` | Tier 1 |
| Gemini 2.0 Flash | `GEMINI_API_KEY` | Tier 1 |
| Xiaomi MiMo | `XIAOMI_API_KEY` | Tier 1 |
| GLM Z1 | `OR_API_KEY` (via OR) | Tier 1 |
| Fugu Ultra | `FUGU_API_KEY` | Tier 1 |
| YandexGPT | `YANDEX_API_KEY` + `YANDEX_FOLDER_ID` | Tier 2 |
| MiniMax | `MINIMAX_API_KEY` | Tier 2 |
| Anthropic | `ANTHROPIC_API_KEY` | Tier 3 |

Файл: `lib/ai/providers.ts`

---

## CRON-ЗАДАЧИ

| Endpoint | Запускатор | Расписание | Статус |
|----------|-----------|------------|--------|
| `/api/cron/watchdog` | GitHub Actions | 30 мин | Работает |
| `/api/cron/editor` | GitHub Actions | 02:00 UTC | Работает |
| `/api/cron/scout-digest` | GitHub Actions | 07:00 UTC | Работает |
| `/api/cron/leads-process` | GitHub Actions | 30 мин | Работает |
| `/api/cron/followups` | GitHub Actions | 30 мин | Работает |
| `/api/cron/intelligence` | cron-job.org | 6ч | Работает |
| `/api/cron/danger-analysis` | cron-job.org | 30 мин | Работает |
| `/api/cron/health` | cron-job.org | 1ч | Работает |
| `/api/cron/kuzmich` | cron-job.org | 12ч | Посты Кузьмича |
| `/api/cron/abandoned-bookings` | cron-job.org | 1ч | Напоминания/auto-cancel |

---

## УДАЛЕНО (апрель 2026)

Совет директоров из 13 AI-агентов был удалён как неэффективный театр:
- 15 agency-файлов (admin, legal, security, hacker, eco, content, quality, planning, evo, finance, infra, vibe-coder, scout-innovator)
- Board meeting (5 раундов, SSE-стрим) — 1,204 строки
- Board meeting UI — 1,241 строка
- 18 API-маршрутов `/api/agents/*`
- AgentMesh, observers, training, programs
- Итого: **10,318 строк**

Коммиты: `9da9e8d2`, `5d4d83f9`

---

## КЛЮЧЕВЫЕ ФАЙЛЫ

```
lib/agents/
  watchdog.ts              — Watchdog (мониторинг)
  editor.ts                — Editor (описания туров)
  scout-digest.ts          — Scout Digest (RSS дайджест)
  platform-agent.ts        — Диспетчер intent → agency
  intent-classifier.ts     — Классификатор интентов
  permissions.ts           — Матрица разрешений
  memory/
    agent-memory.ts        — Оперативная память (TTL 7д)
    agent-knowledge.ts     — Постоянная память (brain, FTS)
  agencies/
    operator-agency.ts     — Оператор-тулза (6 интентов)
    tourist-agency.ts      — Рекомендации для туристов
    guide-agency.ts        — Гид по маршрутам
    rescue-agency.ts       — SOS-консультации
    lead-agency.ts         — Обработка лидов
    marketing-agency.ts    — Маркетинг
    transfer-operator-agency.ts — Трансферы
    danger-analyst-agency.ts — Анализ опасностей

lib/kuzmich/
  core.ts                  — Общий мозг Кузьмича (все каналы)

lib/ai/providers.ts        — AI waterfall
lib/mcp/dev-tools/server.ts — MCP: brain_* tools
```

## Prompt Cache Discipline (обязательно к соблюдению)

### Принцип
Каждый ход Claude Code пересылает весь контекст заново. Кэш работает
по точному префиксному совпадению. Цель сессии: 90%+ cache hit-rate.
Стоимость cache read = 10% от обычной, cache write = 125%.

### Архитектура контекста (сверху вниз)
1. System prompt — не трогать
2. Tool definitions — загружены upfront, не менять в середине сессии
3. AGENTS.md — стабильный префикс
4. Retrieved context (файлы, RAG) — стабильны в пределах задачи
5. История диалога и tool results — единственная динамическая часть

Всё новое дописывается ТОЛЬКО в конец. Префикс не мутируется никогда.

### Что ломает кэш (запрещено в рабочей сессии)
- Редактирование AGENTS.md, CLAUDE.md или system-файлов в середине сессии
- Переключение модели (Sonnet↔Opus) внутри задачи
- Подключение/отключение MCP-серверов во время работы
- Timestamp, дата, счётчик в system prompt или AGENTS.md
- Перестановка порядка tool definitions (должен быть детерминированный, алфавитный)
- `/clear` без реальной необходимости
- Пауза > 5 минут (ephemeral TTL) — кэш испаряется, следующий ход оплачивается как write

### Что делать вместо
- Обновление состояния → append reminder-тегом к user-сообщению, не редактировать префикс
- Контекст раздулся → `/compact`, не `/clear`
- Смена модели нужна → заканчивать задачу, начинать новую сессию
- Пауза > 5 мин ожидается → закрыть сессию, открыть новую с чистого листа

### Минимальные пороги кэширования
- Sonnet 4.x, Haiku 4.5: 1024 токена
- Opus 4.x: 2048–4096 токенов

AGENTS.md должен быть длиннее порога, иначе кэш молча не включится.

### Контроль
- После каждой сессии проверять `/cost`: hit-rate < 85% = что-то ломает префикс, искать причину
- Long session hygiene: 1 задача = 1 сессия. Не смешивать в одном окне деплой, homepage и AI Lead Processor — у них разный retrieved context, и переключения ломают кэш

### Источники экономии на KamchatourHub
Сессия на 30 минут по KamchatourHub при обычной работе ест ~$6 на
Sonnet без кэша. При hit-rate 92% — ~$1.15. Разница 5x. На горизонте
месяца активной разработки — десятки тысяч рублей.

## Cursor Cloud specific instructions

### Quick reference

| Action | Command |
|--------|---------|
| Dev server | `npm run dev` (port 3000) |
| Lint | `npm run lint` |
| Tests | `npx vitest run` (156 tests, ~3s) |
| Type-check | `npx tsc --noEmit` |
| Migrations | `DATABASE_URL=... npm run migrate` |

### PostgreSQL setup (local dev)

The VM uses PostgreSQL 16 (Ubuntu 24.04 default) with PostGIS 3. The production codebase expects PostgreSQL 15, but 16 is fully compatible. Start the service with:

```
pg_ctlcluster 16 main start
```

Local connection shape: user=`kamuser`, database=`kamhub`, host=`localhost:5432`. The password is whatever you set at `CREATE ROLE` and lives only in `.env.local` — it is not written in this file on purpose: the repository is public, and a documented default is a default on somebody's machine.

### Database bootstrapping gotcha

The migration files in `migrations/` assume that base tables (`users`, `partners`, `bookings`, `tours`, etc.) already exist. These base tables are defined in `lib/database/schema.sql` but are NOT part of the numbered migration files. On a fresh database you must:

1. Apply `lib/database/schema.sql` first (creates ~30 base tables)
2. Seed at least one user + partner row (migration 040 verifies non-empty `users` and `partners`)
3. Then run `npm run migrate`

Some early migrations (017-019) reference old table names (`bookings`, `partners`) as FK targets. The base schema creates these as real tables; migration 132 later replaces `bookings`/`tours` with compatibility views over `operator_bookings`/`operator_tours`.

Additional prerequisite tables not in the base schema but referenced by early migrations: `tourist_wishlist`, `eco_points_log`, `kamchatka_routes`, `tg_conversations`, `leads`. Create these before running migrations or apply migrations with error tolerance.

### Environment variables

Only three env vars are strictly required for the dev server to start:
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — 32+ char random string for auth tokens
- `NEXT_PUBLIC_APP_URL` — `http://localhost:3000`

All AI provider keys, Redis, S3, Telegram, payment integrations are optional and degrade gracefully.

### Services not needed for local dev

Redis, CrewAI (Python), Prometheus/Grafana, pgAdmin — all optional. The app runs fine without them. Rate limiting auto-disables when `UPSTASH_REDIS_REST_URL` is unset.
