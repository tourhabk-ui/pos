Создай новую SQL-миграцию по стандарту проекта.

## Аргументы

`$ARGUMENTS` — описание того что мигрируем (например: "добавить таблицу operator_finance_settings")

## Шаг 1 — Получи следующий номер

Номер — следующий за самым большим, и берётся он командой, не по памяти
(CLAUDE.md §7). Сортировка числовая: с 20.09 номера четырёхзначные, и
`ls | tail -1` показал бы 999-ю как последнюю.

```bash
git fetch -q origin main
git ls-tree --name-only origin/main migrations/ | sed 's|.*/||' | sort -t_ -k1,1n | tail -1
ls migrations/*.sql | sed 's|.*/||' | sort -t_ -k1,1n | tail -1
```

Первая строка — последний номер в `main`, вторая — в твоей копии. Бери
больший плюс один. Тот же номер по твоей копии даёт инструмент
`next_migration_id` сервера `tourhab-dev` (`lib/mcp/dev-tools/server.ts`),
если он подключён к сессии; `main` он не видит. Перед PR проверь ещё раз: параллельные сессии занимают те
же номера (скилл `pr-drive`).

## Шаг 2 — Проверь что уже есть в БД

Прода из сессии не видно, поэтому сверяйся с тем, из чего схема собирается:

- `grep -rn "{TARGET_TABLE}" migrations/ | head` — есть ли уже таблица,
  колонка или индекс, который ты собираешься создать;
- `docs/DB_SCHEMA.md` — снимок схемы с настоящего PostgreSQL;
- запрос к проду на чтение через `mcp__postgres__query`, если он подключён
  (`infra/mcp-postgres/README.md`), или на локальном PostgreSQL (скилл
  `pg-verify`):

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = '{TARGET_TABLE}';
```

Если уже существует — скажи об этом и остановись.

## Шаг 3 — Создай файл миграции

Имя файла: `migrations/{NNN}_{snake_case_description}.sql`
Где `{NNN}` — номер из шага 1 без ведущих нулей (например `1437_operator_finance_settings.sql`)

### Структура файла (обязательная):

```sql
-- Migration {NNN}: {краткое описание на русском}
-- Created: {дата YYYY-MM-DD}

BEGIN;

-- ============================================================
-- {Основное содержимое миграции}
-- ============================================================

{SQL здесь}

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS {table_name};  -- или ALTER TABLE ... DROP COLUMN ...
-- COMMIT;
```

### Правила SQL:

- **CREATE TABLE** — всегда `IF NOT EXISTS`
- **ALTER TABLE ADD COLUMN** — всегда `IF NOT EXISTS` (PostgreSQL 9.6+)
- **Индексы** — `CREATE INDEX IF NOT EXISTS`
- **Constraints** — проверяй через `information_schema.table_constraints` перед добавлением
- **Foreign keys** — оператор, гид и другой партнёр живут в `partners`:
  `operator_id UUID REFERENCES partners(id)`. Таблицы `operators` в миграциях
  нет — ссылаться на неё нельзя (CLAUDE.md §4, сторож `schema-coverage`)
- **Timestamps** — `created_at TIMESTAMPTZ DEFAULT NOW()`, `updated_at TIMESTAMPTZ DEFAULT NOW()`
- **UUID** — `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
- **JSONB** — для гибких данных, не TEXT
- Никаких `DROP TABLE` без `IF EXISTS`
- Никаких `TRUNCATE` в миграциях

### Пример хорошей миграции:

```sql
-- Migration 1437: таблица настроек финансов оператора
-- Created: 2026-11-13

BEGIN;

CREATE TABLE IF NOT EXISTS operator_finance_settings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  payout_method TEXT NOT NULL DEFAULT 'bank_transfer'
                  CHECK (payout_method IN ('bank_transfer', 'card', 'sbp')),
  bank_details  JSONB,
  auto_payout   BOOLEAN NOT NULL DEFAULT false,
  payout_day    INTEGER CHECK (payout_day BETWEEN 1 AND 28),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operator_finance_settings_operator
  ON operator_finance_settings(operator_id);

COMMIT;

-- Rollback:
-- BEGIN;
-- DROP TABLE IF EXISTS operator_finance_settings;
-- COMMIT;
```

## Шаг 4 — Проверка

После создания файла:
1. Прочитай его снова и убедись что нет ошибок синтаксиса
2. Скажи: `Миграция готова: migrations/{NNN}_{name}.sql`
3. На проде миграция применится сама при выкате (`start.js`). Локально —
   `DATABASE_URL=<local> npm run migrate`: он пишет учёт в `_migrations`.
   Через `psql` файл не применяй: учёт не запишется, и раннер применит его
   второй раз
4. Проверь миграцию на настоящем PostgreSQL до PR (скилл `pg-verify`)
