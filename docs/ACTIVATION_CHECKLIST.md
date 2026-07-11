# Чек-лист активации — что включить в Timeweb

> Код из сессии «agentic-AI hardening» (arXiv:2606.24937) уже в `main`. Часть фич
> **латентна** — без env-переменных и расписаний они корректно ничего не делают (no-op).
> Этот документ — как сделать их реально работающими. Секреты задаются в
> **Timeweb → Fair Polydeuces → Переменные окружения** (не в коде).
>
> Все cron-эндпоинты авторизуются `CRON_SECRET` — заголовком `Authorization: Bearer <CRON_SECRET>`
> (предпочтительно) или `?secret=<CRON_SECRET>`. Внешний планировщик — **cron-job.org**.

---

## 1. MTProto — чтение отраслевых Telegram-каналов

**Что даёт:** market-intelligence из 10 каналов гостеприимства → `agent_memory` → брифинг агентов и контекст Кузьмича.

**Env (Timeweb):**
| Переменная | Где взять |
|-----------|-----------|
| `TG_API_ID` | my.telegram.org → API development tools |
| `TG_API_HASH` | там же |
| `TG_USER_SESSION` | запустить `npx tsx scripts/tg-auth.ts` (введёт код из SMS → выдаст строку сессии) |
| `INDUSTRY_TG_CHANNELS` | *(опц.)* свой список каналов через запятую |

**Расписание (cron-job.org):** `GET https://vedarai.ru/api/cron/industry-intel` (Bearer `CRON_SECRET`), 1–2 раза в сутки.

**Проверка:** ответ `{ ok: true, channels: N, ... }`; без env — `reason: "mtproto_not_configured"`.

---

## 2. Законодательство — парсинг Путешествуем.рф

**Что даёт:** нормативка → `legislation_docs` → Кузьмич цитирует норму со ссылкой на источник.

**Env:**
| Переменная | Значение |
|-----------|----------|
| `FIRECRAWL_API_KEY` | ключ Firecrawl |
| `LEGISLATION_SOURCE_URLS` | точные URL'ы страниц законов через запятую |

**Запуск:** `GET /api/cron/legislation-sync` (env-URL'ы) **или** `POST /api/cron/legislation-sync` с телом `{ "secret": "<CRON_SECRET>", "urls": ["https://..."] }`. Раз в неделю.

**Проверка:** `{ ok: true, imported: N }`; без ключа — `reason: "firecrawl_not_configured"`, без URL — `reason: "no_urls"`.

> Скрейп `.рф` идёт с прод-окружения (Timeweb, RU) — из CI/dev домен недоступен по сетевой политике.

---

## 3. Multi-query RAG (перефразы запросов)

**Что даёт:** для коротких запросов Кузьмич ищет по синонимам/перефразам — закрывает vocabulary-gap.

**Env:** `RAG_MULTIQUERY=1` (по умолчанию ВЫКЛ → ноль изменений и стоимости).

**Проверка (после деплоя):** задать Кузьмичу короткий запрос синонимом (напр. «сопка» вместо «вулкан») → проверить, что маршруты находятся. Это доп. AI-вызов на поиск — следить за latency.

---

## 4. Рефлектор памяти (эпизод → семантика)

**Что даёт:** истекающие разведсигналы (TTL 3–7 дн) синтезируются в durable insight-страницы `agent_knowledge`.

**Расписание:** `GET /api/cron/memory-reflect`, **раз в сутки** (лучше — после прогона мониторинга каналов).

**Проверка:** `{ ok: true, consolidated: N }`; при <3 эпизодах — `reason: "insufficient_episodes"`.

---

## 5. Детектор противоречий (safety)

**Что даёт:** ловит прямые несостыковки в данных («тропа открыта» vs свежее «закрыта»), флагует + алерт админу на high-severity.

**Расписание:** `GET /api/cron/memory-contradiction`, **раз в сутки, после рефлектора**.

**Проверка:** `{ ok: true, contradictions: N, alerted: M }`.

> Алерты идут в `TELEGRAM_CHAT_ID` (если задан `TELEGRAM_BOT_TOKEN`).

---

## 6. Editor Eval (качество описаний)

**Что даёт:** воспроизводимый Task Success Rate + Wilson CI, опционально LLM-judge качества — **до** выкатки правок промпта Editor.

**Запуск (on-demand, не по расписанию):**
`GET /api/cron/editor-eval?judge=1&limit=12` (Bearer `CRON_SECRET`).

**Env (опц.):** `EDITOR_EVAL_SEED_IDS` — фиксированный набор ID для стабильной регрессии (через запятую). Без него — детерминированная выборка по `id`.

**Проверка:** `{ ok: true, tsr: 0.xx, ci: {...}, quality_avg: x.x }`.

---

## Сводка расписаний (cron-job.org)

| Эндпоинт | Частота | Зависит от |
|----------|---------|-----------|
| `/api/cron/industry-intel` | 1–2×/сутки | TG_API_* |
| `/api/cron/legislation-sync` | 1×/неделю | FIRECRAWL_API_KEY + URL'ы |
| `/api/cron/memory-reflect` | 1×/сутки | накопленные intel-сигналы |
| `/api/cron/memory-contradiction` | 1×/сутки (после рефлектора) | — |
| `/api/cron/editor-eval` | on-demand | — |

Все croны fail-safe: без данных/ключей возвращают понятный `reason` и ничего не ломают.

---

## Что НЕ требует активации (уже работает после деплоя)

RRF-поиск, token-aware контекст + pre-flight, параллельный tool-exec + дедуп,
untrusted-обёртка tool-выходов, Wilson CI в A/B, tamper-proof оракул Editor,
critic-gate + task-locking Scout-Innovator — это правки в коде, активны сразу.
