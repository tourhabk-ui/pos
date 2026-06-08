# KamchatourHub

Туристическая платформа Камчатки — от бронирования тура до безопасности в маршруте.

**[tourhab.ru](https://tourhab.ru)** · Next.js 15 · PostgreSQL · TypeScript strict

---

## Что это

Полноценная B2C/B2B платформа: туристы ищут маршруты и бронируют туры, операторы управляют предложениями, гиды ведут группы. В основе — безопасность: каждое место имеет профиль опасности, реалтайм-статус и привязку к МЧС.

---

## Стек

| Слой | Технология |
|------|-----------|
| Frontend | Next.js 15 App Router, TypeScript strict, Tailwind CSS |
| База данных | PostgreSQL — прямой SQL, без ORM |
| Аутентификация | JWT, role-based middleware |
| AI | Waterfall: DeepSeek → Gemini → MiniMax → Anthropic |
| Деплой | Timeweb Cloud — автодеплой при пуше в `main` |
| Боты | Telegram (Kuzmich + операторы) |

---

## Масштаб

| | |
|--|--|
| Страниц | 94 |
| API routes | 256+ |
| UI компонентов | 119 |
| SQL миграций | 128 |
| Мест (places) | 778 |
| Маршрутов | 294 |
| Туров | 20 |
| Строк кода | 195k+ |

---

## Структура данных

Три сущности — три таблицы:

```
places (778)          — географический факт: вулкан, озеро, источник
kamchatka_routes (294) — маршрут между точками, трек, сложность
operator_tours (20)    — коммерческий продукт: цена, слоты, бронь
```

Безопасность каждого места — `location_safety_profile` + `location_real_time_status`. Связь маршрут→точки — `route_waypoints`.

---

## AI-агенты

| Агент | Расписание | Задача |
|-------|-----------|--------|
| **Kuzmich** | realtime | Telegram / Web / Widget — мультиканальный ассистент |
| **Watchdog** | каждые 30 мин | Зависшие бронирования, операторы без ответа, лиды >2ч |
| **Editor** | 02:00 UTC | Туры с коротким описанием → AI-рерайт |
| **Scout Digest** | 07:00 UTC | RSS (Habr, RATA, Kamgov) → AI-синтез → Telegram |

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

---

## Деплой

Push в `main` → GitHub Actions `sync-to-tourhabk.yml` → `tourhabk-ui/pos` → Timeweb собирает Docker → `start.js` накатывает миграции → сервер.

Приложение: **Fair Polydeuces** на Timeweb Cloud.

---

*Камчатка. Вулканы. Медведи. Код.*
