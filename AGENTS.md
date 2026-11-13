# KamchatourHub — AI Agents

> Реестр рабочих AI-агентов платформы.
> Обновлено: ноябрь 2026 (сверка с кодом 13.11). Расписания и порядок моделей здесь
> не повторяются: они менялись чаще этого файла. Источники названы в разделах ниже.

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
харнеса этого не лечит — упрётся в тот же счёт с другим провайдером. С 03.11
руки по умолчанию идут через OpenRouter (Anthropic отвечал 403
`verification_required`); вывод прежний — питание и доступ решают раньше дизайна.

### Чем мы владеем, а чем нет

Владеем: правилами, инструментами, циклом, порядком выбора моделей. Не владеем:
самими моделями, их доступностью из РФ и балансом счёта. Практический вывод —
всё, на что мы влияем, должно **говорить о своём состоянии словами**: какая
модель ответила, почему не первая ступень, что значит ноль в этом прогоне
(CLAUDE.md §4.0). Инструмент, который об этом молчит, отдаёт власть обратно.

---

## РАБОЧИЕ АГЕНТЫ

### Cron-агенты (автономные)

| Агент | Файл | Запуск | Что делает |
|-------|------|--------|------------|
| **Watchdog** | `lib/agents/watchdog.ts` | каждые 30 мин на проде; GitHub — запасной раз в час | Единственный сторож операционной безопасности: SOS без реакции >15 мин (координаты и 112), брони без подтверждения >24 ч, операторы без ответа >48 ч, лиды >2 ч, кроны, переставшие запускаться. Полный список проверок — CLAUDE.md §8. Алерты в Telegram. |
| **Editor** | `lib/agents/editor.ts` | раз в сутки, вне пика DeepSeek | Описания маршрутов: пустые и свои короткие. Пересказ фактов базы без выводов; нечего сказать — «НЕТ», и запись не пишется. Тексты мест не пишет с 22.10 (выключатель `MODEL_WRITES_PLACE_TEXT`). |
| **Kuzmich Place Enricher** | `lib/agents/kuzmich-place-enricher.ts` | выключен 22.10 | Новые заметки «Кузьмич о месте» закрыты тем же выключателем `MODEL_WRITES_PLACE_TEXT` (`lib/places/model-place-text.ts`). Включение обратно — видимым коммитом по слову владельца. |
| **Scout Digest** | `lib/agents/scout-digest.ts` | свой крон `cron-scout-digest.yml`, 2 раза в сутки (с 05.09; до этого был стадией `evo.run`); ручной прогон — маркер `.github/triggers/scout-digest.json` | 15 источников (`RSS_SOURCES`) + safety-слой для раздела «Камчатка»: RSS (Habr AI, Simon Willison, Hugging Face, MarkTechPost, HN, OpenAI, Google AI, DeepMind, Турпром, RATA, Skift, Product Hunt) + Telegram-превью (РСТ, Минэк-туризм, Vibecoding) → дедупликация URL (TTL 30д) → AI-синтез → Telegram. Гео-закрытые для РФ источники (t.me, openai.com) — через реле Cloudflare `infra/safety-relay` (`SCOUT_RELAY_BASE`, клиент `lib/agents/scout-relay.ts`); проверка реле с прода — `GET /api/cron/scout-relay-check`. Kamgov/ATOR сняты 01.08 (ленты умерли). |
| **Scout Innovator** | `lib/agents/scout-innovator.ts` | расписание снято 29.08; только вручную (`cron-scout.yml`, `workflow_dispatch`) | Анализ трендов + платформы → структурированные proposals → GitHub Issues (`agent-proposal`). Дедуп по открытым issues (Jaccard ≥ 0.5) + critic-gate (отсев нарушающего CLAUDE.md/готового) + task-locking (кросс-прогонный дедуп). |
| **Danger Analyst** | `lib/agents/agencies/danger-analyst-agency.ts` | каждые 30 мин, шаг `cron-safety-heartbeat.yml` | Анализ опасностей по зонам маршрутов, данные в `v_current_danger`. |
| **Legislation Sync** | `lib/services/ingest/legislation-importer.ts` | 1×/неделю | Парсинг законодательства (Путешествуем.рф) → `legislation_docs` → контекст Кузьмича со ссылкой. Нужны `FIRECRAWL_API_KEY` + URL'ы. `/api/cron/legislation-sync`. |
| **Memory Reflector** | `lib/agents/memory-reflector.ts` | 1×/сутки | Истекающие intel-сигналы → durable insight-страницы в `agent_knowledge`. `/api/cron/memory-reflect`. |
| **Contradiction Scanner** | `lib/agents/memory-contradiction.ts` | 1×/сутки | Safety: прямые противоречия в данных → флаг в `agent_knowledge` + алерт. `/api/cron/memory-contradiction`. |
| **Editor Eval** | `lib/agents/eval/editor-regression.ts` | on-demand | Регрессионный TSR + Wilson CI + LLM-judge качества Editor до выкатки промпта. `/api/cron/editor-eval?judge=1`. |

