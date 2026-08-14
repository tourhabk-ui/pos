/**
 * Слепок схемы прод-БД (задача #57 — бэкап-фактор).
 *
 * Master-таблицы существуют только на проде: ни одна миграция их не создаёт,
 * и потеря БД означала бы невозможность восстановить схему из кода.
 * /api/cron/schema-snapshot отдаёт DDL живой схемы — из него собирается
 * baseline в репозитории.
 *
 * Сторож держит границы эндпоинта:
 *  1. ТОЛЬКО схема: запросы ходят исключительно в pg_catalog — ни одной
 *     пользовательской таблицы, ни одной строки данных (152-ФЗ).
 *  2. Только чтение: никакой модифицирующей SQL.
 *  3. Только с CRON_SECRET.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/cron/schema-snapshot/route.ts'),
  'utf-8',
);

describe('schema-snapshot: границы', () => {
  it('доступ только по CRON_SECRET (таймбезопасно)', () => {
    expect(SRC).toMatch(/getCronSecret\(req\)/);
    expect(SRC).toMatch(/timingSafeCompare\(secret \?\? '', process\.env\.CRON_SECRET/);
    expect(SRC).toMatch(/status: 401/);
  });

  it('каждый FROM — системный каталог, пользовательских таблиц нет', () => {
    const froms = [...SRC.matchAll(/FROM\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
    expect(froms.length).toBeGreaterThan(10);
    for (const f of froms) {
      expect(f.startsWith('pg_'), `FROM ${f} — не pg_catalog`).toBe(true);
    }
  });

  it('только чтение: модифицирующей SQL в файле нет', () => {
    expect(SRC).not.toMatch(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|DROP\s|TRUNCATE/);
  });

  it('данные не отдаются: ни string_agg по значениям, ни SELECT * из таблиц', () => {
    // Все SELECT-ы собирают DDL из метаданных; сырых SELECT * нет вовсе.
    expect(SRC).not.toMatch(/SELECT \*/);
  });

  it('индексы на выходе идемпотентны', () => {
    expect(SRC).toMatch(/CREATE \$1INDEX IF NOT EXISTS/);
  });
});
