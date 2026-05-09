# TourHab

**Туристическая платформа Камчатки. Работает без связи.**

[tourhab.ru](https://tourhab.ru) · Next.js 15 · PWA · PostgreSQL

---

## Что это

Инструмент туриста для дикой природы Камчатки. Офлайн-карта, AI-ассистент Кузьмич, план маршрута с кешем, SOS с координатами — всё работает без интернета после первой загрузки.

---

## Возможности

**Для туристов**
- Офлайн-карта — тайлы кешируются при посещении `/map`, работают без сети
- 779 мест: вулканы, озёра, гейзеры, термальные источники — карточки с безопасностью и фото
- 294 маршрута — сложность, снаряжение, МЧС-регистрация, GPS-треки
- Офлайн-рюкзак — AI строит план день-за-днём, сохраняется в IndexedDB
- SOS — номера 112 и МЧС Камчатки, SMS с координатами, работает через сотовую сеть
- Кузьмич — AI-ассистент с геоконтекстом, знает текущие координаты и ближайшие точки

**Для операторов**
- Личный кабинет: туры, бронирования, гиды, аналитика, финансы
- AI Lead Processor — квалификация лидов, PDF-предложения, Telegram-уведомления
- Telegram-бот для приёма бронирований

---

## Стек

| Слой | Технология |
|---|---|
| Frontend | Next.js 15 App Router, TypeScript strict, Tailwind CSS |
| Database | PostgreSQL — raw SQL, без ORM (`lib/database.ts`) |
| Auth | JWT, middleware `lib/auth/middleware.ts` |
| AI | Waterfall: OpenRouter → DeepSeek → Gemini → MiniMax → Anthropic |
| Offline | Service Worker (kamchatour-v8) + IndexedDB v2 (`lib/offline/`) |
| Deploy | Timeweb Cloud → tourhab.ru, автодеплой при push в main |

---

## Масштаб (май 2026)

| | |
|---|---|
| Страниц | 94 |
| API routes | 256 |
| Компонентов | 119 |
| Миграций | 663 |
| Мест (places) | 779 |
| Маршрутов (kamchatka_routes) | 294 |
| Туров (operator_tours) | 20 |
| Аттестованных гидов | 112 |

---

## Структура

```
app/
  map/                   офлайн-карта (Leaflet, GPS, тайлы)
  places/[id]/           карточка места (безопасность, маршруты, отзывы)
  routes/[id]/           карточка маршрута (трек, снаряжение, МЧС)
  trips/plan/            конструктор офлайн-рюкзака
  trips/[id]/            viewer плана (GPS, SOS, AI-чат)
  kuzmich/               AI-ассистент (веб + Telegram)
  sos/                   экстренные контакты
  safety/offline/        инструкция выживания (статическая, всегда доступна)
  hub/operator/          дашборд оператора (17 страниц)
  hub/admin/             панель администратора
  api/                   256 endpoints

lib/
  kuzmich/core.ts        agent loop, tools, память
  ai/providers.ts        waterfall провайдеров
  offline/db.ts          IndexedDB v2: регионы, маршруты, SOS, trip plans
  offline/useTripPack.ts хук загрузки офлайн-рюкзака
  agents/                Watchdog, Editor, Scout Digest
  services/              лиды, комиссии, PDF, Telegram

public/
  sw.js                  Service Worker v8
```

---

## Офлайн-архитектура

Service Worker кеширует всё необходимое до выхода в горы:

| Что | Как | Лимит |
|---|---|---|
| Тайлы карты | Cache API, zoom 7–10 при установке | ~25 MB |
| Карточки мест | Network-first + LRU | 30 страниц |
| Страницы туров | Cache-first + LRU | 20 страниц |
| Офлайн-рюкзаки `/trips/[id]` | Network-first + LRU | 20 планов |
| `/sos`, `/safety/offline` | Precache (всегда) | — |
| Данные рюкзака | IndexedDB v2 | неограничено |

GPS кешируется непрерывно в `localStorage` через `hooks/useOfflineGPS.ts`.

---

## AI-агенты

| Агент | Расписание | Задача |
|---|---|---|
| Watchdog | каждые 30 мин | бронирования без ответа >24ч, операторы >48ч |
| Editor | 02:00 UTC | AI-обогащение описаний маршрутов <300 символов |
| Scout Digest | 07:00 UTC | RSS → AI-синтез → дайджест в Telegram |
| Kuzmich | мультиканальный | Telegram, MAX, Web, Widget |

---

## Разработка

```bash
git clone <repo>
cd pos
npm install
cp .env.example .env.local   # заполни DATABASE_URL, JWT_SECRET, API ключи
npm run dev
```

```bash
npm run dev            # dev server
npm run build          # production build
npm run migrate        # применить SQL миграции
npx tsc --noEmit       # проверка типов
npx vitest run         # тесты
```

Миграции: `migrations/NNN_name.sql`, трекинг через таблицу `_migrations`.  
Следующая: `664_`.

---

## Дизайн

Тёплая, земная эстетика Камчатки. Playfair Display + Outfit. CSS custom properties, dark mode, без glassmorphism.  
Акцент: `var(--accent)` — вулканический оранжевый `#D44A0C`.  
Полная система в `CLAUDE.md`.

---

*Построено для Камчатки — где вулканы, медведи и 0% сигнала.*
