/**
 * Одна таблица — одно объявление.
 *
 * 22.08.2026 в `lib/database/schema.sql` нашлись ДВА объявления
 * `guide_earnings` и два `guide_schedule` — с разными колонками и разными
 * внешними ключами. Из-за `IF NOT EXISTS` применяется первое; второе не
 * применяется никогда, но читается как правда тем, кто пишет код по этому
 * файлу. Так и вышло: `recordGuideEarnings` был написан против призрака и
 * обращался к трём несуществующим колонкам. Функцию не звали ни разу, поэтому
 * расхождение прожило незамеченным.
 *
 * Хуже того, следом за призраком шёл `CREATE INDEX ... ON guide_earnings(status)`
 * — по колонке, которой в настоящей таблице нет. На ЧИСТОЙ базе сборка схемы
 * падала там. Ровно тот же сорт поломки, что и с `users(telegram_id)`:
 * репозиторий не мог собрать собственную БД.
 *
 * Второе объявление не ошибка редактирования, а ловушка: оно выглядит
 * рабочим. Поэтому проверяется файлом, а не памятью.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SCHEMA = fs.readFileSync(path.join(ROOT, 'lib/database/schema.sql'), 'utf8');

/** Комментарии SQL вырезаются: имя в пояснении объявлением не является. */
const SQL = SCHEMA.replace(/^\s*--.*$/gm, '');

function declaredTables(): string[] {
  return [...SQL.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)].map(m => m[1].toLowerCase());
}

describe('bootstrap-схема', () => {
  it('таблиц объявлено много — иначе разбор ниже бессмысленен', () => {
    expect(declaredTables().length).toBeGreaterThan(20);
  });

  it('ни одна таблица не объявлена дважды', () => {
    const seen = new Map<string, number>();
    for (const t of declaredTables()) seen.set(t, (seen.get(t) ?? 0) + 1);
    const twice = [...seen.entries()].filter(([, n]) => n > 1).map(([t, n]) => `${t} × ${n}`);
    expect(twice, 'второе объявление не применяется, но читается как правда').toEqual([]);
  });

  it('индексы строятся по объявленным колонкам', () => {
    // Колонки таблицы — из её единственного объявления.
    const columns = new Map<string, Set<string>>();
    for (const m of SQL.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\);/gi)) {
      const cols = new Set<string>();
      for (const line of m[2].split('\n')) {
        const c = /^\s*([a-z_][a-z0-9_]*)\s+[A-Za-z]/.exec(line);
        // CONSTRAINT / PRIMARY KEY / UNIQUE — не колонки.
        if (c && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(c[1])) cols.add(c[1].toLowerCase());
      }
      columns.set(m[1].toLowerCase(), cols);
    }

    const broken: string[] = [];
    for (const m of SQL.matchAll(/CREATE INDEX(?:\s+IF NOT EXISTS)?\s+\S+\s+ON\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi)) {
      const table = m[1].toLowerCase();
      const cols = columns.get(table);
      if (cols === undefined) continue; // таблица заводится миграцией — не наш случай
      for (const raw of m[2].split(',')) {
        const col = raw.trim().split(/\s+/)[0].toLowerCase();
        // Выражения (lower(...), coalesce(...)) не разбираем.
        if (!/^[a-z_][a-z0-9_]*$/.test(col)) continue;
        if (!cols.has(col)) broken.push(`${table}(${col})`);
      }
    }
    expect(broken, 'индекс по несуществующей колонке валит сборку чистой базы').toEqual([]);
  });
});
