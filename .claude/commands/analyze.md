---
name: analyze
description: "Анализ данных платформы: бронирования, маршруты, операторы, Кузьмич. Использует postgres MCP для прямых запросов."
---

# /analyze — Аналитика данных TourHab

Анализирует данные платформы через postgres MCP. Принимает вопрос на естественном языке или тему.

## Использование

```
/analyze bookings          — статистика бронирований
/analyze tours             — топ-туры, конверсия
/analyze operators         — активность операторов
/analyze kuzmich           — метрики Кузьмича (feedback, оценки)
/analyze places            — популярные места, coverage
/analyze routes            — маршруты без данных, coverage
/analyze <свободный вопрос>  — любой аналитический вопрос
```

---

## Алгоритм

### Шаг 1 — Понять вопрос

Определи что нужно проанализировать исходя из ARGUMENTS:
- `bookings` → `operator_bookings` (booking_status, суммы, операторы)
- `tours` → `operator_tours` (views, бронирования, рейтинги)
- `operators` / `partners` → `partners` WHERE role='operator'
- `guides` → `partners` WHERE role='guide'
- `kuzmich` → `ai_actions_log` + `agent_knowledge`
- `places` → `places` (coverage, фото, описания)
- `routes` → `v_kamchatka_routes_api` (coverage, данные)
- Свободный вопрос → определи таблицы самостоятельно

### Шаг 2 — Сформулировать SQL запросы

**Правила запросов:**
- Маршруты: `FROM v_kamchatka_routes_api` (не kamchatka_routes напрямую)
- Бронирования: `FROM operator_bookings` (колонка `booking_status`)
- Туры: `FROM operator_tours`
- Операторы: `FROM partners WHERE role = 'operator'`
- Фидбек Кузьмича: `FROM ai_actions_log WHERE action_type = 'agent_feedback'`
- Оценки: `FROM agent_knowledge WHERE type = 'outcome'`

Выполни 1-5 SQL запросов через postgres MCP для сбора данных.

### Шаг 3 — Интерпретировать результаты

После получения данных:
1. Выдели ключевые метрики (числа, тренды)
2. Найди аномалии или проблемы
3. Сформулируй 2-3 actionable вывода

### Шаг 4 — Отформатировать ответ

Формат ответа:
```
## 📊 Анализ: [тема]
_[период или фильтр]_

### Ключевые метрики
| Метрика | Значение | Тренд |
|---------|----------|-------|
| ...     | ...      | ...   |

### Выводы
1. **[Инсайт 1]** — ...
2. **[Инсайт 2]** — ...

### Рекомендации
- ...
```

---

## Типовые запросы

### Бронирования
```sql
SELECT
  booking_status,
  COUNT(*) AS cnt,
  SUM(total_price) AS revenue
FROM operator_bookings
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY booking_status
ORDER BY cnt DESC;
```

### Топ маршруты
```sql
SELECT title, view_count, difficulty, activity_type
FROM v_kamchatka_routes_api
ORDER BY view_count DESC NULLS LAST
LIMIT 10;
```

### Метрики Кузьмича
```sql
SELECT
  metadata->>'rating' AS rating,
  metadata->>'intent'  AS intent,
  COUNT(*) AS cnt
FROM ai_actions_log
WHERE action_type = 'agent_feedback'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY 1, 2
ORDER BY cnt DESC;
```

### Покрытие данных
```sql
SELECT
  location_type,
  COUNT(*) AS total,
  COUNT(description) FILTER (WHERE LENGTH(description) > 300) AS with_desc,
  COUNT(kuzmich_review) AS with_kuzmich
FROM places
GROUP BY location_type
ORDER BY total DESC;
```
