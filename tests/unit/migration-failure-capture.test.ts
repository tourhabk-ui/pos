/**
 * Причина отказа миграции должна храниться, а не теряться в логе деплоя.
 *
 * Восемь миграций на проде не применялись месяцами. Разбирать, почему, пришлось
 * по форме схемы — угадывая между двумя одинаково правдоподобными версиями
 * (несовпадение типов против отсутствия unique/PK), потому что настоящий текст
 * ошибки существовал ровно один раз: строкой `[migrate] ✗` в логе деплоя,
 * который никто не читает на следующий день.
 *
 * Теперь раннер пишет причину в `_migration_failures` и стирает запись, когда
 * миграция проходит. Текст уезжает в лог GitHub Actions через аудит, то есть за
 * границу, поэтому похожее на персональные данные глушится детерминированно —
 * 152-ФЗ, и это не теория: сообщения Postgres умеют цитировать значения.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'module';

const ROOT = process.cwd();
const SRC = readFileSync(join(ROOT, 'scripts/migrate-standalone.js'), 'utf-8');

const require_ = createRequire(import.meta.url);
const { scrubError } = require_(join(ROOT, 'scripts/migrate-standalone.js')) as {
  scrubError: (msg: unknown) => string;
};

describe('провал миграции переживает деплой', () => {
  it('раннер заводит таблицу причин', () => {
    expect(SRC).toContain('CREATE TABLE IF NOT EXISTS _migration_failures');
  });

  it('причина записывается при отказе', () => {
    expect(SRC).toContain('INSERT INTO _migration_failures(name, error)');
    expect(SRC).toContain('attempts = _migration_failures.attempts + 1');
  });

  it('запись стирается, когда миграция прошла', () => {
    // Иначе список станет кладбищем и в нём спрячется живой отказ — ровно то,
    // от чего страхует «список долга не протухает» в schema-usage.
    const deletes = SRC.match(/DELETE FROM _migration_failures WHERE name = \$1/g) ?? [];
    expect(deletes.length, 'чистить надо и после успеха, и после «уже существует»').toBeGreaterThanOrEqual(2);
  });
});

describe('персональные данные не уезжают в лог Actions', () => {
  it('почта глушится', () => {
    expect(scrubError('duplicate key value: turist@example.com уже есть')).not.toContain('turist@example.com');
    expect(scrubError('duplicate key value: turist@example.com уже есть')).toContain('[почта]');
  });

  it('телефон глушится', () => {
    const out = scrubError('invalid input syntax: "+7 914 123-45-67"');
    expect(out).not.toContain('914');
    expect(out).toContain('[телефон]');
  });

  it('диагностика при этом остаётся', () => {
    const out = scrubError('column "agent_id" of relation "ai_actions_log" does not exist');
    expect(out).toContain('agent_id');
    expect(out).toContain('ai_actions_log');
  });

  it('длина ограничена', () => {
    expect(scrubError('x'.repeat(5000)).length).toBeLessThanOrEqual(400);
  });

  it('пустое и не-строка не роняют', () => {
    expect(scrubError(undefined)).toBe('');
    expect(scrubError(null)).toBe('');
  });
});