GitHub Actions: `.github/workflows/cron-watchdog.yml`, `cron-editor.yml`, `cron-scout-digest.yml`, `cron-kuzmich-places.yml`, `cron-safety-heartbeat.yml`; `cron-scout.yml` — только ручной запуск.
Точное расписание каждого крона — `lib/agents/cron-registry.ts`; сторож `tests/unit/cron-registry-honesty.test.ts` сверяет его с workflow. В таблице выше расписание названо словами намеренно: записанные часы расходились с кодом.
Новые croны (Legislation Sync, Memory Reflector, Contradiction Scanner, Editor Eval) — через cron-job.org; настройка в [`docs/ACTIVATION_CHECKLIST.md`](./docs/ACTIVATION_CHECKLIST.md).

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
| **Weekly Chronicle** | `.github/workflows/weekly-chronicle.yml` | только вручную: маркер или workflow_dispatch | Собирает смерженные за неделю PR → дописывает «Хронику недели» в `.claude/MEMORY.md` draft-PR'ом. Расписание снято 15.10 (аудит, A27): платный флагман каждую неделю, а черновики никто не вливал. Вернуть — решение владельца вместе с тем, кто вливает. |

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
| Telegram | `/api/telegram/webhook` — живой вход бота (`/api/telegram/kuzmich` к боту не подключён) | Работает |
| MAX (VK) | `/api/max/kuzmich` | Работает |
| WhatsApp | `/api/whatsapp/kuzmich` | Код готов |

Возможности: текст и фото (зрение — Qwen VL: Gemini с прода недоступен), заявки на тур, машину, жильё и прокат — каждую подтверждает человек, UTM-трекинг, долгосрочная память (`user_ai_memory`), поиск туров из БД. Оплату платформа не принимает с 05.10 (`lib/payments/accepting.ts`), поэтому QR-оплаты в чате нет.

### Danger Analyst

| Файл | Cron | Что делает |
|------|------|------------|
| `lib/agents/agencies/danger-analyst-agency.ts` | каждые 30 мин, шаг `cron-safety-heartbeat.yml` | Анализ опасностей по зонам маршрутов |

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

Порядка ступеней здесь нет намеренно: он меняется чаще этого файла, и
записанная таблица называла удалённых провайдеров живыми.

- Водопады (`callAIWaterfall`, `callAIFast`), цикл инструментов Кузьмича и
  решатель эволюции (`callAIDecision`) — `lib/ai/providers.ts`.
- Кто чем решает и почему — CLAUDE.md §8.
- Модель выбирается из каталога провайдера (`lib/ai/model-resolver.ts`); id
  модели в коде не пишется.
- Провайдера напрямую не зовут — только через водопад (сторож
  `tests/unit/ai-direct-calls.test.ts`).
- Имена переменных с ключами — `lib/ai/provider-config.ts`.

---

## CRON-ЗАДАЧИ

Таблицы расписаний здесь нет намеренно: она расходилась с кодом.

- Кроны GitHub Actions и их расписания — `lib/agents/cron-registry.ts`.
- Роуты без workflow (внешний планировщик или запуск рукой) —
  `lib/agents/cron-schedulers.ts`. Идёт ли внешний планировщик на деле,
  репозиторий подтвердить не может: проверять по следу в данных.
- Семь получасовых кронов сведены в `cron-safety-heartbeat.yml`. Частоту
  безопасности на проде держит супервизор `start.js`, GitHub — запасная нога.
  Подробности — CLAUDE.md §8.

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
  editor.ts                — Editor (описания маршрутов)
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

Новое в диалоге дописывается в конец; начало контекста среда не переставляет.

### Что ломает кэш
Это цена, а не запрет: каждое действие ниже заставляет заплатить за запись
кэша заново. Делай его, когда оно нужно работе, и не делай без нужды.
- Правка AGENTS.md, CLAUDE.md или system-файлов. В PR это обычная работа:
  решение записывается в CLAUDE.md вместе с кодом. Цена — следующий ход
  перечитает файл без кэша
- Переключение модели (Sonnet↔Opus) внутри задачи
- Подключение/отключение MCP-серверов во время работы
- Timestamp, дата, счётчик в system prompt или AGENTS.md
- Перестановка порядка tool definitions (должен быть детерминированный, алфавитный)
- `/clear` без реальной необходимости
- Пауза дольше срока жизни кэша (5 минут или час — зависит от среды): следующий ход оплачивается как запись

### Что делать вместо
- Обновление состояния → append reminder-тегом к user-сообщению, не редактировать префикс
- Контекст раздулся → `/compact`, не `/clear`
- Смена модели нужна → заканчивать задачу, начинать новую сессию
- Долгая пауза в сессии с нужным контекстом — не причина её бросать: запись кэша дешевле, чем собирать контекст задачи заново

### Минимальные пороги кэширования
Порог зависит от модели. Для моделей Claude 4.x он был от 1024 до 4096
токенов; для текущей модели число смотреть в её документации.

AGENTS.md должен быть длиннее порога, иначе кэш молча не включится.

### Контроль
- После каждой сессии проверять `/cost`: hit-rate < 85% = что-то ломает префикс, искать причину
- Long session hygiene: 1 задача = 1 сессия. Не смешивать в одном окне деплой, homepage и AI Lead Processor — у них разный retrieved context, и переключения ломают кэш

### Источники экономии на KamchatourHub
Оценка весны 2026 года для Sonnet 4.x (свежий замер счёта — CLAUDE.md §5.1).
Сессия на 30 минут по KamchatourHub при обычной работе ест ~$6 на
Sonnet без кэша. При hit-rate 92% — ~$1.15. Разница 5x. На горизонте
месяца активной разработки — десятки тысяч рублей.

## Cursor Cloud specific instructions

### Quick reference

| Action | Command |
|--------|---------|
| Dev server | `npm run dev` (port 3000) |
| Lint | `npm run lint` |
| Tests | `npx vitest run` (весь набор — около 7 минут; один файл — `npx vitest run <путь>`) |
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
