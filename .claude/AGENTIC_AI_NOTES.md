# Agentic AI — рабочие заметки (карта «концепт → наш код»)

> Источник: «The Hitchhiker's Guide to Agentic AI: From Foundations to Systems»,
> H. Roitman, arXiv:2606.24937 (603 стр., июнь 2026). Изучен ПЕРВОИСТОЧНИК постранично
> (главы 14, 16, 17, 18, 19, 20, 24), не пересказ. Берём только применимое к платформе.
> Это карта: где у нас уже есть концепт, что неверно, что улучшить.

---

## Принцип

Мы НЕ обучаем модели (внешние провайдеры через `callAIWaterfall`/`callAIFast`),
поэтому слои RLHF/PPO/GRPO/MoE/trajectory-RL — мимо. Берём прикладные главы:
RAG, память, harness/контекст, оценка, мульти-агентность.
ЖЁСТКОЕ ограничение: standalone ≤ 50 МБ → НЕТ локальной векторной БД (pgvector/zvec).
Эмбеддинги — только через внешний API на запись, и то опционально. Postgres FTS — основной.

---

## Карта: концепт → наш код → статус

| Концепт (книга) | Наш код | Статус |
|---|---|---|
| **RAG: sparse (BM25/FTS)** — рекомендованный базовый слой | Postgres `to_tsvector('russian')` + ILIKE везде | ✅ правильно |
| **RAG: слияние источников через RRF** (§16.3.3, ранги несравнимы) | `searchPlaceKnowledge` | ✅ исправлено (был `ORDER BY rank` по UNION — анти-паттерн) → RRF 1/(60+pos) |
| **RAG: dense/эмбеддинги** | — | ⛔ нельзя локально (50 МБ); только внешний API |
| **RAG: chunking длинных доков** (§16.4) | `legislation_docs.full_text` — один блок 20K | ⚠️ TODO: бьёт precision на длинных законах |
| **RAG: multi-query/query rewriting** (§16.5) | сырой текст → FTS | ⚠️ TODO: дешёвый `callAIFast`-парафраз закрыл бы vocab-gap без векторов |
| **RAG: agentic/iterative** (retrieve→оценка достаточности→re-retrieve) | один фиксированный fan-out 9 источников | ⚠️ нет цикла достаточности; FTS дёшев, не срочно |
| **RAG: grounding/цитирование** (§16.8.4) | `searchLegislation` даёт `Источник:`; importer не переписывает оригинал | ✅ частично; нет faithfulness-проверки в генерации |
| **Память: working** (история диалога) | `getHistory` + `trimHistoryToBudget` | ✅ token-aware |
| **Память: episodic** (поиск похожих прошлых эпизодов) | `agent_memory` (по key/recency/FTS) | ⚠️ нет retrieve-by-similarity, нет recall провалов |
| **Память: semantic** (факты/граф) | `agent_knowledge` + `agent_knowledge_links` (рёбра почти не used) | ⚠️ граф не обходится при ретриве |
| **Память: consolidation/reflection** (эпизод→семантика, §17.4.4) | — | ⚠️ TODO: нет рефлектора (Editor ≠ консолидация) |
| **Память: contradiction detection при записи** (§17.4.1) | пишем безусловно | ⚠️ TODO safety: «тропа открыта» не флагается против свежей «закрыта» |
| **Память: temporal decay в ретриве** (§17.4.2 `λ·sim+(1−λ)·decay`) | чистая recency ИЛИ чистый FTS | ⚠️ TODO |
| **Harness: prompt-cache (стат/динам префикс)** | `CACHE_BREAK_MARKER`, `cache_control:ephemeral` | ✅ хорошо (§18.8.1) |
| **Harness: token-бюджет истории** | `context-budget.ts` (token-aware, кириллица ×, §18.2.6) | ✅ оценка токенов исправлена под кириллицу |
| **Harness: pre-flight token check** (Silent Truncation Trap §18.2) | — | ⚠️ TODO: не считаем итоговый промпт перед отправкой |
| **Harness: компакция = суммаризация, не удаление** (Eq 18.4) | `trimHistoryToBudget` удаляет старое | ⚠️ TODO: терять исходную задачу/safety-факт плохо |
| **Harness: бюджет на динамический M-блок + tool defs** | только H бюджетируется | ⚠️ TODO: реальный рост контекста именно тут |
| **Harness: tool-output как untrusted (XML-wrap)** (§18.4.4) | web/RSS идут в контекст напрямую | ⚠️ TODO: prompt-injection поверхность |
| **Patterns: ReAct + max-iter + fallback** | `aiChatAgentLoop` (cap 4) + waterfall fallback | ✅ корректно (§19.2) |
| **Patterns: параллельный tool-exec / loop-detect** | tools выполняются последовательно; только iter-cap | ⚠️ TODO: `Promise.all` + дедуп `(tool,args)` |
| **Patterns: cron-агенты = workflows, не agents** (§19) | Watchdog/Editor/Scout/Evo | ✅ правильный выбор |
| **Eval: outcome/TSR через DB-оракул** (§14.6.1, §20.5.2) | `smoke-test.ts` (claimed→actual в БД) | ✅ это и есть execution-based |
| **Eval: оракул tamper-proof/aligned** (§20.2.3) | `LENGTH>=100` геймится | ⚠️ TODO: проверять «изменилось», не «существует»; ≥300 по CLAUDE.md |
| **Eval: A/B с Wilson CI** (§14.4.4-5) | `experiment-tracker` | ✅ исправлено: Wilson-интервалы + несмещённый pickVariant (был `getSeconds()%2`) |
| **Eval: LLM-as-judge качества** (§14.7, с миtigation bias) | — | ⚠️ TODO: judge переписей Editor (присутствие ≠ качество) |
| **Eval: held-out regression set** (§14.8.3, §20.7.2) | — | ⚠️ TODO: фикс-набор ID для воспроизводимого TSR |
| **Multi-agent: стигмергия (общая очередь Issues)** (§24.3.6) | Scout-Innovator ↔ GitHub Issues | ✅ правильно для нас (§24.11 «start simple») |
| **Multi-agent: task locking** (§24.8.2) | дедуп по Jaccard заголовка | ⚠️ TODO: лок по триггеру, не только по тексту |
| **Multi-agent: critic/red-team gate перед PR** (§24.6.2/§24.8.5) | proposal→Issue→@claude→PR без критика | ⚠️ TODO: дешёвый `callAIFast` критик до Issue |

