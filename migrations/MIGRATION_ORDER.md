# Migration Order — ИСТОРИЧЕСКИЙ ДОКУМЕНТ

> **Этот файл описывает только миграции 001–080 и безнадёжно устарел**
> (на 2026-08-15 последняя миграция — `862_mcp_handoffs.sql`, файлов — 365).
> Источником правды о порядке служит сам каталог `migrations/` и таблица
> `_migrations` (name UNIQUE, applied_at): раннер `lib/database/migrate.ts`
> применяет файлы по имени и помнит применённые.
>
> **Следующий номер — смотреть по `ls migrations/ | sort`, а не здесь.**
> Номера уже дублировались (два `847_`, пары `060_`, `064_`, `065_`) — перед
> созданием новой миграции проверять, что номер свободен. Номера 863–866
> зарезервированы планом Field Confidence Navigator
> (`docs/FIELD_CONFIDENCE_NAVIGATOR_PLAN.md`).

Историческая часть (действительна только для диапазона 001–080):

Apply in this exact order. Duplicate numbers exist due to parallel development.

```
001 → 049  — base schema (sequential, no duplicates)
050        — agent_route_knowledge
051        — ...
052        — ...
053        — user_agreements
054-059    — ...
060_rafting_tour_kamchatka.sql    ← apply FIRST
060_user_trips_flights.sql        ← apply SECOND
061_user_trips_flight_times.sql
062_octo_reseller_reference.sql
063_agent_learning.sql
064_sales_tracking.sql            ← apply FIRST
064_zone_normalize_user_trips.sql ← apply SECOND
0645_safety_capacity_layer.sql
0646_agent_memory.sql
...
079_channel_manager.sql
080_performance_indexes.sql       ← CONCURRENTLY, no transaction needed
```

## Rules going forward
- Never reuse a number — проверять `ls migrations/` перед созданием
- CONCURRENTLY indexes cannot run inside a transaction — раннер применяет такие файлы statement-by-statement вне транзакции
- Все миграции идемпотентны (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`)
