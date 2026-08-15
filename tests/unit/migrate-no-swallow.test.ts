/**
 * Раннер миграций не глотает файл (находка сквозного прогона 14.08).
 *
 * Было: транзакционный файл уходил в базу целиком; «already exists» на ОДНОМ
 * выражении откатывал ВЕСЬ файл, а раннер помечал миграцию применённой.
 * Воспроизведено на 040_operator_tools.sql: tour_availability уже была —
 * operator_tours и operator_bookings не создались, миграция «прошла».
 *
 * Стало: повыражённо под SAVEPOINT — конфликт идемпотентности пропускает
 * только своё выражение; настоящая ошибка валит файл громко и НЕ помечает
 * его применённым. Реализация одна на оба раннера (standalone CJS), как и
 * сплиттер (урок 843).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const {
  isTxControlStatement,
  applyTransactionalFile,
} = requireCjs('../../scripts/migrate-standalone.js') as {
  isTxControlStatement: (s: string) => boolean;
  applyTransactionalFile: (
    client: { query: (sql: string, vals?: unknown[]) => Promise<unknown> },
    sql: string,
    log?: (l: string) => void,
  ) => Promise<{ statements: number; skippedStatements: number }>;
};

const ROOT = process.cwd();
const STANDALONE = readFileSync(join(ROOT, 'scripts/migrate-standalone.js'), 'utf-8');
const MIGRATE_TS = readFileSync(join(ROOT, 'lib/database/migrate.ts'), 'utf-8');

describe('applyTransactionalFile: конфликт пропускает выражение, не файл', () => {
  // Фейковый клиент: журналирует SQL, «уже существует» бросает на маркере.
  function fakeClient(failOn: RegExp, error: Error) {
    const log: string[] = [];
    return {
      log,
      query: async (sql: string) => {
        log.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        if (failOn.test(sql)) throw error;
      },
    };
  }

  it('already exists → ROLLBACK TO SAVEPOINT, остальные выражения применяются', async () => {
    const c = fakeClient(/CREATE TABLE old_t/, new Error('relation "old_t" already exists'));
    const res = await applyTransactionalFile(
      c,
      'CREATE TABLE old_t (id INT); CREATE TABLE new_t (id INT);',
    );
    expect(res.skippedStatements).toBe(1);
    expect(c.log).toContain('ROLLBACK TO SAVEPOINT');
    expect(c.log.some((l) => l.startsWith('CREATE TABLE new_t'))).toBe(true);
    expect(c.log[c.log.length - 1]).toBe('COMMIT');
  });

  it('настоящая ошибка → ROLLBACK файла и проброс, COMMIT не случается', async () => {
    const c = fakeClient(/CREATE TABLE bad_t/, new Error('syntax error at or near "х"'));
    await expect(
      applyTransactionalFile(c, 'CREATE TABLE ok_t (id INT); CREATE TABLE bad_t (id INT);'),
    ).rejects.toThrow('syntax error');
    expect(c.log).toContain('ROLLBACK');
    expect(c.log).not.toContain('COMMIT');
  });

  it('BEGIN/COMMIT внутри файла фильтруются — транзакцию держит раннер', async () => {
    const c = fakeClient(/никогда/, new Error('x'));
    const res = await applyTransactionalFile(
      c,
      'BEGIN; CREATE TABLE t1 (id INT); COMMIT;',
    );
    // Единственное содержательное выражение — CREATE TABLE.
    expect(res.statements).toBe(1);
    // BEGIN раннера ровно один — файловый отфильтрован (миграции 019, 040).
    expect(c.log.filter((l) => l === 'BEGIN').length).toBe(1);
  });

  it('isTxControlStatement: управление транзакцией — да, PL/pgSQL и код — нет', () => {
    expect(isTxControlStatement('BEGIN')).toBe(true);
    expect(isTxControlStatement(' begin transaction ')).toBe(true);
    expect(isTxControlStatement('COMMIT')).toBe(true);
    expect(isTxControlStatement('CREATE TABLE begin_log (id INT)')).toBe(false);
    expect(isTxControlStatement('CREATE FUNCTION f() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql')).toBe(false);
  });
});

describe('non-transactional путь тоже не глотает (ревизия 15.08, P0)', () => {
  it('migrate.ts: реальная ошибка nonTx-файла валит раннер до пометки', () => {
    // Было: ошибка логировалась, цикл продолжался, файл ПОСЛЕ цикла всё
    // равно помечался применённым. Теперь настоящая ошибка -> exit(1),
    // до INSERT INTO _migrations дело не доходит.
    const nonTxBlock = MIGRATE_TS.slice(
      MIGRATE_TS.indexOf('if (nonTx) {'),
      MIGRATE_TS.indexOf('} else {'),
    );
    expect(nonTxBlock).toMatch(/process\.exit\(1\)/);
    expect(nonTxBlock).not.toMatch(/errorCount\+\+/);
  });

  it('standalone: nonTx-ошибка пробрасывается в файловый catch (без пометки)', () => {
    expect(STANDALONE).toMatch(/if \(!isAlreadyExistsError\(e\.message\)\) throw e;/);
  });
});

describe('глоток удалён из обоих раннеров', () => {
  it('standalone: в catch цикла нет пометки «применена»', () => {
    // Ловим сам баг: INSERT INTO _migrations в ветке обработки ошибки файла.
    const catchBlock = STANDALONE.slice(
      STANDALONE.indexOf('// Снять возможную прерванную транзакцию'),
      STANDALONE.indexOf('} finally {'),
    );
    expect(catchBlock).not.toMatch(/INSERT INTO _migrations/);
    expect(STANDALONE).toMatch(/applyTransactionalFile\(client, sql/);
  });

  it('migrate.ts: реализация общая со standalone, «Still record as applied» нет', () => {
    expect(MIGRATE_TS).toMatch(/applyTransactionalFile/);
    expect(MIGRATE_TS).not.toMatch(/Still record as applied/);
    // Цельного куска файла в транзакцию больше не шлём.
    expect(MIGRATE_TS).not.toMatch(/client\.query\(sql\)/);
  });

  it('SAVEPOINT-механика присутствует в общей реализации', () => {
    expect(STANDALONE).toMatch(/SAVEPOINT mig_stmt/);
    expect(STANDALONE).toMatch(/ROLLBACK TO SAVEPOINT mig_stmt/);
  });
});
