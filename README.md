# Ведар — Туристическая платформа Камчатки

**Ведар** (vedarai.ru) — мобильная операционная система для туриста: офлайн-карта, безопасность маршрутов, AI-ассистент Кузьмич с ительменскими знаниями и реалтайм-алертами КБГС РАН.

> Также известна как **TourHab** / **Volcano OS**.

---

## Масштаб (июнь 2026)

| | |
|---|---|
| Страниц | 94 |
| API routes | 256 |
| UI компонентов | 119 |
| SQL миграций | 172 |
| Мест (places) | 779 |
| Маршрутов | 294 |

---

## Стек

```
Next.js 15 App Router + TypeScript strict
PostgreSQL — raw SQL, без ORM
JWT auth + role-based middleware
AI waterfall: DeepSeek → MiMo → Gemini → OpenRouter → Anthropic
Telegram Bot API (Кузьмич + операторы + MAX)
Timeweb Cloud Docker — приложение Fair Polydeuces
PWA + Service Worker + IndexedDB — offline-first
```

---

## Ключевые модули

```
lib/kuzmich/core.ts              — мозг Кузьмича
lib/kuzmich/guardian-context.ts  — safety-first контекст места
lib/offline/useOfflineRegion.ts  — скачивание регионов для офлайн
lib/offline/db.ts                — IndexedDB: маршруты, тайлы, SOS
lib/agents/tools/taaft-search.ts — каталог внешних AI-инструментов
public/sw.js                     — Service Worker (кэш, тайлы, офлайн)
migrations/                      — 172 SQL миграции, авто при деплое
```

---

## AI-агенты

| Агент | Расписание | Роль |
|---|---|---|
| **Kuzmich** | realtime | Хранитель Камчатки. Telegram, MAX, Web, Widget |
| **Watchdog** | каждые 30 мин | Зависшие бронирования, медленные операторы |
| **Editor** | 02:00 UTC | AI-enrichment описаний маршрутов |
| **Scout Digest** | 07:00 UTC | RSS → AI-синтез → Telegram |

Подробности: `AGENTS.md`

---

## Деплой

```bash
git push origin main
# → sync-to-tourhabk.yml → tourhabk-ui/pos → Timeweb автодеплой
# → start.js накатывает миграции → сервер запускается
```

**Прод-репо:** `tourhabk-ui/pos` (ветка `main`)  
**Timeweb:** приложение **Fair Polydeuces**  
**Сайт:** vedarai.ru

### Локальная разработка

```bash
git clone https://github.com/tourhabk-ui/pos.git
cd pos
npm install
cp .env.example .env.local   # заполнить переменные
npm run dev
```

```bash
npm run migrate       # применить новые миграции
npx tsc --noEmit      # type check (0 ошибок)
npx vitest run        # тесты
```

---

## Дизайн-система

Тёплая, земляная. Без glassmorphism, без cyberpunk.

- **Шрифты**: Playfair Display (заголовки) + Outfit (текст)
- **Акцент**: `#D44A0C` (вулканический оранжевый)
- **Иконки**: lucide-react
- **Правила**: `CLAUDE.md` → раздел 2

---

*Построено для Камчатки. Где вулканы встречаются с океаном.*
