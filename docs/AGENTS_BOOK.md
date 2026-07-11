# Книга агентов KamchatourHub / TourHab

> **Volcano OS** — операционная система туристической платформы Камчатки.  
> Документ охватывает все 37+ агентов: что делает каждый, как настроить, как проверить работу, как устранить проблему.  
> Актуально: июнь 2026.

---

## Содержание

1. [Архитектура агентной системы](#архитектура)
2. [Часть I — Безопасность и экстренные ситуации](#часть-i)
   - [Watchdog](#1-watchdog--страж-платформы)
   - [Safety Ingest](#2-safety-ingest--сейсмический-монитор)
   - [Rescue Agent](#3-rescue-agent--агент-спасения)
   - [Danger Analyst](#4-danger-analyst--аналитик-опасности)
   - [Checkin Watchdog](#5-checkin-watchdog--контроль-регистрации)
   - [Route Escalation](#6-route-escalation--эскалация-маршрутов)
   - [SOS Events Bridge](#7-sos-events-bridge--мост-sos-событий)
3. [Часть II — Контент и знания](#часть-ii)
   - [Editor](#8-editor--редактор-маршрутов)
   - [Import Routes](#9-import-routes--импорт-маршрутов)
   - [Enrich Routes](#10-enrich-routes--обогащение-маршрутов)
   - [Places Enricher](#11-places-enricher--обогащение-точек)
   - [Kuzmich Place Enricher](#12-kuzmich-place-enricher--рецензии-кузьмича)
   - [Routes Cache Refresh](#13-routes-cache-refresh--кеш-маршрутов)
4. [Часть III — Разведка и анализ](#часть-iii)
   - [Scout Digest](#14-scout-digest--ежедневный-дайджест)
   - [Scout Innovator](#15-scout-innovator--генератор-предложений)
   - [Intelligence](#16-intelligence--мониторинг-сигналов)
   - [KB Gap](#17-kb-gap--заполнение-пробелов-kb)
   - [Group Scout](#18-group-scout--разведка-telegram-групп)
5. [Часть IV — Бизнес-операции](#часть-iv)
   - [Abandoned Bookings](#19-abandoned-bookings--брошенные-бронирования)
   - [Payouts](#20-payouts--выплаты-операторам)
   - [Leads Process](#21-leads-process--обработка-лидов)
   - [Followups](#22-followups--следующие-шаги-по-лидам)
   - [Tour Reminder](#23-tour-reminder--напоминание-о-туре)
   - [Trip Reminders](#24-trip-reminders--напоминания-туристу)
   - [Smart Notify](#25-smart-notify--умные-уведомления)
   - [Support Escalate](#26-support-escalate--эскалация-поддержки)
6. [Часть V — Инфраструктура](#часть-v)
   - [Health](#27-health--проверка-здоровья)
   - [LLM Budget Check](#28-llm-budget-check--бюджет-ai)
   - [Telegram Webhook Watchdog](#29-telegram-webhook-watchdog--watchdog-вебхука)
   - [Memory Bridge](#30-memory-bridge--мост-памяти)
7. [Часть VI — Эволюция](#часть-vi)
   - [Evo System](#31-evo-system--система-эволюции)
   - [Growth Agent](#32-growth-agent)
   - [Evolution Loop](#33-evolution-loop)
   - [Evolver Analysis](#34-evolver-analysis)
   - [Feedback Loop](#35-feedback-loop)
8. [Часть VII — Каналы](#часть-vii)
   - [Kuzmich](#36-kuzmich--главный-бот)
   - [Channel Sync](#37-channel-sync--синхронизация-каналов)
9. [Приложения](#приложения)
   - [Переменные окружения](#A-переменные-окружения)
   - [Расписание всех агентов](#B-расписание)
   - [GitHub Actions workflows](#C-github-actions)
   - [Таблицы БД](#D-таблицы-бд)
   - [Чеклист запуска](#E-чеклист-запуска)

---

## Архитектура

### Как устроена система

```
GitHub Actions (cron)
        │
        ▼
GET /api/cron/<agent>?secret=CRON_SECRET
        │
        ├── Auth: timingSafeCompare(secret, CRON_SECRET)
        ├── Agent logic (lib/agents/*.ts)
        ├── DB writes (pool.query / lib/database.ts)
        ├── External APIs (Telegram, Claude, etc.)
        └── logAgentRun() → agent_run_history
```

**Три типа агентов:**

| Тип | Примеры | Характер |
|-----|---------|----------|
| **Cron** | Watchdog, Safety Ingest, Editor | Запускаются по расписанию через GitHub Actions |
| **Orchestrated** | Evo System | Один оркестратор запускает несколько sub-агентов |
| **On-demand** | Kuzmich, Lead Processor | Реагируют на события (запрос пользователя, новый лид) |

### Иерархия критичности

```
КРИТИЧНО (падает платформа):     Safety Ingest (5 min), Watchdog (30 min)
ВЫСОКАЯ (деньги/безопасность):   Payouts, Abandoned Bookings, Rescue, SOS Bridge
СРЕДНЯЯ (контент/UX):            Editor, Scout Digest, Tour Reminder
НИЗКАЯ (аналитика/оптимизация):  Scout Innovator, KB Gap, Group Scout
```

### Общий принцип авторизации cron

Все cron-эндпоинты проверяют `CRON_SECRET` через `timingSafeCompare`.  
GitHub Actions передаёт его через header `X-Cron-Secret` или query `?secret=`.  
Без `CRON_SECRET` = 500. Неверный = 401.

---

## Часть I — Безопасность и экстренные ситуации

---

### 1. Watchdog — Страж платформы

**Файл:** `lib/agents/watchdog.ts`  
**Эндпоинт:** `GET /api/cron/watchdog`  
**Workflow:** `cron-watchdog.yml`  
**Расписание:** каждые 30 минут

#### Что делает

Сторожевая система для обнаружения критических ситуаций на платформе. Проверяет 5 классов проблем:

1. **Брошенные бронирования** — `operator_bookings` в статусе `pending_payment` дольше 24ч без подтверждения
2. **Неответившие операторы** — оператор не ответил на запрос бронирования >48ч
3. **Необработанные лиды** — лиды без AI-обработки >2ч (сигнал что `leads-process` упал)
4. **Игнорируемые SOS** — события экстренной помощи >30 мин без реакции
5. **Мёртвый cron сейсмики** — если `safety-ingest` не запускался >15 мин (критично!)

При обнаружении: отправляет Telegram-алерт в `TELEGRAM_CHAT_ID` с детальным сообщением.

#### Настройка

```env
TELEGRAM_BOT_TOKEN=<токен бота>
TELEGRAM_CHAT_ID=<ID чата администратора>
NEXT_PUBLIC_APP_URL=https://vedarai.ru
CRON_SECRET=<секрет>
```

#### GitHub Secrets (репо tourhabk-ui/pos)

```
CRON_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NEXT_PUBLIC_APP_URL
```

#### Как активировать

1. Убедись, что `cron-watchdog.yml` активен (нет `on: workflow_dispatch` вместо `schedule`)
2. Проверь все 4 секрета в GitHub Actions Secrets
3. Запусти вручную: Actions → cron-watchdog → Run workflow
4. Проверь: в Telegram должен прийти статусный отчёт (даже если нет алертов — тишина это нормально; алерты приходят только при проблемах)

#### Как проверить работу

- **Прямая проверка:** `GET https://vedarai.ru/api/cron/watchdog?secret=<CRON_SECRET>` → `{"ok": true}`
- **Через логи:** таблица `agent_run_history` WHERE `agent_id = 'watchdog'` — смотреть `status`, `started_at`
- **Живой тест:** создай тестовое бронирование, переведи в `pending_payment`, подожди >24ч → должен прийти алерт

#### Типичные проблемы

| Проблема | Причина | Решение |
|----------|---------|---------|
| Нет алертов когда должны быть | `TELEGRAM_CHAT_ID` неверный | Проверить ID, убедиться что бот добавлен в чат |
| `CRON_SECRET not configured` | Переменная не установлена | Добавить в Timeweb env vars |
| Watchdog молчит >1ч | GitHub Actions упал / workflow отключён | Проверить вкладку Actions в репо |

---

### 2. Safety Ingest — Сейсмический монитор

**Файл:** `app/api/cron/safety-ingest/route.ts`  
**Workflow:** `cron-safety-ingest.yml`  
**Расписание:** каждые 5 минут — **самый частый агент системы**

#### Что делает

Собирает данные об угрозах с открытых источников и обновляет статусы точек в реальном времени:

1. Читает Telegram-каналы сейсмологов: `t.me/kbgsras` (КАМ сейсмика), `t.me/eqkam` (землетрясения)
2. Опционально: USGS earthquake API (глобальные данные)
3. Парсит тексты на коды угроз (сейсмика, вулканы, цунами, пожары)
4. Сохраняет в `external_alerts` с типом и серьёзностью
5. Обновляет `location_real_time_status` для затронутых зон
6. Отправляет Web Push уведомления подписчикам
7. Логирует в `agent_run_history`

**WMO опасные коды:** 63, 65, 73-99 (тяжёлые осадки, снег, гроза, метель).

#### Настройка

```env
CRON_SECRET=<секрет>
NEXT_PUBLIC_VAPID_KEY=<публичный VAPID ключ>
VAPID_PRIVATE_KEY=<приватный VAPID ключ>
TELEGRAM_BOT_TOKEN=<для отправки алертов>
TELEGRAM_CHAT_ID=<для отправки алертов>
```

**Генерация VAPID ключей:**
```bash
npx web-push generate-vapid-keys
```

#### Как активировать

1. Сгенерировать VAPID ключи, добавить в env
2. Workflow читает Telegram MTProto — убедиться что bot token не заблокирован
3. Проверить `cron-safety-ingest.yml` расписание `*/5 * * * *`
4. GitHub Actions должен поддерживать такую частоту (иногда нужно 2-минутный интервал)

#### Мониторинг

```sql
SELECT agent_id, status, started_at, metadata
FROM agent_run_history
WHERE agent_id = 'safety-ingest'
ORDER BY started_at DESC
LIMIT 10;
```

Если последний запуск >15 мин назад — Watchdog пришлёт алерт "мёртвый cron".

#### Критичность

Это **самый важный cron** с точки зрения безопасности туристов.  
Если он падает — туристы не получают уведомления об угрозах. Watchdog сразу заметит.

---

### 3. Rescue Agent — Агент спасения

**Файл:** `lib/agents/evo/rescue-agent.ts`  
**Эндпоинт:** `GET /api/cron/rescue`  
**Workflow:** `cron-rescue.yml` (⚠️ отключён — `workflow_dispatch` only)  
**Расписание:** вручную или каждые 30 мин (если включить)

#### Что делает

Проактивный мониторинг безопасности туристов. Сканирует 4 класса угроз:

1. **SOS события** — `sos_events` активные >10 мин без реакции → немедленный алерт
2. **Погода для активных туров** — запрашивает Open-Meteo для 6 зон Камчатки (petropavlovsk, paratunka, nalychevo, mutnovsky, kurilskoe, klyuchevskoy) → опасные WMO-коды → алерт операторам
3. **Неподтверждённые бронирования** — `operator_bookings` pending >24ч → алерт
4. **Пробелы у операторов** — нет активных туров >7 дней → напоминание

При каждой угрозе: формирует подробное Telegram-сообщение с конкретными данными (имя туриста, маршрут, GPS).

#### Почему отключён

Workflow помечен `workflow_dispatch` — агент создавался как часть evo-системы, но его функции частично перекрываются Watchdog'ом. Включать если нужно усиленное покрытие безопасности.

#### Как включить

В `cron-rescue.yml` заменить:
```yaml
on:
  workflow_dispatch:
```
на:
```yaml
on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:
```

#### Настройка

```env
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
CRON_SECRET=<секрет>
```

---

### 4. Danger Analyst — Аналитик опасности

**Файл:** `lib/agents/agencies/danger-analyst-agency.ts`  
**Вызывается:** Rescue Agent (каждые 30 мин)

#### Что делает

Структурированная оценка риска по зонам Камчатки. Рассчитывает числовой score (0–100) для каждой из 4 зон:
- `avachinsky` — Авачинская группа вулканов (Петропавловск)
- `northern` — Северная Камчатка (Ключевская группа)
- `eastern` — Восточный хребет
- `western` — Западное побережье

**Алгоритм:**
1. Читает свежие `external_alerts` для зоны
2. Анализирует `location_real_time_status` ближайших точек
3. Вызывает Claude для семантической оценки текстов тревог
4. Рассчитывает итоговый score

**Уровни:**
```
0–30:  low      — всё спокойно
30–55: moderate — стандартная осторожность
55–75: high     — рекомендовать изменить маршруты
75–100: critical — эвакуация / запрет выезда
```

#### Таблица хранения

```sql
danger_assessments (
  zone TEXT, risk_score INT, risk_level TEXT,
  tourists_at_risk INT, analysis_text TEXT,
  expires_at TIMESTAMP  -- 2 часа от создания
)
```

#### Настройка

Не требует отдельных env vars — использует стандартный Claude API через `getModelForAgent()`.

---

### 5. Checkin Watchdog — Контроль регистрации

**Файл:** `app/api/cron/checkin-watchdog/route.ts`  
**Workflow:** `cron-checkin-watchdog.yml`  
**Расписание:** каждый час

#### Что делает

3-ступенчатая эскалация для групп, не вышедших на связь после завершения маршрута:

| Ступень | Когда | Действие |
|---------|-------|----------|
| 1 (мягкая) | +1ч от плановой даты выхода | Telegram туристу: "Всё хорошо?" |
| 2 (твёрдая) | +3ч | Звонок контактному лицу + Telegram |
| 3 (МЧС) | +6ч | Уведомление МЧС + экстренный контакт |

Пишет в `route_registration_notifications` с типом `soft_escalation`, `hard_escalation`, `mchs_notify`.

#### Настройка

```env
CRON_SECRET=<секрет>
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
```

#### Как проверить

```sql
SELECT * FROM route_registration_notifications
ORDER BY created_at DESC LIMIT 20;
```

---

### 6. Route Escalation — Эскалация маршрутов

**Файл:** `app/api/cron/route-escalation/route.ts`  
**Workflow:** (встроен в cron-checkin-watchdog.yml или отдельный)  
**Расписание:** каждый час

#### Что делает

4-ступенчатая эскалация по времени суток для просроченных маршрутных регистраций:
- Ранние часы (00–06): только email
- Дневные (06–20): email + Telegram
- Вечерние (20–24): Telegram + звонок

Дублирует и расширяет логику Checkin Watchdog для маршрутов с официальной регистрацией в МЧС.

#### Настройка

```env
CRON_SECRET=<секрет>
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
# + email service env vars
```

---

### 7. SOS Events Bridge — Мост SOS событий

**Файл:** `app/api/cron/sos-events-bridge/route.ts`  
**Расписание:** каждые 30 минут

#### Что делает

Связующее звено между `sos_events` и агентной системой:

1. Читает активные SOS события
2. Публикует в шину событий агентов (`emitEvent`)
3. Автоматически архивирует события старше 24ч (`status → archived`)

**Важно:** Это не генератор SOS — он только передаёт уже созданные события дальше. Сами SOS создаются через `POST /api/safety/sos` (не трогать без staging).

#### Настройка

```env
CRON_SECRET=<секрет>
```

---

## Часть II — Контент и знания

---

### 8. Editor — Редактор маршрутов

**Файл:** `lib/agents/editor.ts`  
**Эндпоинт:** `GET /api/cron/editor`  
**Workflow:** `cron-editor.yml`  
**Расписание:** ежедневно 22:00 UTC (06:00 КМТ следующего дня)

#### Что делает

AI-улучшение описаний маршрутов без хороших описаний:

1. Находит 30 маршрутов в `agent_route_knowledge` где `description IS NULL` или длина <300 символов
2. Для каждого вызывает Claude: «напиши описание маршрута на Камчатке, 300–500 слов, для туриста»
3. Обновляет `agent_route_knowledge.description`
4. Обрабатывает 15 маршрутов за запуск (чтобы не превысить timeout)
5. Отправляет итоговый отчёт в Telegram

**Почему 22:00 UTC:** DeepSeek и другие AI-провайдеры дешевле и быстрее в оффпик (16:30–00:30 UTC).

#### Настройка

```env
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
CRON_SECRET=<секрет>
ANTHROPIC_API_KEY=<ключ Claude>
```

#### Как проверить эффективность

```sql
SELECT COUNT(*) as short_descriptions
FROM agent_route_knowledge
WHERE description IS NULL OR LENGTH(description) < 300;
-- Цель: 0 за 1-2 недели работы
```

#### Советы для максимальной эффективности

- Если описаний <300 очень много (>500) — увеличить batch с 15 до 30 в `editor.ts`
- Добавить `park_name` и `hazards` в промпт — тогда описания будут точнее
- Запускать после `import-routes` (23:00 UTC) — новые маршруты сразу получат описание

---

### 9. Import Routes — Импорт маршрутов

**Файл:** `app/api/cron/import-routes/route.ts`  
**Workflow:** `cron-import-routes.yml`  
**Расписание:** ежедневно 22:00 UTC

#### Что делает

Импортирует паспорта маршрутов с официальных источников:
- `visitkamchatka.ru` — официальный сайт туризма Камчатки (основной)
- `kamchatkaland.ru` — дополнительный

Процесс:
1. Скрейпит список маршрутов с сайта
2. Для каждого нового: читает полный паспорт (PDF или HTML)
3. AI-нормализует данные (длина, сложность, сезон)
4. INSERT в `agent_route_knowledge`, `places` (новые точки)
5. Запускает `places-enricher` для новых точек
6. Batch: 20–30 маршрутов за запуск

#### Настройка

```env
CRON_SECRET=<секрет>
ANTHROPIC_API_KEY=<ключ Claude>
```

#### Мониторинг

```sql
SELECT COUNT(*) FROM kamchatka_routes;  -- должен расти
SELECT COUNT(*) FROM places;            -- тоже
SELECT * FROM agent_run_history WHERE agent_id = 'import-routes' ORDER BY started_at DESC LIMIT 5;
```

---

### 10. Enrich Routes — Обогащение маршрутов

**Файл:** `app/api/cron/enrich-routes/route.ts`  
**Workflow:** `cron-enrich-routes.yml`  
**Расписание:** ежедневно 23:00 UTC (после import-routes)

#### Что делает

Вызывает внутренний эндпоинт `POST /api/admin/enrich-routes` для обогащения описаний:
- Берёт 20 маршрутов без AI-описания
- Claude переписывает/дополняет описание
- Обновляет `agent_route_knowledge`

Отличие от Editor: Editor работает с маршрутами у которых _совсем_ нет описания, Enrich — улучшает уже существующие (добавляет SEO-оптимизацию, структуру).

#### Настройка

```env
CRON_SECRET=<секрет>
# admin key для вызова /api/admin/enrich-routes
```

---

### 11. Places Enricher — Обогащение точек

**Файл:** `lib/agents/places-enricher.ts`  
**Вызывается:** из `import-routes` или вручную  
**Расписание:** по триггеру

#### Что делает

Скрейпит 3 Камчатских travel-сайта и обновляет описания точек в БД:

```
extraguide.ru   — путеводитель по Камчатке
tur-ray.ru      — туристические маршруты
spkam.com       — Сейшелы Камчатки (неформальный гид)
```

Алгоритм:
1. Для каждой точки в `agent_route_knowledge` без описания — нормализует название
2. Ищет на сайтах по нормализованному названию (Jaccard similarity ≥ 0.65)
3. При совпадении: скрейпит текст страницы (JSDOM)
4. AI-переписывает под стиль платформы
5. UPDATE `agent_route_knowledge.description`
6. Задержка 500мс между запросами (rate limiting)

**Batch:** 30 точек за запуск.

#### Настройка

```env
ANTHROPIC_API_KEY=<ключ Claude>
```

---

### 12. Kuzmich Place Enricher — Рецензии Кузьмича

**Файл:** `lib/agents/kuzmich-place-enricher.ts`  
**Эндпоинт:** `GET /api/cron/kuzmich-places`  
**Workflow:** `cron-kuzmich-places.yml` (⚠️ отключён)  
**Расписание:** вручную

#### Что делает

Генерирует персональные «кузьмичёвские» рецензии для точек на карте:

1. Выбирает точки с `places.kuzmich_review IS NULL` (batch 20)
2. Опционально: скрейпит отзывы с 2GIS через Bright Data API
3. Claude пишет 1–2 предложения в стиле «Кузьмич» (суровый местный гид):
   > «Корякский — не для пижонов. Два дня подъёма, ноги в кровь, зато сверху видно весь полуостров.»
4. UPDATE `places.kuzmich_review`

**Лимит:** 280 символов на рецензию (умещается в Telegram).

#### Как включить

```yaml
# cron-kuzmich-places.yml — раскомментировать schedule:
on:
  schedule:
    - cron: '0 10 * * 0'  # раз в неделю, воскресенье 10:00 UTC
  workflow_dispatch:
```

#### Настройка

```env
BRIGHT_DATA_API_KEY=<ключ Bright Data, опционально>
ANTHROPIC_API_KEY=<ключ Claude>
CRON_SECRET=<секрет>
```

#### Мониторинг

```sql
SELECT COUNT(*) FROM places WHERE kuzmich_review IS NOT NULL;
-- Цель: все 778 точек
```

---

### 13. Routes Cache Refresh — Кеш маршрутов

**Файл:** `app/api/cron/routes-cache-refresh/route.ts`  
**Workflow:** `cron-routes-cache.yml`  
**Расписание:** ежедневно 09:00 UTC

#### Что делает

Обновляет SEO-кеш описаний маршрутов в `route_description_cache`:
- По умолчанию: 50–100 маршрутов за запуск
- Вызывает `refreshRoutesWithoutCache()`
- Используется для генерации мета-описаний страниц маршрутов (SSG/ISR)

#### Настройка

```env
CRON_SECRET=<секрет>
```

---

## Часть III — Разведка и анализ

---

### 14. Scout Digest — Ежедневный дайджест

**Файл:** `lib/agents/scout-digest.ts`  
**Эндпоинт:** `GET /api/cron/scout-digest`  
**Workflow:** `cron-scout-digest.yml`  
**Расписание:** ежедневно 07:00 UTC

#### Что делает

Готовит утренний дайджест индустриальных новостей для платформы:

**5 RSS-источников:**
```
habr.com/rss/       — AI/Tech (русскоязычный)
rata-news.ru/rss    — туристическая отрасль России
tourprom.ru/rss     — турагентства и туроператоры
kamgov.ru/rss       — официальные новости Камчатки
tourprom.ru/rss     — второй feed (другой раздел)
```

**Алгоритм:**
1. Читает до 5 последних материалов из каждого feed
2. Дедупликация по URL (30-дневный TTL в `agent_memory`)
3. Фильтр релевантности: AI-оценка 0–10 (порог 5)
4. Синтез в 3–5 инсайтов через Claude Opus
5. Отправка в два Telegram-канала:
   - `TELEGRAM_CHAT_ID` — основной чат
   - `TELEGRAM_AI_CHANNEL_ID` — AI-канал

**Архивирует** в `agent_knowledge` ключ `intel/YYYY-MM-DD`.

#### Настройка

```env
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<основной чат>
TELEGRAM_AI_CHANNEL_ID=<AI канал, опционально>
ANTHROPIC_API_KEY=<Claude>
CRON_SECRET=<секрет>
```

#### Признаки работоспособности

- Каждое утро в 07:xx UTC в Telegram приходит сообщение «Дайджест» с 3–5 пунктами
- В `agent_knowledge`: `SELECT * FROM agent_knowledge WHERE key LIKE 'intel/%' ORDER BY created_at DESC LIMIT 5`

#### Улучшить дайджест

- Добавить региональные Telegram-каналы в источники (через group-scout агент)
- Повысить порог релевантности с 5 до 7 — меньше шума
- Добавить ключевые слова в промпт: «вулкан», «экотуризм», «Камчатка», «безопасность»

---

### 15. Scout Innovator — Генератор предложений

**Файл:** `lib/agents/scout-innovator.ts`  
**Эндпоинт:** `GET /api/cron/scout`  
**Workflow:** `cron-scout.yml` (3 шага: repo-scan → intelligence → scout)  
**Расписание:** ежедневно 08:00 UTC

#### Что делает

Генерирует технические предложения по развитию платформы на основе данных:

**Два прохода (2 Claude Opus вызова):**

1. **Phase 1** (JSON): анализирует статистику платформы + последние intelligence-данные → 2–3 структурированных предложения в JSON
2. **Phase 2** (Telegram): форматирует предложения для Telegram с markdown

**Дедупликация:** сравнивает с открытыми GitHub Issues через Jaccard similarity ≥ 0.5. Не создаёт дублей.

**Результат:**
- GitHub Issue создаётся через `GITHUB_ISSUES_TOKEN`
- Telegram-сообщение с предложениями
- Запись в `agent_knowledge` ключ `proposals/YYYY-MM-DD`

#### Настройка

```env
GITHUB_ISSUES_TOKEN=<Personal Access Token с правом issues:write>
GITHUB_TOKEN=<для repo-scan, тот же или другой>
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
ANTHROPIC_API_KEY=<Claude Opus>
CRON_SECRET=<секрет>
```

#### Как создать GITHUB_ISSUES_TOKEN

1. GitHub → Settings → Developer settings → Personal access tokens
2. Создать token с scope `repo` (или только `public_repo` для публичных репо)
3. Добавить в GitHub Secrets как `GITHUB_ISSUES_TOKEN`

#### Признаки работоспособности

- Раз в неделю+ в репо появляются новые Issues с тегами (автоматически)
- `SELECT * FROM agent_knowledge WHERE key LIKE 'proposals/%' ORDER BY created_at DESC LIMIT 5`

---

### 16. Intelligence — Мониторинг сигналов

**Файл:** `app/api/cron/intelligence/route.ts`  
**Расписание:** каждые 6 часов (встроен в cron-scout.yml)

#### Что делает

Мониторинг внешних сигналов и трендов, относящихся к платформе:
- Анализирует домены активности (туризм, AI, безопасность, Камчатка)
- Определяет urgency (0–10) для каждого сигнала
- Логирует в `ai_actions_log` и `agent_run_history`

Результаты используются Scout Innovator'ом как контекст для генерации предложений.

---

### 17. KB Gap — Заполнение пробелов KB

**Файл:** `app/api/cron/kb-gap/route.ts`  
**Расписание:** вручную (рекомендуется ежедневно)

#### Что делает

Находит темы о которых пользователи спрашивают Кузьмича, но в базе знаний нет ответов:

1. Анализирует `chat_sessions` — ищет вопросы без ответов (Kuzmich сказал «не знаю»)
2. Извлекает топ-5 неизвестных тем
3. Ищет информацию через Tavily API (или Brave Search как fallback)
4. Claude синтезирует ответ
5. Сохраняет в `agent_knowledge` с тегом `auto_gap`

#### Настройка

```env
TAVILY_API_KEY=<ключ Tavily Search>
BRAVE_SEARCH_API_KEY=<ключ Brave Search, fallback>
ANTHROPIC_API_KEY=<Claude>
CRON_SECRET=<секрет>
```

#### Получить ключи

- **Tavily:** tavily.com — бесплатный tier 1000 запросов/мес
- **Brave Search API:** api.search.brave.com — бесплатный tier 2000 запросов/мес

#### Рекомендуемый запуск

Ежедневно в 06:00 UTC (до scout-digest). Добавить в существующий workflow:

```yaml
- name: KB Gap
  run: curl -s "$APP_URL/api/cron/kb-gap?secret=$CRON_SECRET"
```

---

### 18. Group Scout — Разведка Telegram групп

**Файл:** `app/api/cron/group-scout/route.ts`  
**Расписание:** вручную (рекомендуется каждые 12 часов)

#### Что делает

Мониторинг релевантных Telegram-групп и каналов:
- Сканирует список известных тематических групп (туризм, Камчатка, безопасность)
- AI-фильтрует сообщения по релевантности (0–10, порог 7)
- Сохраняет ценные данные в `agent_memory`
- Максимум: 5 новых групп в день

Использует gramjs (Telegram MTProto) — **требует отдельной авторизации**, не через bot token.

#### Настройка (сложная)

Для MTProto нужен Telegram API ID/Hash:
1. my.telegram.org → API Development Tools
2. Создать приложение → получить `api_id` и `api_hash`
3. Авторизоваться (потребует номер телефона — **не рекомендуется для cron**, используй отдельный аккаунт)

```env
TELEGRAM_API_ID=<api id>
TELEGRAM_API_HASH=<api hash>
# session string (gramjs)
TELEGRAM_SESSION_STRING=<string session>
```

---

## Часть IV — Бизнес-операции

---

### 19. Abandoned Bookings — Брошенные бронирования

**Файл:** `app/api/cron/abandoned-bookings/route.ts`  
**Workflow:** `cron-payments.yml`  
**Расписание:** каждый час

#### Что делает

Двухступенчатая работа с брошенными бронированиями:

| Ситуация | Действие |
|----------|----------|
| `pending_payment` >2ч | Telegram туристу: «Завершите оплату» (с ссылкой) |
| `pending_payment` >24ч | Автоматическая отмена, `status → cancelled` + метаданные |

После отмены: оператор получает уведомление, слот освобождается.

#### Настройка

```env
CRON_SECRET=<секрет>
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
NEXT_PUBLIC_APP_URL=<URL платформы>
```

#### Мониторинг

```sql
SELECT booking_status, COUNT(*) FROM operator_bookings
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY booking_status;
-- cancelled из-за timeout будут иметь metadata с причиной
```

---

### 20. Payouts — Выплаты операторам

**Файл:** `app/api/cron/payouts/route.ts`  
**Workflow:** встроен в cron-payments.yml  
**Расписание:** каждый час

#### Что делает

Освобождение задержанных платежей операторам:

1. Находит `tour_payments` в статусе `HELD` старше 36ч
2. Меняет статус на `RELEASED`
3. Вызывает `recalculate_commission()` — пересчёт комиссии
4. Telegram-уведомление оператору о получении выплаты

**36-часовая задержка** — антифрод-мера: окно для возможного chargeback от туриста.

#### ⚠️ Важно

Это финансовая операция. Перед изменением логики — консультация с платёжной системой. Операция **необратима** (HELD→RELEASED).

#### Настройка

```env
CRON_SECRET=<секрет>
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
```

---

### 21. Leads Process — Обработка лидов

**Файл:** `app/api/cron/leads-process/route.ts`  
**Workflow:** `cron-leads.yml`  
**Расписание:** вручную (рекомендуется каждые 30 мин)

#### Что делает

Повторная обработка неуспешных лидов:

1. Находит `leads` где AI-обработка упала (`status = failed`) или не запускалась >2 мин
2. Запускает `leadProcessor.process()` (lib/services/lead-processor.service.ts)
3. Максимум 10 лидов за запуск
4. AI квалифицирует лид (горячий/тёплый/холодный), формирует предложение

#### Настройка

```env
CRON_SECRET=<секрет>
ANTHROPIC_API_KEY=<Claude для квалификации>
TELEGRAM_BOT_TOKEN=<токен для уведомлений>
TELEGRAM_CHAT_ID=<чат>
```

#### Включить в workflow (cron-leads.yml)

```yaml
on:
  schedule:
    - cron: '*/30 * * * *'
```

---

### 22. Followups — Следующие шаги по лидам

**Файл:** `app/api/cron/followups/route.ts`  
**Workflow:** `cron-leads.yml`  
**Расписание:** вместе с leads-process

#### Что делает

Обрабатывает запланированные follow-up действия по лидам:

1. Находит `lead_followups` со `status = pending` и `scheduled_at <= NOW()`
2. Отправляет в Telegram с кнопками «Выполнено» / «Пропустить»
3. Обновляет `status → sent` или `skipped`
4. Максимум 10 за запуск

#### Настройка

```env
CRON_SECRET=<секрет>
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
```

---

### 23. Tour Reminder — Напоминание о туре

**Файл:** `app/api/cron/tour-reminder/route.ts`  
**Workflow:** `cron-tour-reminder.yml`  
**Расписание:** ежедневно 06:00 UTC (18:00 КМТ накануне)

#### Что делает

Комплексное напоминание туристу за 24 часа до тура:

1. Находит бронирования на завтра (`operator_bookings` confirmed, start_date = завтра)
2. Для каждого бронирования:
   - Запрашивает прогноз погоды Open-Meteo для района маршрута
   - Проверяет актуальные МЧС-предупреждения (mchs.gov.ru)
   - Claude составляет персональное сообщение: приветствие, погода, что взять, точка сбора
3. Отправляет через Telegram + MAX API (VK)
4. Помечает `reminder_sent_24h = true`

#### Настройка

```env
CRON_SECRET=<секрет>
TELEGRAM_BOT_TOKEN=<токен>
MAX_BOT_TOKEN=<токен MAX API>
ANTHROPIC_API_KEY=<Claude для персонализации>
```

#### Проверить

```sql
SELECT id, tourist_name, tour_start_date, reminder_sent_24h
FROM operator_bookings
WHERE tour_start_date = CURRENT_DATE + 1
ORDER BY created_at DESC;
```

---

### 24. Trip Reminders — Напоминания туристу

**Файл:** `app/api/cron/trip-reminders/route.ts`  
**Расписание:** каждый день 19:00 UTC (07:00 КМТ)

#### Что делает

Напоминания о предстоящих самостоятельных поездках (не через оператора):

1. Находит `tourist_trips` с `start_date = TODAY + 2` и `status IN ('planning', 'upcoming')`
2. Запрашивает погоду через wttr.in для `destination`
3. Отправляет Telegram-напоминание: дата, место, погода, рекомендации

**Отличие от Tour Reminder:** работает с личными поездками туристов, не с тур-бронированиями.

---

### 25. Smart Notify — Умные уведомления

**Файл:** `app/api/cron/smart-notify/route.ts`  
**Workflow:** `cron-smart-notify.yml`  
**Расписание:** ежедневно 09:00 UTC

#### Что делает

Персонализированные предложения туров на основе предпочтений пользователей:

1. Читает профили туристов + `user_ai_memory`
2. Матчит с активными `operator_tours`
3. Claude оценивает совпадение (0–10)
4. При score ≥ 7: отправляет персонализированное предложение

Использует данные из Memory Bridge (каждые 6ч синхронизирует `user_ai_memory → agent_memory`).

---

### 26. Support Escalate — Эскалация поддержки

**Файл:** `app/api/cron/support-escalate/route.ts`  
**Расписание:** каждые 6 часов

#### Что делает

Автоматическая эскалация тикетов поддержки:

1. Находит открытые тикеты старше 24ч без ответа
2. Эскалирует через `escalateTicket()`:
   - Telegram-уведомление администратору
   - Email оператору/менеджеру
3. Записывает в `route_registration_notifications`

---

## Часть V — Инфраструктура

---

### 27. Health — Проверка здоровья

**Файл:** `app/api/cron/health/route.ts`  
**Workflow:** встроен в cron-watchdog.yml (warmup ping)  
**Расписание:** каждый час

#### Что делает

Проверка всех внешних зависимостей:

1. **AI-провайдеры**: пробует Claude, OpenRouter, DeepSeek, MiMo — записывает latency
2. **Задержанные платежи**: `tour_payments` в HELD >48ч → алерт
3. **Необработанные лиды**: `leads` ожидающие >2ч → алерт

Результаты: `ai_actions_log` с типом `health_check`.

#### Настройка

```env
ANTHROPIC_API_KEY=<Claude>
OPENROUTER_API_KEY=<OpenRouter>
DEEPSEEK_API_KEY=<DeepSeek>
CRON_SECRET=<секрет>
```

---

### 28. LLM Budget Check — Бюджет AI

**Файл:** `app/api/cron/llm-budget-check/route.ts`  
**Расписание:** вручную (рекомендуется каждый час)

#### Что делает

Суммирует дневные расходы на AI из `llm_usage_log`.  
Если сумма ≥ `AI_DAILY_BUDGET_USD` → Telegram-алерт через `notifyBudgetAlert()`.

#### Настройка

```env
AI_DAILY_BUDGET_USD=10.00  # лимит в долларах
TELEGRAM_BOT_TOKEN=<токен>
TELEGRAM_CHAT_ID=<чат>
CRON_SECRET=<секрет>
```

#### Добавить в cron-watchdog.yml

```yaml
- name: Budget check
  run: |
    curl -s "$APP_URL/api/cron/llm-budget-check?secret=$CRON_SECRET"
```

---

### 29. Telegram Webhook Watchdog — Watchdog вебхука

**Файл:** `app/api/cron/telegram-webhook-watchdog/route.ts`  
**Расписание:** вручную (рекомендуется каждые 30 мин)

#### Что делает

Проверяет что Telegram Bot вебхук установлен правильно:

1. `GET https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
2. Если вебхук не установлен или указывает не на `NEXT_PUBLIC_APP_URL` → восстанавливает
3. Логирует в `agent_run_history`

Полезно после деплоя — иногда Timeweb меняет IP и вебхук перестаёт работать.

#### Как добавить в watchdog workflow

```yaml
- name: Webhook check
  run: |
    curl -s "$APP_URL/api/cron/telegram-webhook-watchdog?secret=$CRON_SECRET"
```

---

### 30. Memory Bridge — Мост памяти

**Файл:** `app/api/cron/memory-bridge/route.ts`  
**Расписание:** каждые 6 часов

#### Что делает

Синхронизирует пользовательские предпочтения между таблицами:

```
user_ai_memory (предпочтения пользователя)
         ↓  syncUserDemandToAgentMemory()
agent_memory (Planning, Hacker, Content агенты)
```

Обеспечивает что умные уведомления (Smart Notify) и Kuzmich используют актуальные предпочтения.

---

## Часть VI — Эволюция

---

### 31. Evo System — Система эволюции

**Эндпоинт:** `GET /api/cron/evo?type=full`  
**Workflow:** `cron-evo.yml`  
**Расписание:** каждые 6 часов

#### Архитектура

```
runEvoOrchestrator()
    ├── Growth Agent       ←── параллельно
    ├── Evolver Analysis   ←── параллельно  
    └── Rescue Agent       ←── параллельно
    
    └── Evolution Loop     ←── последовательно (пишет фиксы)
```

#### Поток данных

```
1. Growth Agent сканирует код → находит проблемы → evo_growth_issues
2. Evolver Analysis анализирует проблемы → evo_evolution_log (diff, suggestion)
3. Evolution Loop исполняет → evo_evolution_log (diff_summary, status='pending')
4. [UI] Администратор просматривает фиксы → одобряет/отклоняет
5. Feedback Loop → обновляет статусы
```

#### UI для просмотра (создан в этой сессии)

`/hub/admin/agents` → секция «Эволюция» → вкладки «Проблемы» и «Фиксы»

---

### 32. Growth Agent

**Файл:** `lib/agents/evo/growth-agent.ts`

#### Что делает

«Детектор проблем» — сканирует кодовую базу на нарушения правил CLAUDE.md:
- Паттерны SQL (SELECT *, конкатенация, неверные таблицы)
- TypeScript нарушения (any, console.log)
- Дизайн-система (хардкод цвета, запрещённые классы)
- Отсутствие Zod-валидации в API
- Отсутствие auth check

Каждая найденная проблема → INSERT в `evo_growth_issues` с полями:
```
category, severity (critical/high/medium/low),
file_path, title, description, suggestion, status='open'
```

---

### 33. Evolution Loop

**Файл:** `lib/agents/evo/evolution-loop.ts`

#### Что делает

«Исправитель» — берёт проблемы из `evo_growth_issues` и генерирует патчи:

1. Находит `open` или `suggested` проблемы
2. Читает исходный файл
3. Claude генерирует diff/исправление
4. Записывает в `evo_evolution_log`:
   ```
   issue_id, action='fix', status='pending',
   diff_summary (текст), diff (JSON патч)
   ```
5. **Не применяет автоматически** — ждёт одобрения администратора через UI

#### Как закрыть петлю (UI)

`/hub/admin/agents` → «Фиксы» → просмотреть diff → «Применён» или «Отклонить»

---

### 34. Evolver Analysis

**Файл:** `lib/agents/evo/evolver-analysis.ts`

#### Что делает

Аналитический компонент — приоритизирует проблемы:
- Кластеризует похожие проблемы
- Оценивает impact (насколько критично для пользователей)
- Обновляет severity в `evo_growth_issues`
- Генерирует сводку для администратора

---

### 35. Feedback Loop

**Файл:** `lib/agents/evo/feedback-loop.ts`

#### Что делает

Обратная связь по применённым/отклонённым патчам:
- Анализирует `evo_evolution_log` со `status='merged'` или `status='rejected'`
- Выявляет паттерны: какие типы проблем решаются, какие нет
- Обновляет приоритеты Growth Agent
- Уменьшает повторное обнаружение уже решённых проблем

---

## Часть VII — Каналы

---

### 36. Kuzmich — Главный бот

**Файл:** `lib/kuzmich/core.ts`  
**Каналы:** Telegram, MAX (VK), Web виджет, Widget

#### Что делает

Многоканальный AI-консультант — «суровый местный гид» Камчатки:

- **Telegram:** `POST /api/telegram-webhook` — принимает сообщения
- **MAX:** `POST /api/max-webhook` — VK Мессенджер
- **Web:** через chat виджет на сайте
- **Контекст:** знает о маршрутах, точках, погоде, безопасности
- **Kuzmich Review:** показывает личные рецензии мест
- **Лиды:** при намерении купить тур → создаёт лид → leads-process

#### Расписание постов

| Workflow | Тип | Время |
|---------|-----|-------|
| `cron-kuzmich-route.yml` | Пост про маршрут | ежедневно 09:00 UTC |
| `cron-kuzmich-sezon.yml` | Сезонный пост | отключён |
| `cron-kuzmich-tip.yml` | Советы | отключён |

#### Настройка

```env
TELEGRAM_BOT_TOKEN=<токен основного бота>
MAX_BOT_TOKEN=<токен MAX бота>
ANTHROPIC_API_KEY=<Claude для диалогов>
```

#### Зарегистрировать вебхук Telegram

```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://vedarai.ru/api/telegram-webhook"
```

---

### 37. Channel Sync — Синхронизация каналов

**Файл:** `lib/channels/channel-manager.ts`  
**Адаптеры:** `tripster.ts`, `avito.ts`  
**Статус:** ⚠️ Инфраструктура готова — операционная настройка НЕ выполнена

#### Что делает

Синхронизация бронирований с внешними маркетплейсами:

```
operator_tours ──► [adapter] ──► Tripster / Avito
       ▲                                │
       └────── channel_orders ◄─────────┘
```

**Tripster:** полная двусторонняя интеграция
- Публикует туры через REST API
- Получает заказы через polling
- Синхронизирует статусы

**Avito:** XML-лента + Messenger API
- XML-фид публикуется по URL
- Avito читает фид (pull-модель)
- Входящие лиды через Messenger API

**Sputnik8:** колонка в БД есть, адаптера нет.

#### ❌ Почему не работает сейчас

Не выполнены шаги:
1. Не зарегистрирован XML-фид в Avito (dashboard → Добавить источник)
2. Нет API-токена Tripster (нужно подписать договор с Tripster)
3. Туры не созданы/не опубликованы на Tripster
4. Нет GitHub Actions cron для channel-sync
5. `TRIPSTER_API_KEY`, `AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET` — не установлены

#### Шаги для запуска Channel Sync

**Шаг 1: Tripster**
1. Зарегистрировать компанию на partner.tripster.ru
2. Подписать договор с Tripster (ОФД обязательна)
3. Получить `TRIPSTER_API_KEY` и `TRIPSTER_PARTNER_ID`
4. Создать туры в Tripster (через API или dashboard)
5. Добавить в env: `TRIPSTER_API_KEY`, `TRIPSTER_PARTNER_ID`

**Шаг 2: Avito**
1. Зарегистрировать аккаунт Avito для бизнеса
2. Получить Client ID и Secret в авторизованных приложениях Avito
3. Добавить в env: `AVITO_CLIENT_ID`, `AVITO_CLIENT_SECRET`
4. Зарегистрировать XML-фид: `https://vedarai.ru/api/channels/avito/feed.xml`
5. В Avito dashboard: Профессиональный кабинет → Управление объявлениями → Загрузить фид

**Шаг 3: Создать GitHub Actions workflow**
```yaml
# .github/workflows/cron-channel-sync.yml
name: Channel Sync
on:
  schedule:
    - cron: '*/15 * * * *'  # каждые 15 мин
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - name: Sync channels
        run: |
          curl -X POST "${{ secrets.APP_URL }}/api/cron/channel-sync" \
            -H "X-Cron-Secret: ${{ secrets.CRON_SECRET }}"
```

#### Мониторинг (после запуска)

```sql
SELECT channel, status, COUNT(*)
FROM channel_orders
GROUP BY channel, status;
```

---

## Приложения

---

## A. Переменные окружения

### Обязательные (без них платформа не работает)

```env
DATABASE_URL=postgresql://...
JWT_SECRET=<случайная строка 64+ символа>
CRON_SECRET=<случайная строка>
NEXT_PUBLIC_APP_URL=https://vedarai.ru
```

### Telegram (большинство агентов)

```env
TELEGRAM_BOT_TOKEN=      # основной бот
TELEGRAM_CHAT_ID=        # ID чата администратора
TELEGRAM_AI_CHANNEL_ID=  # канал AI-дайджеста (scout-digest)
```

### AI провайдеры

```env
ANTHROPIC_API_KEY=       # Claude — основной провайдер
OPENROUTER_API_KEY=      # fallback для некоторых агентов
DEEPSEEK_API_KEY=        # fallback editor/enrich (off-peak)
```

### Каналы и маркетплейсы

```env
TRIPSTER_API_KEY=        # Tripster партнёрский API
TRIPSTER_PARTNER_ID=     # ID партнёра
AVITO_CLIENT_ID=         # Avito OAuth client
AVITO_CLIENT_SECRET=     # Avito OAuth secret
```

### Уведомления и интеграции

```env
MAX_BOT_TOKEN=           # VK MAX бот
GITHUB_ISSUES_TOKEN=     # для scout-innovator (создание issues)
GITHUB_TOKEN=            # для repo-scan
BRIGHT_DATA_API_KEY=     # 2GIS скрейпинг (kuzmich-place-enricher)
TAVILY_API_KEY=          # веб-поиск (kb-gap)
BRAVE_SEARCH_API_KEY=    # fallback поиск (kb-gap)
```

### Web Push (safety-ingest)

```env
NEXT_PUBLIC_VAPID_KEY=   # публичный VAPID ключ
VAPID_PRIVATE_KEY=       # приватный VAPID ключ
```

### Бизнес-лимиты

```env
AI_DAILY_BUDGET_USD=10   # лимит расходов AI в день
```

### CloudPayments (не трогать!)

```env
CLOUDPAYMENTS_PUBLIC_ID=
CLOUDPAYMENTS_SECRET=
```

---

## B. Расписание

| Агент | Cron | UTC время | Примечание |
|-------|------|-----------|------------|
| Safety Ingest | `*/5 * * * *` | каждые 5 мин | Критично! |
| Watchdog | `*/30 * * * *` | каждые 30 мин | + warmup |
| SOS Events Bridge | `*/30 * * * *` | каждые 30 мин | |
| Abandoned Bookings | `0 * * * *` | каждый час | |
| Payouts | `0 * * * *` | каждый час | |
| Health | `0 * * * *` | каждый час | |
| Checkin Watchdog | `0 * * * *` | каждый час | + warmup |
| Intelligence | `0 */6 * * *` | каждые 6ч | |
| Memory Bridge | `0 */6 * * *` | каждые 6ч | |
| Support Escalate | `0 */6 * * *` | каждые 6ч | |
| Evo System | `0 */6 * * *` | каждые 6ч | |
| Scout Digest | `0 7 * * *` | 07:00 | дайджест |
| Scout / Innovator | `0 8 * * *` | 08:00 | предложения |
| Smart Notify | `0 9 * * *` | 09:00 | |
| Routes Cache | `0 9 * * *` | 09:00 | |
| Kuzmich Route | `0 9 * * *` | 09:00 | пост |
| Tour Reminder | `0 6 * * *` | 06:00 | |
| Trip Reminders | `19 * * * *` | 19:00 | |
| Import Routes | `0 22 * * *` | 22:00 | |
| Editor | `0 22 * * *` | 22:00 | |
| Enrich Routes | `0 23 * * *` | 23:00 | |

---

## C. GitHub Actions

| Workflow | Файл | Активен |
|---------|------|---------|
| cron-watchdog.yml | Watchdog | ✅ |
| cron-safety-ingest.yml | Safety Ingest | ✅ |
| cron-payments.yml | Payouts + Abandoned Bookings | ✅ |
| cron-editor.yml | Editor | ✅ |
| cron-import-routes.yml | Import Routes | ✅ |
| cron-enrich-routes.yml | Enrich Routes | ✅ |
| cron-scout-digest.yml | Scout Digest | ✅ |
| cron-scout.yml | Scout + Intelligence | ✅ |
| cron-evo.yml | Evo System | ✅ |
| cron-tour-reminder.yml | Tour Reminder | ✅ |
| cron-smart-notify.yml | Smart Notify | ✅ |
| cron-routes-cache.yml | Routes Cache | ✅ |
| cron-leads.yml | Leads + Followups | ✅ (без cron) |
| cron-checkin-watchdog.yml | Checkin Watchdog | ✅ |
| cron-kuzmich-route.yml | Kuzmich Route Post | ✅ |
| cron-rescue.yml | Rescue Agent | ❌ отключён |
| cron-kuzmich-sezon.yml | Kuzmich Seasonal | ❌ отключён |
| cron-kuzmich-places.yml | Kuzmich Place Enricher | ❌ отключён |
| cron-kuzmich-tip.yml | Kuzmich Tips | ❌ отключён |

---

## D. Таблицы БД

| Таблица | Пишут агенты |
|---------|-------------|
| `operator_bookings` | abandoned-bookings, payouts, tour-reminder |
| `lead_followups` | followups |
| `agent_route_knowledge` | editor, places-enricher, import-routes, enrich-routes |
| `agent_knowledge` | scout-digest, scout-innovator, kb-gap |
| `agent_memory` | scout-digest, memory-bridge, group-scout |
| `tour_payments` | payouts |
| `external_alerts` | safety-ingest |
| `location_real_time_status` | safety-ingest |
| `sos_events` | sos-events-bridge |
| `route_registration_notifications` | checkin-watchdog, route-escalation, support-escalate |
| `agent_run_history` | safety-ingest, intelligence, telegram-webhook-watchdog, watchdog |
| `ai_actions_log` | intelligence, health |
| `danger_assessments` | danger-analyst-agency (TTL 2ч) |
| `evo_growth_issues` | growth-agent |
| `evo_evolution_log` | evolution-loop |
| `places` | kuzmich-place-enricher (kuzmich_review) |
| `route_description_cache` | routes-cache-refresh |
| `llm_usage_log` | все AI агенты (через callAI*) |

---

## E. Чеклист запуска

### Минимальный запуск (безопасность + деньги)

- [ ] `CRON_SECRET` установлен в Timeweb env vars
- [ ] `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` установлены
- [ ] `NEXT_PUBLIC_APP_URL=https://vedarai.ru` установлен
- [ ] В GitHub Secrets: `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_URL`
- [ ] `cron-watchdog.yml` — активен, проверить логи Actions
- [ ] `cron-safety-ingest.yml` — активен, запустить вручную → проверить `agent_run_history`
- [ ] `cron-payments.yml` — активен
- [ ] `cron-checkin-watchdog.yml` — активен
- [ ] Вебхук Telegram зарегистрирован: `/api/cron/telegram-webhook-watchdog`

### Полный запуск (весь функционал)

- [ ] `ANTHROPIC_API_KEY` — для Editor, Scout, Intelligence, Tour Reminder
- [ ] `GITHUB_ISSUES_TOKEN` — для Scout Innovator
- [ ] `VAPID_PRIVATE_KEY` + `NEXT_PUBLIC_VAPID_KEY` — для Safety Ingest push
- [ ] `TAVILY_API_KEY` или `BRAVE_SEARCH_API_KEY` — для KB Gap
- [ ] Запустить `cron-editor.yml` вручную — проверить что описания появляются
- [ ] Запустить `cron-scout-digest.yml` вручную — получить дайджест в Telegram
- [ ] `cron-evo.yml` — запустить → проверить `evo_growth_issues` в `/hub/admin/agents`

### Channel Sync (отдельный проект)

- [ ] Договор с Tripster + `TRIPSTER_API_KEY`
- [ ] Avito бизнес-аккаунт + `AVITO_CLIENT_ID`/`AVITO_CLIENT_SECRET`
- [ ] Зарегистрировать XML-фид в Avito
- [ ] Создать `cron-channel-sync.yml`
- [ ] Протестировать: 1 тур → Tripster → проверить channel_orders

### Мониторинг (после запуска)

```sql
-- Сводка последних запусков агентов
SELECT agent_id, status, started_at, duration_ms
FROM agent_run_history
ORDER BY started_at DESC
LIMIT 50;

-- Активные проблемы эволюции
SELECT severity, category, COUNT(*) FROM evo_growth_issues
WHERE status IN ('open', 'suggested')
GROUP BY severity, category
ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END;

-- Расходы AI сегодня
SELECT SUM(cost_usd) as today_spend
FROM llm_usage_log
WHERE created_at > CURRENT_DATE;
```

---

*Книга агентов KamchatourHub v1.0 — июнь 2026*  
*Обновлять при добавлении новых агентов или изменении расписания*
