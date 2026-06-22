# TourHab / KamchatourHub

Туристическая платформа Камчатки — от поиска маршрута до экстренной помощи в поле.  
Также известна как **Volcano OS**.

**[tourhab.ru](https://tourhab.ru)** · Next.js 15 · PostgreSQL · TypeScript strict · PWA · Offline-first · AI

---

## Что это

Полноценная B2C/B2B платформа: туристы ищут маршруты и бронируют туры, операторы управляют предложениями, гиды ведут группы. В основе — **безопасность**: каждое место имеет профиль опасности, реалтайм-статус и привязку к МЧС.

Платформа работает в поле без интернета: офлайн-карты, экстренная страница, инструкции выживания, SOS с меш-ретрансляцией.

---

## Стек

| Слой | Технология |
|------|-----------|
| Frontend | Next.js 15 App Router, TypeScript strict, Tailwind CSS |
| База данных | PostgreSQL — прямой SQL, без ORM |
| Аутентификация | JWT, role-based middleware |
| AI | Waterfall: 11 провайдеров — OpenRouter · DeepSeek · Gemini · MiMo · GLM · NVIDIA · xAI · YandexGPT · MiniMax · MuseSpark · Anthropic |
| PWA | Service Worker, Web Push (VAPID), Background Sync, IndexedDB |
| Меш | WebRTC P2P (VolcanoMesh) — SOS-ретрансляция между устройствами группы |
| Деплой | Timeweb Cloud — автодеплой при пуше в `main` |
| Боты | Telegram + MAX (Kuzmich) |

---

## Масштаб

| | |
|--|--|
| Страниц | 169 |
| API routes | 509 |
| UI компонентов | 188 |
| SQL миграций | 178 |
| Мест (places) | 779 |
| Маршрутов | 294 |
| Туров | 20 |
| Аттестованных гидов | 112 |

---

## Структура данных

Три сущности — три таблицы:

```
places (779)           — географический факт: вулкан, озеро, источник
kamchatka_routes (294) — маршрут между точками, трек, сложность
operator_tours (20)    — коммерческий продукт: цена, слоты, бронь
```

Безопасность каждого места — `location_safety_profile` + `location_real_time_status`.
Связь маршрут→точки — `route_waypoints`.

---

## Офлайн и безопасность в поле

### `/emergency.html` — статичная аварийная страница
- 12 КБ, нулевые зависимости, OLED-тёмная тема
- Первый в PRECACHE_URLS → кэшируется при установке PWA
- GPS-координаты → скопировать → назвать оператору 112
- Большая кнопка 112, МЧС Камчатка, ПАСС
- 4 протокола inline: Потерялся · Медведь · Травма · Холодно
- Работает без JavaScript-фреймворка, без сети

### `/sos` — расширенный SOS-экран
- Отправка сигнала с офлайн-очередью (IndexedDB + Background Sync)
- VolcanoMesh: WebRTC P2P ретрансляция SOS через группу
- Спутниковая диктовка — текст для чтения оператору

### `/safety/offline` — инструкции выживания
- Медведь, вулкан, гипотермия, потерялся, сигнализация, вода
- Precached, работает без интернета

### Офлайн-карта
- Тайлы Камчатки зум 7–9 кэшируются при установке (~8 МБ)
- Зум 10+ скачивается по маршруту через `/offline/manage`

---

## AI-агенты

| Группа | Примеры | Расписание |
|--------|---------|-----------|
| **Безопасность** | Safety Ingest, Watchdog, Rescue, SOS Bridge | каждые 5–30 мин |
| **Контент** | Editor, Import Routes, Enrich Routes, Places Enricher | 22:00–23:00 UTC |
| **Разведка** | Scout Digest, Scout Innovator, Intelligence, KB Gap | 07:00–08:00 UTC |
| **Бизнес** | Abandoned Bookings, Payouts, Tour Reminder, Leads | почасово / 06:00 UTC |
| **Эволюция** | Evo System (Growth Agent + Evolution Loop) | каждые 6ч |
| **Боты** | Kuzmich (Telegram, MAX, Web, Widget) | realtime |

**Общая память агентов:** каждый агент на старте читает `readAgentBriefing()` — состояние платформы, историю своих запусков, last repo-scan, must-have контекст туризма на Камчатке.

Полный реестр с настройкой и шагами активации: [`docs/AGENTS_BOOK.md`](./docs/AGENTS_BOOK.md)  
Краткий реестр: [`AGENTS.md`](./AGENTS.md)

---

## Хабы

| Хаб | Путь | Роли |
|-----|------|------|
| Туристы | `/hub/tourist/` | tourist |
| Операторы | `/hub/operator/` | operator |
| Гиды | `/hub/guide/` | guide |
| Безопасность | `/hub/safety` | public |
| Трансфер | `/hub/transfer/` | transfer_operator |
| Маркетинг | `/hub/marketing/` | marketing |
| Партнёры | `/hub/partners/` | partner |
| Поддержка | `/hub/support/` | support |
| Админ | `/hub/admin/` | admin |

---

## Разработка

```bash
npm install
cp .env.example .env.local
npm run dev
```

```bash
npm run dev           # dev-сервер
npx tsc --noEmit      # type check (0 ошибок)
npx vitest run        # тесты
npm run migrate       # миграции локально
git push origin main  # → Timeweb автодеплой
```

### Ключевые соглашения

- `import { pool } from '@/lib/db-pool'` — только named import
- `FROM operator_bookings` / `FROM operator_tours` — не `bookings`, не `tours`
- SQL — только параметризованный (`$1, $2`), никогда конкатенация
- Все API routes — Zod-валидация входных данных
- Цвета — только CSS custom properties (`var(--accent)`, `var(--ocean)`)
- AI — только через `callAIWaterfall()` / `callAIFast()`
- `SELECT * FROM kamchatka_routes` — только через `v_kamchatka_routes_api`; везде — explicit columns

---

## Деплой

Push в `main` → Timeweb видит пуш → собирает Docker → `start.js` накатывает миграции → поднимает сервер.

Приложение: **Fair Polydeuces** на Timeweb Cloud. Репо: `tourhabk-ui/pos`.

**Docker:** standalone bundle ≤ 50 МБ, `images.unoptimized: true` (убирает sharp ~33 МБ).

---

## Последние изменения (июнь 2026)

- **Evo UI** — просмотр и одобрение фиксов агента эволюции в `/hub/admin/agents` (закрытая петля обратной связи)
- **Agents Book** — полная документация всех 37+ агентов в `docs/AGENTS_BOOK.md` (расписание, env vars, шаги активации, мониторинг)
- **Schema-drift защита** — явные колонки вместо `SELECT *` / `RETURNING *` в tourist API routes
- **audit.mjs** — калибровка гейта: 0 ложных срабатываний, generic `SELECT *` downgraded to warning, новый critical-check на `SELECT * FROM kamchatka_routes`
- **Channel Sync** — инфраструктура Tripster/Avito готова (`lib/channels/`), ожидает API-ключи операторов
- **Карта** — исправлена перезагрузка каждую секунду на Android (мемоизация маркеров, GPS-троттлинг >10м)
- **Repo Scanner** — ежедневное сканирование: 12 таблиц БД, дерево репо, 10 production-эндпоинтов → в брифинг агентов

---

*Камчатка. Вулканы. Медведи. Код.*