---

## Сделано в этом проходе (PR по статье)

1. **RRF в `searchPlaceKnowledge`** — слияние источников по позиции, не по несравнимым ts_rank.
2. **Кириллица-aware `estimateTokens`** (`context-budget.ts`) — раньше /3 недосчитывал русский.
3. **`experiment-tracker`**: Wilson CI (победитель только при непересечении 95% ДИ) + несмещённый `pickVariant` (убран time-correlated `getSeconds()%2`).
4. Тесты: `experiment-tracker.test.ts` (10), расширен `context-budget.test.ts`.

---

## TODO (по value÷effort, из постраничного чтения)

**Quick wins:**
- pre-flight token-check + обрезка динамического блока первым (Silent Truncation Trap)
- summarize-on-evict в `trimHistoryToBudget` (через `callAIFast`, best-effort)
- параллельный tool-exec + loop-dedup в `aiChatAgentLoop`
- tamper-proof оракул Editor в `smoke-test.ts` (проверять изменение, не длину)
- multi-query парафраз для коротких запросов (без векторов)

**Larger:**
- рефлектор-крон: эпизоды `agent_memory` → семантические `[INSIGHT]` в `agent_knowledge` + рёбра links; importance-LRU забывание
- contradiction-флаг при записи памяти (safety-critical)
- held-out regression-харнесс для Editor + LLM-judge качества (bias-mitigated)
- critic-gate перед созданием Issue у Scout-Innovator

---

## Чего НЕ делаем (осознанно)

- Обучение/файнтюн (RLHF/PPO/DPO/GRPO/trajectory-RL) — нет своих моделей.
- Локальные векторные БД (pgvector/zvec) в standalone — ломает лимит 50 МБ.
- A2A-протокол, debate-панели, OpenEnv/Gym, CTDE — оверкилл для 4 крон-задач (§24.11).
- BLEU/ROUGE/BERTScore — нет эталонов.
