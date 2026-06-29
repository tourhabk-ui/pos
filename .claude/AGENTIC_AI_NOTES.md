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
| **RAG: multi-query/query rewriting** (§16.5) | `query-expansion.ts` в `searchRoutes` (env `RAG_MULTIQUERY`) | ✅ перефразы → объединение с дедупом; по умолчанию ВЫКЛ, fail-open |
| **RAG: agentic/iterative** (retrieve→оценка достаточности→re-retrieve) | один фиксированный fan-out 9 источников | ⚠️ нет цикла достаточности; FTS дёшев, не срочно |
| **RAG: grounding/цитирование** (§16.8.4) | `searchLegislation` даёт `Источник:`; importer не переписывает оригинал | ✅ частично; нет faithfulness-проверки в генерации |
| **Память: working** (история диалога) | `getHistory` + `trimHistoryToBudget` | ✅ token-aware |
| **Память: episodic** (поиск похожих прошлых эпизодов) | `agent_memory` (по key/recency/FTS) | ⚠️ нет retrieve-by-similarity, нет recall провалов |
| **Память: semantic** (факты/граф) | `agent_knowledge` + `agent_knowledge_links` (рёбра почти не used) | ⚠️ граф не обходится при ретриве |
| **Память: consolidation/reflection** (эпизод→семантика, §17.4.4) | `memory-reflector.ts` + `/api/cron/memory-reflect` | ✅ синтез истекающих intel-сигналов → durable insight-страницы (анти-галлюцинация) |
| **Память: contradiction detection** (§17.4.1) | `memory-contradiction.ts` + `/api/cron/memory-contradiction` | ✅ периодический safety-сканер: прямые противоречия → флаг + алерт (не в hot write-path) |
| **Память: temporal decay в ретриве** (§17.4.2 `λ·sim+(1−λ)·decay`) | чистая recency ИЛИ чистый FTS | ⚠️ TODO |
| **Harness: prompt-cache (стат/динам префикс)** | `CACHE_BREAK_MARKER`, `cache_control:ephemeral` | ✅ хорошо (§18.8.1) |
| **Harness: token-бюджет истории** | `context-budget.ts` (token-aware, кириллица ×, §18.2.6) | ✅ оценка токенов исправлена под кириллицу |
| **Harness: pre-flight token check** (Silent Truncation Trap §18.2) | `fitTextToTokenBudget` в сборке промпта Кузьмича | ✅ динамический RAG-контекст бюджетируется (6000 ток.), важные блоки первыми |
| **Harness: компакция = суммаризация, не удаление** (Eq 18.4) | `trimHistoryToBudget` удаляет старое | ⚠️ TODO: терять исходную задачу/safety-факт плохо |
| **Harness: бюджет на динамический M-блок + tool defs** | только H бюджетируется | ⚠️ TODO: реальный рост контекста именно тут |
| **Harness: tool-output как untrusted (XML-wrap)** (§18.4.4) | `wrapToolOutput` в agent-loop Кузьмича | ✅ tool-выходы обёрнуты в untrusted-делимитеры + пометка (не команды) |
| **Patterns: ReAct + max-iter + fallback** | `aiChatAgentLoop` (cap 4) + waterfall fallback | ✅ корректно (§19.2) |
| **Patterns: параллельный tool-exec / loop-detect** | `tool-loop.ts` `runTurnTools` в `aiChatAgentLoop` | ✅ Promise.all (порядок сохранён) + дедуп `(tool,args)` между ходами |
| **Patterns: cron-агенты = workflows, не agents** (§19) | Watchdog/Editor/Scout/Evo | ✅ правильный выбор |
| **Eval: outcome/TSR через DB-оракул** (§14.6.1, §20.5.2) | `smoke-test.ts` (claimed→actual в БД) | ✅ это и есть execution-based |
| **Eval: оракул tamper-proof/aligned** (§20.2.3) | `smoke-test.ts` два порога (written≥50 / goal≥300) | ✅ под-спек ловится как `under_spec`, не «успех» (#232) |
| **Eval: A/B с Wilson CI** (§14.4.4-5) | `experiment-tracker` | ✅ исправлено: Wilson-интервалы + несмещённый pickVariant (был `getSeconds()%2`) |
| **Eval: LLM-as-judge качества** (§14.7, с миtigation bias) | `eval/editor-judge.ts` (в харнессе, `?judge=1`) | ✅ pointwise 1-5, reference-guided, CoT+антиverbosity, штраф за выдумку |
| **Eval: held-out regression set** (§14.8.3, §20.7.2) | `eval/editor-regression.ts` + `/api/cron/editor-eval` | ✅ TSR + Wilson CI по фикс-набору (dry-run, до выкатки промпта) |
| **Multi-agent: стигмергия (общая очередь Issues)** (§24.3.6) | Scout-Innovator ↔ GitHub Issues | ✅ правильно для нас (§24.11 «start simple») |
| **Multi-agent: task locking** (§24.8.2) | `isDuplicateTitle` + персистентный `proposal_lock` в agent_memory | ✅ кросс-прогонный дедуп: не предлагать заново даже после закрытия issue |
| **Multi-agent: critic/red-team gate перед PR** (§24.6.2/§24.8.5) | `scout-innovator.criticReviewProposal` перед `createGitHubIssue` | ✅ fail-open критик (`callAIFast`) отсеивает нарушающее CLAUDE.md/уже сделанное |

---

## Статус внедрения

Прикладной роадмап статьи **закрыт** — внедрено и смержено в `main` (PR #229–#244).
Сводка изменений — в README («Последние изменения»); активация латентных фич
(env + расписания) — в [`docs/ACTIVATION_CHECKLIST.md`](../docs/ACTIVATION_CHECKLIST.md).
Статус каждого концепта — в таблице выше (✅ сделано / ⚠️ TODO / ⛔ неприменимо).

## Остаётся (второстепенное, ⚠️ в таблице)

- chunking длинных доков законодательства (§16.4) — данные пока не наполнены
- episodic retrieve-by-similarity / semantic-граф traversal / temporal decay (§17.4)
- компакция = суммаризация вместо удаления; бюджет на динамический M-блок (§18)
- agentic/iterative RAG с циклом достаточности (§16)

Все заметно ниже по отдаче — берём по конкретной потребности, не ради галочки.

---

## Чего НЕ делаем (осознанно)

- Обучение/файнтюн (RLHF/PPO/DPO/GRPO/trajectory-RL) — нет своих моделей.
- Локальные векторные БД (pgvector/zvec) в standalone — ломает лимит 50 МБ.
- A2A-протокол, debate-панели, OpenEnv/Gym, CTDE — оверкилл для 4 крон-задач (§24.11).
- BLEU/ROUGE/BERTScore — нет эталонов.
