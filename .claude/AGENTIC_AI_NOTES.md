# Agentic AI — рабочие заметки (карта «концепт → наш код»)

> Источник: «The Hitchhiker's Guide to Agentic AI: From Foundations to Systems»,
> H. Roitman, arXiv:2606.24937 (июнь 2026). Берём только применимое к нашей платформе.
> Это не пересказ книги, а карта: где у нас уже есть концепт и что улучшить.
> Полный PDF недоступен из CI/dev (сетевая политика блокирует arxiv) — изучено по абстракту/обзорам.

---

## Принцип

Книга — про весь стек агентов (LLM-субстрат → RL/выравнивание → агенты → координация → прод).
Мы НЕ обучаем модели (используем внешних провайдеров через `callAIWaterfall`/`callAIFast`),
поэтому слои RLHF/PPO/GRPO/MoE/trajectory-RL — мимо. Берём только прикладные главы:
память, agentic RAG, harness/контекст, мульти-агентность, оценка.

---

## Карта: концепт → наш код → статус

| Концепт (книга) | Наш код | Статус |
|---|---|---|
| **Память: эпизодическая** (события/сигналы, извлекается через RAG) | `agent_memory`, `lib/telegram/group-monitor.ts`, `lib/telegram/industry-channels.ts` | ✅ есть |
| **Память: семантическая** (факты/знания, vector/KG) | `agent_knowledge`, `legislation_docs`, `kamchatka_routes`, `places` | ⚠️ есть, но поиск FTS/ILIKE, не вектора |
| **Agentic RAG** (агент сам решает что искать) + цитирование источника | Кузьмич `processMessage`: `searchPlaceKnowledge` + `searchRoutes` + `searchLegislation` + `aiChatAgentLoop` (tool-loop) | ✅ есть; `searchLegislation` уже со ссылкой-источником |
| **Harness / context management** (бюджет токенов, компакция истории) | `lib/kuzmich/context-budget.ts` (`trimHistoryToBudget`), `getHistory` | ✅ token-aware (добавлено) |
| **Prompt caching / статика vs динамика** | `core.ts`: `CACHE_BREAK_MARKER`, `cacheable` vs `dynamic` | ✅ есть |
| **Мульти-агентная топология** (центр./иерархия против дублей) | cron-агенты: Watchdog/Editor/Scout-Digest/Scout-Innovator/Evo | ⚠️ децентрализованы; координация через GitHub Issues-реестр |
| **Оценка агентов** («заявил N → проверь в БД», не зелёный CI) | `lib/agents/smoke-test.ts` (Editor/memory/knowledge) | ⚠️ покрыты не все агенты |
| **MCP / tools / A2A** | MCP-инструменты окружения; tool-loop Кузьмича | A2A между нашими агентами не нужен |

---

## TODO (по приоритету пользы, не срочности)

1. **Семантический поиск на эмбеддингах** — `searchLegislation`/`searchRoutes`/`searchPlaceKnowledge`
   сейчас FTS/ILIKE. Эмбеддинги дадут смысловой матч. ОГРАНИЧЕНИЕ: standalone ≤ 50 МБ (zvec не тянем) →
   только внешний эмбеддинг-эндпоинт, опционально, с graceful-fallback на FTS.
2. **Консолидация памяти эпизод→семантика** — крон, который повторяющиеся сигналы из `agent_memory`
   компилирует в `agent_knowledge` (как делает Editor для описаний). Книга: это и есть «agentic memory».
3. **Eval-харнесс для всех агентов** — расширить паттерн `smoke-test` (claimed → actual в БД) на
   Scout/Watchdog/Evo, а не только Editor.
4. **Лёгкий координатор Scout** — против дублей предложений (частично закрыто реестром Issues).

---

## Чего НЕ делаем (осознанно)

- Обучение/файнтюн моделей (RLHF, PPO, DPO, GRPO, trajectory-RL) — нет своих моделей.
- A2A-протокол между агентами — оверкилл для наших крон-задач.
- Локальные векторные БД в standalone — ломает лимит 50 МБ Timeweb.
- Инференс-оптимизация/MoE — инференс у внешних провайдеров.
