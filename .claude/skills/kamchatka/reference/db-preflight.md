# DB Preflight — проверка схемы перед SQL

Перед написанием любого кода с SQL-запросами **обязательно** выполни эти запросы через `mcp__postgres__query`.

## 1. Список operator_* таблиц

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'operator_%'
ORDER BY table_name;
```

## 2. Схема целевой таблицы

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '{TABLE_NAME}'
ORDER BY ordinal_position;
```

## 3. Foreign keys (если JOIN)

```sql
SELECT tc.constraint_name, kcu.column_name,
       ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '{TABLE_NAME}';
```

## Что делать с результатами

1. Записать реальные имена колонок и типы
2. Сверить с тем что планируешь написать
3. Исправить расхождения ДО написания кода

## Исторические ловушки

| Думаешь | На самом деле |
|---------|--------------|
| `status` | `booking_status` (operator_bookings) |
| `total_price` | `final_price` (operator_bookings) |
| `group_size` | `participants` (operator_bookings) |
| `tour_id` | `operator_tour_id` (operator_bookings) |
| `name` (tours) | `title` (operator_tours) |
| `price` (tours) | `base_price` (operator_tours) |
| `photos` — JSONB | `photos` — TEXT[] |
| `included` — TEXT | `included` — JSONB |

## Запрещено

- Писать SQL без проверки схемы
- Угадывать имена колонок по памяти
- `SELECT *` — только явные колонки
- `FROM bookings` → `FROM operator_bookings`
- `FROM tours` → `FROM operator_tours`
