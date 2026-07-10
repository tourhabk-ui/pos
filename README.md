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
| AI | Waterfall: 14 провайдеров — OpenRouter · DeepSeek · Gemini · MiMo · GLM · NVIDIA · Groq · Cerebras · Mistral · xAI · YandexGPT · MiniMax · MuseSpark · Anthropic. Плюс Mistral OCR (паспорта маршрутов) |
| PWA | Service Worker, Web Push (VAPID), Background Sync, IndexedDB |
| Меш | WebRTC P2P (VolcanoMesh) — SOS-ретрансляция между устройствами группы |
| Деплой | Timeweb Cloud — автодеплой при пуше в `main` |
| Боты | Telegram + MAX (Kuzmich) |

---

## Масштаб

| | |
|--|--|
| Страниц | 201 |
| API routes | 584 |
| UI компонентов | 215 |
| SQL миграций | 232 |
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
| **Разведка** | Scout Digest, Scout Innovator, Intelligence, KB Gap, Industry Intel (MTProto), Legislation Sync | 07:00–08:00 UTC |
| **Память** | Memory Reflector (эпизод→семантика), Contradiction Scanner (safety) | раз в сутки |
| **Качество** | Editor Eval (regression TSR + LLM-judge) | on-demand |
| **Бизнес** | Abandoned Bookings, Payouts, Tour Reminder, Leads | почасово / 06:00 UTC |
| **Эволюция** | Evo System (Growth Agent + Evolution Loop) | каждые 6ч |
| **Боты** | Kuzmich (Telegram, MAX, Web, Widget) | realtime |

**Общая память агентов:** каждый агент на старте читает `readAgentBriefing()` — состояние платформы, историю своих запусков, last repo-scan, must-have контекст туризма на Камчатке.

Полный реестр с настройкой и шагами активации: [`docs/AGENTS_BOOK.md`](./docs/AGENTS_BOOK.md)  
Краткий реестр: [`AGENTS.md`](./AGENTS.md)  
Карта agentic-AI практик (концепт → наш код, по arXiv:2606.24937): [`.claude/AGENTIC_AI_NOTES.md`](./.claude/AGENTIC_AI_NOTES.md)

---

## Хабы

| Хаб | Путь | Роли |
|-----|------|------|
| Туристы | `/hub/tourist/` | tourist |
| Операторы | `/hub/operator/` | operator |
| Гиды | `/hub/guide/` | guide |
| Агенты | `/hub/agent/` | agent |
| Жильё | `/hub/stay/` | stay-партнёр |
| Прокат снаряжения | `/hub/gear/` | gear-партнёр |
| Безопасность | `/hub/safety` | public |
| Трансфер | `/hub/transfer/` | transfer_operator |
| Рыбалка | `/hub/fishing/` | public |
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

## Последние изменения (июль 2026)

- **KVERT ACC вулканов** — авиационные цветовые коды (green/yellow/orange/red) синкаются из KVERT VONA каждые 6 часов с прод-сервера (KVERT отдаёт 403 не-РФ IP): бейдж на карточке вулкана + safety-контекст Кузьмича (без ложного «зелёный» при отсутствии наблюдения)
- **Реальные GPS-треки из OSM** — импорт треков Overpass в `kamchatka_routes.geometry` через прод-эндпоинт (файрвол managed PG не пускает GitHub-раннеры); паттерн «маркер-файл → workflow → batched-цикл»
- **Mistral OCR паспортов маршрутов** — ~100 официальных PDF-паспортов (visitkamchatka.ru) оцифровываются в markdown (`route_passport_ocr`) — сырьё для обогащения карточек: опасности, снаряжение, этапы
- **Жильё end-to-end** — витрина `/accommodations`, бронь с выбором номера, уведомления владельцу, отмена гостем с честным возвратом по тирам (>48ч=100%, 24-48ч=50%), отзывы после проживания, модерация, фото, тарифный календарь
- **Кузьмич знает всю платформу** — инструменты search_accommodations, search_gear, search_transfers (9 инструментов в реестре)
- **Агентская реферальная программа** — атрибуция публичных броней по `?ref=`, конверсии, заработок по commission_rate, UI в кабинете агента
- **МЧС-помощник туриста** — самостоятельная регистрация группы: copy-friendly данные + deep-link на forms.mchs.gov.ru (без ложного «вы зарегистрированы»)
- **Verbalized Sampling** (arXiv:2510.01171) — разнообразие AI-текстов Editor и places-enricher без потери фактов
- **+3 бесплатных LLM-провайдера** — Groq, Cerebras, Mistral в Tier-1 гонке (инертны без ключа); env-чек в debug-waterfall
- **Аудит честности** — Zod на всех admin-POST, публичный /api/ai (починен мёртвый form-путь), хексы → DS-токены, честные ошибки админ-импортов вместо «0 страниц»
- **Алерты дорог** — Халактырский пляж: перекрытие со стороны Дальнего (реконструкция) в external_alerts + карточке пляжа

---

*Камчатка. Вулканы. Медведи. Код.*
