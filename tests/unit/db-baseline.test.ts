/**
 * Baseline-схема прод-БД (задача #57 — бэкап-фактор, находка прогона 14.08).
 *
 * Master-таблицы (places, kamchatka_routes, leads, sos_events, ...) не
 * создавала ни одна миграция — схема существовала только на проде.
 * Теперь: снятый с прода baseline лежит в репозитории, восстанавливается
 * scripts/bootstrap-from-baseline.js (проверено на пустом Postgres 16:
 * 202/202 таблицы, 0 ошибок), setup-database.sh больше не ссылается на
 * удалённые файлы. Сторож держит это состояние.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'lib/database/baseline/schema-baseline.sql');
const BASELINE = readFileSync(BASELINE_PATH, 'utf-8');
const BOOTSTRAP = readFileSync(join(ROOT, 'scripts/bootstrap-from-baseline.js'), 'utf-8');
const SETUP = readFileSync(join(ROOT, 'scripts/setup-database.sh'), 'utf-8');

describe('baseline в репозитории', () => {
  it('master-таблицы, которых нет в миграциях, присутствуют', () => {
    for (const t of ['places', 'kamchatka_routes', 'leads', 'sos_events', 'operator_tours', 'operator_bookings']) {
      expect(BASELINE, t).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`));
    }
    // Обратная совместимость: agent_route_knowledge — VIEW (миграция 663/677).
    expect(BASELINE).toMatch(/CREATE OR REPLACE VIEW agent_route_knowledge /);
  });

  it('generated-колонки сняты правильно (падение первого съёма)', () => {
    expect(BASELINE).toMatch(/GENERATED ALWAYS AS \(/);
    expect(BASELINE).toMatch(/search_vector tsvector GENERATED ALWAYS AS/);
  });

  it('baseline лежит ВНЕ migrations/ — автоматика деплоя его не трогает', () => {
    expect(BASELINE_PATH).toContain('lib/database/baseline');
    expect(existsSync(join(ROOT, 'migrations/schema-baseline.sql'))).toBe(false);
  });
});

describe('метаданные свежести (ревизия 15.08, P2)', () => {
  const ASSEMBLER = readFileSync(join(ROOT, 'scripts/assemble-db-baseline.py'), 'utf-8');

  it('сборщик пишет snapshot_at, SHA воркфлоу и счётчики объектов', () => {
    expect(ASSEMBLER).toMatch(/snapshot_at:/);
    expect(ASSEMBLER).toMatch(/GITHUB_RUN_ID/);
    expect(ASSEMBLER).toMatch(/GITHUB_SHA/);
    expect(ASSEMBLER).toMatch(/Объектов на проде/);
    expect(ASSEMBLER).toMatch(/ДИСЦИПЛИНА АКТУАЛЬНОСТИ/);
  });
});

describe('bootstrap-from-baseline', () => {
  it('отказывается работать на непустой базе без --force', () => {
    expect(BOOTSTRAP).toMatch(/relkind = 'r'/);
    expect(BOOTSTRAP).toMatch(/--force/);
    expect(BOOTSTRAP).toMatch(/только на пустую базу/);
  });

  it('сплиттер общий с раннером миграций (урок 843), не свой split', () => {
    expect(BOOTSTRAP).toMatch(/require\('\.\/migrate-standalone\.js'\)/);
    expect(BOOTSTRAP).toMatch(/splitSqlStatements/);
    expect(BOOTSTRAP).not.toMatch(/\.split\(';'\)/);
  });

  it('после схемы помечает все миграции применёнными', () => {
    expect(BOOTSTRAP).toMatch(/INSERT INTO _migrations\(name\)/);
    expect(BOOTSTRAP).toMatch(/ON CONFLICT DO NOTHING/);
  });
});

describe('setup-database.sh ожил', () => {
  it('не ссылается на удалённые файлы (находка прогона 14.08)', () => {
    expect(SETUP).not.toMatch(/psql "\$DATABASE_URL" -f scripts\/init-postgresql\.sql/);
    expect(SETUP).not.toMatch(/psql "\$DATABASE_URL" -f scripts\/apply-new-schemas\.sql/);
  });

  it('идёт через bootstrap и общий раннер миграций', () => {
    expect(SETUP).toMatch(/node scripts\/bootstrap-from-baseline\.js/);
    expect(SETUP).toMatch(/node scripts\/migrate-standalone\.js/);
  });
});
