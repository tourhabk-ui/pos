---
name: skill-opt
description: "SkillOpt ReflACT loop — автооптимизация скиллов и промптов Кузьмича на основе реальных фейлов. Реализует алгоритм из arXiv:2605.23904 (Microsoft SkillOpt, +19.1pt на Claude Code)."
---

# SkillOpt — Автооптимизация скиллов по ReflACT

Оптимизирует `.claude/commands/{target}.md` или системный промпт Кузьмича на основе реальных данных о фейлах.

## Использование

```
/skill-opt kuzmich          — оптимизировать TOURIST_PROMPT в lib/ai/prompts.ts
/skill-opt audit            — оптимизировать .claude/commands/audit.md
/skill-opt preflight        — оптимизировать .claude/commands/preflight.md
/skill-opt <имя_скилла>     — любой файл в .claude/commands/
```

---

## ReflACT Loop (6 шагов)

### Шаг 1 — Определить цель

Если ARGUMENTS = `kuzmich`:
- Файл цели: `lib/ai/prompts.ts`
- Секция: константа `TOURIST_PROMPT` (основной промпт) или `KUZMICH_PROMPT` (Telegram)
- Читай файл и найди начало и конец секции

Если ARGUMENTS = имя скилла (например `audit`):
- Файл цели: `.claude/commands/{ARGUMENTS}.md`
- Читай файл целиком

Сохрани оригинальное содержимое для возможного отката.

---

### Шаг 2 — Rollout: сбор данных о фейлах

**Для `kuzmich`** — запроси данные через postgres MCP:

```sql
-- Фейлы из пользовательского фидбека за 7 дней
SELECT
  metadata->>'intent'  AS intent,
  metadata->>'comment' AS comment,
  created_at
FROM ai_actions_log
WHERE action_type = 'agent_feedback'
  AND metadata->>'rating' = 'bad'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 20;
```

```sql
-- Ответы с оценкой needs_review за 3 дня
SELECT
  content->>'summary'       AS summary,
  content->>'accuracy_score' AS accuracy,
  content->>'safety_score'   AS safety,
  content->>'helpfulness_score' AS helpfulness,
  content->>'verdict'        AS verdict,
  created_at
FROM agent_knowledge
WHERE type = 'outcome'
  AND slug LIKE 'outcome_kuzmich_%'
  AND content->>'grade' = 'needs_review'
  AND created_at > NOW() - INTERVAL '3 days'
ORDER BY created_at DESC
LIMIT 10;
```

Если фейлов < 3 — сообщи: "Недостаточно данных для оптимизации (менее 3 фейлов за 7 дней). Попробуй позже."

**Для Claude Code скиллов** — спроси у пользователя:
> "Опиши 2-3 случая когда скилл `{target}` не справился или дал плохой результат:"
Подожди ответа и используй его как данные о фейлах.

---

### Шаг 3 — Reflect: генерация патчей

Прочитай текущий файл цели. Затем действуй как **optimizer-модель** с таким фреймом:

```
Ты — optimizer для агентских скиллов. Твоя задача: предложить точечные правки
которые устранят конкретные паттерны фейлов, не сломав то что работает.

Правила:
- Минимальные изменения (surgical edits), не переписывать скилл целиком
- Каждая правка должна адресовать ≥1 конкретного фейла из списка
- Не добавляй общие инструкции — только конкретные, проверяемые правила
- Для промптов Кузьмича: не нарушай анти-галлюцинационные правила и safety
```

Сгенерируй список патчей в формате:

```
PATCH 1:
  OPERATION: append | insert_after | replace | delete
  TARGET: <точная цитата строки/секции куда применяется>
  CONTENT: <новый текст>
  REASON: <почему это исправит фейлы — конкретно>
  SUPPORT: <сколько фейлов из списка это закрывает>

PATCH 2:
  ...
```

---

### Шаг 4 — Aggregate + Select

Из сгенерированных патчей:
1. Объедини дублирующиеся/похожие патчи в один
2. Отсортируй по `SUPPORT` (убывание)
3. Возьми **топ-5** патчей (или меньше если генерировалось меньше)
4. Покажи итоговый список пользователю: "Предлагаю применить N патчей:" + краткий список

---

### Шаг 5 — Update: применить патчи

Для каждого патча из топ-5 применяй через Edit tool:

- `append` → добавить в конец соответствующей секции
- `insert_after` → вставить после TARGET строки
- `replace` → заменить TARGET на CONTENT
- `delete` → удалить TARGET строку/блок

После применения всех патчей сделай `git diff {файл}` и покажи итоговый diff.

---

### Шаг 6 — Gate: валидация (judge)

Теперь действуй как **judge-модель** с отдельным фреймом:

```
Ты — независимый судья качества агентских скиллов. Оцени:
1. Исходный скилл/промпт
2. Обновлённый скилл/промпт
3. Список фейлов из Rollout

Ответь строго в формате:
VERDICT: ACCEPT | REJECT
SCORE_BEFORE: X/10
SCORE_AFTER: Y/10
REASONING: <1-3 предложения>
RISKS: <что могло сломаться, если есть>
```

**Если ACCEPT** (SCORE_AFTER > SCORE_BEFORE):
- Выведи: "✅ Gate: ACCEPT (было {X}/10 → стало {Y}/10)"
- Создай коммит: `git add {файл} && git commit -m "skill-opt({target}): +{delta}pt, {N} патчей на основе {M} фейлов"`
- Запушь и создай PR как draft

**Если REJECT** (SCORE_AFTER ≤ SCORE_BEFORE):
- Откат: `git checkout -- {файл}`
- Выведи: "❌ Gate: REJECT (было {X}/10 → стало {Y}/10). Изменения отменены."
- Выведи REASONING и RISKS
- Предложи попробовать с меньшим количеством патчей или другим target

---

## Важные правила

1. **Никогда не коммить без прохождения Gate** (даже если патчи кажутся очевидными)
2. **Для kuzmich**: не убирать safety-правила, анти-галлюцинации, экстренные контакты
3. **Git workflow**: всегда создавай отдельную ветку перед применением патчей:
   ```bash
   git checkout -b skill-opt/{target}-$(date +%Y%m%d)
   ```
4. **Если нет данных фейлов** — скажи об этом, не оптимизируй вслепую
5. **Максимум 1 цикл за сессию** — не запускай ReflACT повторно на том же target без нового rollout

---

## Инфраструктура платформы (контекст)

- Feedback data: `ai_actions_log` (action_type='agent_feedback', metadata: {rating, intent, comment})
- Outcome grades: `agent_knowledge` (type='outcome', slug='outcome_kuzmich_*', content: {grade, scores})
- FeedbackLoop class: `lib/agents/learning/feedback-loop.ts`
- Outcome grader: `lib/agents/managed/kuzmich-outcomes.ts`
- Prompts: `lib/ai/prompts.ts` (TOURIST_PROMPT, KUZMICH_PROMPT, KAMCHATKA_KNOWLEDGE)
- Claude Code skills: `.claude/commands/*.md`
