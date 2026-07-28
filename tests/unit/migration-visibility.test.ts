/**
 * Миграция не падает молча, и уборка не роняет вход.
 *
 * Два урока одного часа.
 *
 * Первый. Раннер миграций намеренно не роняет деплой на упавшей миграции: пишет
 * «[migrate] ✗ файл: причина», считает ошибку и всё равно поднимает сервер
 * (`process.exitCode = 0`, «don't block server start»). Решение верное —
 * платформа, которой пользуются в поле, не должна ложиться из-за одной кривой
 * миграции. Но у него не было второй половины: провал оставался строчкой в
 * логе деплоя, которую никто не читает на следующий день, а схема тихо
 * расходилась с кодом. Тот же класс, что зелёный KVERT с нулём вулканов.
 *
 * Второй. Уникальный индекс по users(telegram_id) я сперва написал безусловным.
 * Уникального ограничения на этой колонке не было НИКОГДА, а пишет её и второй
 * путь — `UPDATE users SET telegram_id` в телеграм-вебхуке, — значит дубли в
 * живой базе возможны, и такая миграция падала бы на каждом деплое. Уборка,
 * ломающая вход пользователей, хуже неубранного.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { findUnappliedMigrations, formatUnappliedMigrations } from '@/lib/agents/migration-status';

const ROOT = process.cwd();
const MIGRATION = readFileSync(join(ROOT, 'migrations/783_declare_columns_code_already_uses.sql'), 'utf-8');
const WATCHDOG = readFileSync(join(ROOT, 'lib/agents/watchdog.ts'), 'utf-8');

describe('неприменённые миграции видны', () => {
  it('находит файлы, которых нет в таблице учёта', () => {
    const files = ['001_a.sql', '002_b.sql', '003_c.sql'];
    expect(findUnappliedMigrations(files, ['001_a.sql'])).toEqual(['002_b.sql', '003_c.sql']);
  });

  it('всё применено — тревоги нет', () => {
    expect(findUnappliedMigrations(['001_a.sql'], ['001_a.sql'])).toEqual([]);
  });

  it('не-SQL файлы каталога не считаются миграциями', () => {
    // В migrations/ лежит ещё MIGRATION_ORDER.md — он не миграция.
    expect(findUnappliedMigrations(['001_a.sql', 'MIGRATION_ORDER.md'], ['001_a.sql'])).toEqual([]);
  });

  it('сообщение называет файлы и не разрастается на длинном списке', () => {
    const many = Array.from({ length: 9 }, (_, i) => `${700 + i}_x.sql`);
    const text = formatUnappliedMigrations(many);
    expect(text).toContain('700_x.sql');
    expect(text).toContain('и ещё 4');
  });

  it('сторож подключён к watchdog', () => {
    expect(WATCHDOG).toContain('checkUnappliedMigrations()');
    expect(WATCHDOG).toContain("'migration_unapplied'");
    expect(WATCHDOG).toContain('SELECT name FROM _migrations');
  });

  it('пустой каталог не судим — в образе миграций может не быть', () => {
    expect(WATCHDOG).toContain('if (files.length === 0) return null;');
  });
});

describe('уборка не ломает вход', () => {
  it('уникальный индекс строится только при отсутствии дублей', () => {
    expect(MIGRATION).toContain('HAVING COUNT(*) > 1');
    expect(MIGRATION).toContain('IF dup_count = 0 THEN');
  });

  it('при дублях миграция говорит вслух, а не молчит', () => {
    expect(MIGRATION).toContain('RAISE WARNING');
  });

  it('добавление колонок идемпотентно — на проде это no-op', () => {
    const adds = MIGRATION.match(/ADD COLUMN IF NOT EXISTS/g) ?? [];
    expect(adds.length).toBeGreaterThanOrEqual(9);
    expect(MIGRATION).not.toMatch(/ADD COLUMN(?!\s+IF NOT EXISTS)/);
  });

  it('в файле нет CONCURRENTLY — иначе раннер порежет DO-блок по «;»', () => {
    // scripts/migrate-standalone.js разбивает файл на выражения по точке с
    // запятой ТОЛЬКО для нетранзакционных миграций (CONCURRENTLY). DO $$ ... $$
    // такого разреза не переживёт: тело блока полно точек с запятой.
    expect(MIGRATION).not.toMatch(/CONCURRENTLY/i);
  });
});
