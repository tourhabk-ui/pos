---
name: triage
description: "Customer support триаж: анализ обращений к Кузьмичу, фидбек, проблемы. Помогает понять что беспокоит туристов."
---

# /triage — Триаж обращений Customer Support

Анализирует обращения к Кузьмичу и фидбек туристов через postgres MCP. Помогает понять боли и приоритеты поддержки.

## Использование

```
/triage                   — общий триаж за последние 7 дней
/triage 30d               — за 30 дней
/triage bad               — только негативный фидбек
/triage kuzmich           — качество ответов Кузьмича
/triage <тема>            — фидбек по конкретной теме
```

---

## Алгоритм

### Шаг 1 — Собрать данные

Выполни запросы через postgres MCP:

**Фидбек туристов:**
```sql
SELECT
  metadata->>'rating'  AS rating,
  metadata->>'intent'  AS intent,
  metadata->>'comment' AS comment,
  created_at
FROM ai_actions_log
WHERE action_type = 'agent_feedback'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 50;
```

**Оценки ответов Кузьмича:**
```sql
SELECT
  slug,
  content->>'grade'             AS grade,
  content->>'summary'           AS summary,
  content->>'accuracy_score'    AS accuracy,
  content->>'safety_score'      AS safety,
  content->>'helpfulness_score' AS helpfulness,
  content->>'verdict'           AS verdict,
  created_at
FROM agent_knowledge
WHERE type = 'outcome'
  AND slug LIKE 'outcome_kuzmich_%'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 20;
```

**Агрегация по категориям:**
```sql
SELECT
  metadata->>'rating' AS rating,
  metadata->>'intent' AS intent,
  COUNT(*) AS cnt
FROM ai_actions_log
WHERE action_type = 'agent_feedback'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY cnt DESC;
```

### Шаг 2 — Классифицировать

Разбей обращения по категориям:
- 🔴 **Критично** — safety, SOS, экстренная ситуация
- 🟡 **Проблема** — неверная информация, Кузьмич не понял
- 🟢 **Запрос** — уточнение, не нашёл информацию
- ⭐ **Позитив** — похвала, хорошие отзывы

### Шаг 3 — Отформатировать

```
## 🎯 Триаж за [период]

### Общая картина
- Всего обращений: N
- Негативных: N (X%)
- Позитивных: N (X%)

### 🔴 Требуют внимания
1. [проблема] — N случаев
   Примеры: "..."

### 🟡 Частые боли
1. [тема] — N упоминаний
2. ...

### Средние оценки Кузьмича
| Метрика | Оценка |
|---------|--------|
| Точность | X/10 |
| Безопасность | X/10 |
| Полезность | X/10 |

### Рекомендации
1. ...
```

---

## Каналы поддержки

| Канал | Где хранится |
|-------|-------------|
| Kuzmich Web | `ai_actions_log` action_type='agent_feedback' |
| Kuzmich Telegram | `ai_actions_log` action_type='agent_feedback' |
| Оценки ответов | `agent_knowledge` type='outcome' grade=needs_review/good/acceptable |
| Бронирования | `operator_bookings` booking_status |
