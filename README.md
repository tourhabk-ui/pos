# TourHab / KamchatourHub

Саморазвивающаяся туристическая платформа Камчатки — от бронирования тура до безопасности в маршруте.

**[vedarai.ru](https://vedarai.ru)** · Next.js 15 · PostgreSQL · TypeScript strict · PWA · AI-first

---

## Что это

Полноценная B2C/B2B платформа: туристы ищут маршруты и бронируют туры, операторы управляют предложениями, гиды ведут группы. В основе — безопасность: каждое место имеет профиль опасности, реалтайм-статус и привязку к МЧС.

Платформа **саморазвивается**: фоновые агенты сканируют метрики, удаляют мертвый код, добавляют индексы, переписывают описания — без участия человека.

---

## Стек

| Слой | Технология |
|------|-----------|
| Frontend | Next.js 15 App Router, TypeScript strict, Tailwind CSS |
| База данных | PostgreSQL — прямой SQL, без ORM |
| Аутентификация | JWT, role-based middleware |
| AI | Waterfall: DeepSeek → Gemini → MiniMax → Anthropic |
| PWA | Service Worker, Web Push (VAPID), Background Sync, Offline-first |
| Деплой | Timeweb Cloud — автодеплой при пуше в `main` |
| Боты | Telegram (Kuzmich + операторы) |

---

## Масштаб

| | |
|--|--|
| Страниц | 164 |
| API routes | 502 |
| UI компонентов | 185 |
| SQL миграций | 175 |
| Мест (places) | 778 |
| Маршрутов | 294 |
| Туров | 20 |
| Строк кода | 220k+ |

---

## Структура данных

Три сущности — три таблицы:

```
places (778)           — географический факт: вулкан, озеро, источник
kamchatka_routes (294) — маршрут между точками, трек, сложность
operator_tours (20)    — коммерческий продукт: цена, слоты, бронь
```

Безопасность каждого места — `location_safety_profile` + `location_real_time_status`. Связь маршрут→точки — `route_waypoints`.

---

## AI-агенты

| Агент | Расписание | Задача |
|-------|-----------|--------|
| **Kuzmich** | realtime | Telegram / Web / Widget — мультиканальный ассистент, TAAFT-инструменты |
| **Watchdog** | каждые 30 мин | Зависшие бронирования, операторы без ответа, лиды >2ч |
| **Editor** | 02:00 UTC | Туры с коротким описанием → AI-рерайт |
| **Scout Digest** | 07:00 UTC | RSS (Habr, RATA, Kamgov) → AI-синтез → Telegram |
| **Growth Agent** | по запросу | Сканирует мертвый код, горячие запросы, tech debt → proposals |

Полный реестр агентов: [`AGENTS.md`](./AGENTS.md)

### TAAFT Gateway

Kuzmich умеет вызывать внешние AI-инструменты через инструмент `search_taaft`. Реализация: `lib/agents/tools/taaft-search.ts`, интеграция в `lib/kuzmich/core.ts`.

### Brain UI

Веб-интерфейс к памяти агентов: `/hub/admin/brain` — статистика по `agent_memory`, логи `ai_actions_log`, история запусков агентов.

---

## PWA

Платформа работает офлайн:

- **Офлайн-карта** — тайлы Камчатки кэшируются в SW при первом посещении
- **Web Push** — уведомления о бронированиях и штормовых предупреждениях (`lib/notifications/web-push.ts`)
- **Background Sync** — SOS и отзывы сохраняются в IndexedDB офлайн и отправляются при появлении сети
- **Install prompt** — `components/PWA/InstallPrompt.tsx`

Подписка на push: `POST /api/push/subscribe` (требует авторизации).

---

## Хабы

| Хаб | Путь | Роли |
|-----|------|------|
| Туристы | `/hub/tourist/` | tourist |
| Операторы | `/hub/operator/` | operator |
| Гиды | `/hub/guide/` | guide |
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
npx tsc --noEmit      # type check (0 ошибок, 0 any)
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
- AI — только через `callAIWaterfall()` / `callAIFast()`, никогда напрямую

---

## Деплой

Push в `main` → Timeweb видит пуш → собирает Docker → `start.js` накатывает миграции → поднимает сервер.

Приложение: **Fair Polydeuces** на Timeweb Cloud. Репо: `tourhabk-ui/pos`.

**Docker-ограничения:** standalone bundle ≤ 50 МБ, `images.unoptimized: true` (убирает sharp ~33 МБ).

---

## Дорожная карта

### Фаза 0 (текущая) — фундамент AI-экосистемы
- [x] TAAFT Gateway — `search_taaft` в Kuzmich
- [x] Brain UI — `/hub/admin/brain`
- [x] Web Push — подписки, SW handler, `sendPushToUser()`
- [x] Background Sync — SOS офлайн + `sos-sync`
- [ ] Kuzmich PoS SDK — `getTouristContext()`, `getRecommendations()`

### Фаза 1 — AI-терминал
- [ ] PoS как AI-советник: история покупок + маршрут + погода в контексте кассира
- [ ] Kuzmich «навык покупки»: заказ экипировки через чат
- [ ] Фоновый агент PoS-Merch: ночной анализ продаж → рекомендации

### Фаза 2 — Саморазвивающаяся экосистема
- [ ] Agent Evolver: ежесуточный анализ метрик → proposals → A/B тесты в рантайме
- [ ] TAAFT Marketplace для PoS: каталог AI-расширений, подключение в 1 клик
- [ ] Brain UI 2.0: «пульс экосистемы», утверждение auto-proposals

### Фаза 3 — Сеть и монетизация
- [ ] Сеть PoS: анонимизированные паттерны продаж → глобальная модель спроса
- [ ] No-Code Agent Builder: конструктор агентов для операторов
- [ ] Модель дохода: подписка на AI-инструменты, комиссия с AI-транзакций

---

*Камчатка. Вулканы. Медведи. Код.*
