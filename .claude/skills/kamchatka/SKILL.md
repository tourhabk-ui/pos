---
name: kamchatka
version: 1.0.0
description: >
  Use for any task in the KamchatourHub / Ведар / TourHab / Volcano OS codebase
  (tourhabk-ui/pos). Covers: writing or reviewing API routes with SQL, building
  UI components, creating database migrations, running code audits, understanding
  platform architecture, checking design-system compliance, or any task that
  touches app/, lib/, components/, or migrations/.
  Activate automatically when the user references operator_tours, operator_bookings,
  places, kamchatka_routes, agent_route_knowledge, partners, or any operator_* table.
user-invocable: false
---

# KamchatourHub — платформенный контекст

Премиальная туристическая платформа Камчатки. Next.js 15 App Router + PostgreSQL прямой SQL + JWT auth.

## Обязательный старт сессии

```bash
node .claude/skills/kamchatka/scripts/context.mjs   # актуальный размер проекта
```

## Sub-команды

| Задача | Файл |
|--------|------|
| SQL-запрос к БД — проверить схему сначала | `reference/db-preflight.md` |
| Создать UI-компонент | `reference/ui-component.md` |
| Провести аудит кода | `reference/audit.md` |
| Создать SQL-миграцию | `reference/migration.md` |

## Ключевые запреты (полный список в CLAUDE.md)

- `import pool from` → `import { pool } from '@/lib/db-pool'`
- `FROM bookings` → `FROM operator_bookings` (колонка `booking_status`, не `status`)
- `FROM tours` → `FROM operator_tours`
- `SELECT *` → явные колонки
- `any` → `unknown` + type guards
- `console.log` → только `console.error` в catch
- Хардкод hex → `var(--accent)` и т.д.
- Прямые вызовы AI → только через `callAIWaterfall()` / `callAIFast()`

## Быстрый аудит нарушений

```bash
node .claude/skills/kamchatka/scripts/audit.mjs
```
