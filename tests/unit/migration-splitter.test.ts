/**
 * Сплиттер SQL-выражений понимает синтаксис, а не байты.
 *
 * Прод-инцидент 09.08 (Watchdog): миграция 843 упала со «syntax error at or
 * near "условие"» — посреди СЛОВА ИЗ КОММЕНТАРИЯ. Раннер резал
 * CONCURRENTLY-файлы наивным split по точке с запятой, а в комментарии
 * миграции она была. Из четырёх индексов создался один, миграция ретраилась
 * каждый деплой, схема расходилась с кодом.
 *
 * Второй баг жил в локальном раннере (lib/database/migrate.ts): он отбрасывал
 * куски, начинающиеся с «--», то есть выражение с приклеенным ведущим
 * комментарием — а это ПЕРВОЕ выражение любого документированного файла —
 * молча пропускалось, и миграция помечалась применённой.
 *
 * Лекарство одно на оба раннера: splitSqlStatements в migrate-standalone.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = process.cwd();
const require_ = createRequire(import.meta.url);
const { splitSqlStatements, isNonTransactional } = require_(
  join(ROOT, 'scripts/migrate-standalone.js'),
) as {
  splitSqlStatements: (sql: string) => string[];
  isNonTransactional: (sql: string) => boolean;
};

/** Выражение без комментариев и пустот — то, что реально видит Postgres. */
function code(stmt: string): string {
  return stmt.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
}

describe('сплиттер против синтаксических ловушек', () => {
  it('точка с запятой в комментарии — не разделитель (инцидент 843)', () => {
    const sql = [
      '-- комментарий с точкой с запятой; и продолжением',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x);',
      '-- ещё один; коварный',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (y);',
    ].join('\n');
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(code(stmts[0])).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS a/);
    expect(code(stmts[1])).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS b/);
  });

  it('точка с запятой в строковом литерале — не разделитель', () => {
    const stmts = splitSqlStatements("UPDATE t SET v = 'a;b' WHERE id = 1; SELECT 1;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'a;b'");
  });

  it('удвоенная кавычка внутри строки не закрывает её', () => {
    const stmts = splitSqlStatements("UPDATE t SET v = 'it''s; fine'; SELECT 1;");
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'it''s; fine'");
  });

  it('dollar-quoted тело (DO $$ ... $$) остаётся одним выражением', () => {
    const sql = 'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$; SELECT 3;';
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('PERFORM 2');
  });

  it('блочный комментарий со «;» — не разделитель', () => {
    const stmts = splitSqlStatements('/* раз; два; */ SELECT 1; SELECT 2;');
    expect(stmts).toHaveLength(2);
  });

  it('ведущий комментарий не выбрасывает выражение (баг migrate.ts)', () => {
    const stmts = splitSqlStatements('-- шапка файла\nSELECT 1;');
    expect(stmts).toHaveLength(1);
    expect(code(stmts[0])).toBe('SELECT 1');
  });

  it('хвост из одних комментариев не превращается в пустой запрос', () => {
    const stmts = splitSqlStatements('SELECT 1;\n-- послесловие');
    expect(stmts).toHaveLength(1);
  });
});

describe('все CONCURRENTLY-миграции режутся на осмысленные выражения', () => {
  // Только эти файлы проходят через сплиттер — транзакционные уходят в базу
  // целиком. Каждый кусок обязан начинаться с SQL-глагола: кусок, начавшийся
  // с половины русского слова, — это и есть инцидент 843.
  const files = readdirSync(join(ROOT, 'migrations'))
    .filter(f => f.endsWith('.sql'))
    .filter(f => isNonTransactional(readFileSync(join(ROOT, 'migrations', f), 'utf-8')));

  it('нетранзакционные миграции найдены (иначе тест мёртв)', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain('843_agent_hot_path_indexes.sql');
  });

  for (const f of files) {
    it(`${f}: каждое выражение начинается с SQL-глагола`, () => {
      const stmts = splitSqlStatements(readFileSync(join(ROOT, 'migrations', f), 'utf-8'));
      expect(stmts.length).toBeGreaterThan(0);
      for (const s of stmts) {
        expect(code(s)).toMatch(
          /^(CREATE|DROP|REINDEX|ALTER|UPDATE|INSERT|DELETE|COMMENT|GRANT|SET|DO|SELECT|WITH|ANALYZE)\b/i,
        );
      }
    });
  }

  it('843 режется ровно на четыре CREATE INDEX CONCURRENTLY', () => {
    const stmts = splitSqlStatements(
      readFileSync(join(ROOT, 'migrations/843_agent_hot_path_indexes.sql'), 'utf-8'),
    );
    expect(stmts).toHaveLength(4);
    for (const s of stmts) {
      expect(code(s)).toMatch(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    }
  });
});

describe('оба раннера пользуются одним сплиттером', () => {
  it('standalone зовёт splitSqlStatements, наивного split больше нет', () => {
    const src = readFileSync(join(ROOT, 'scripts/migrate-standalone.js'), 'utf-8');
    expect(src).toMatch(/splitSqlStatements\(sql\)/);
    expect(src).not.toMatch(/sql\.split\(';'\)/);
  });

  it('migrate.ts зовёт общий сплиттер, свой регексп-раскрой удалён', () => {
    const src = readFileSync(join(ROOT, 'lib/database/migrate.ts'), 'utf-8');
    expect(src).toMatch(/splitSqlStatements\(sql\)/);
    expect(src).toMatch(/migrate-standalone/);
    expect(src).not.toMatch(/\.split\(\/;/);
  });
});
