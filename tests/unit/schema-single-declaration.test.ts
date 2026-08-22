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
 *
 * ── Третий случай и расширение проверки ──────────────────────────────────
 *
 * Тем же вечером нашёлся `tour_availability`, и его эта проверка ПРОПУСТИЛА:
 * объявления лежали в РАЗНЫХ файлах — `lib/database/schema.sql` (tour_id UUID
 * → tours) и `migrations/040_operator_tools.sql` (operator_tour_id BIGINT →
 * operator_tours). Деплой применяет только `migrations/`, значит настоящая
 * колонка вторая, а против первой был написан инструмент оператора `my_tours`
 * и скрейпер туров — причём скрейпер глотал отказ пустым `catch`, и «даты
 * пропущены» читалось как норма (issue #1331).
 *
 * Поэтому проверка идёт по ВСЕМУ репозиторию, а не по одному файлу.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/** Значение из разбора — в шаблон только экранированным. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const ROOT = process.cwd();
const SCHEMA = fs.readFileSync(path.join(ROOT, 'lib/database/schema.sql'), 'utf8');

/** Комментарии SQL вырезаются: имя в пояснении объявлением не является. */
const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, '');
const SQL = strip(SCHEMA);

function tablesIn(sql: string): string[] {
  return [...sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)]
    .map(m => m[1].toLowerCase());
}

function declaredTables(): string[] {
  return tablesIn(SQL);
}

/** Все файлы схемы: bootstrap и миграции — с именем файла у каждого объявления. */
function declarationsAcrossRepo(): Map<string, string[]> {
  const byTable = new Map<string, string[]>();
  const files: Array<[string, string]> = [['lib/database/schema.sql', SCHEMA]];
  const dir = path.join(ROOT, 'migrations');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
    files.push([`migrations/${f}`, fs.readFileSync(path.join(dir, f), 'utf8')]);
  }
  for (const [name, raw] of files) {
    for (const t of tablesIn(strip(raw))) {
      const list = byTable.get(t) ?? [];
      list.push(name);
      byTable.set(t, list);
    }
  }
  return byTable;
}

/**
 * Таблицы, которые объявлены в нескольких файлах ОСОЗНАННО.
 *
 * Список закрыт и может только сокращаться. Пустой он и должен быть: если
 * повторное объявление понадобилось, у него есть причина, и она пишется здесь.
 */
const KNOWN_MULTI_FILE: string[] = [];

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

/** Имена колонок из тела CREATE TABLE. Ограничения и ключи пропускаются. */
function columnsOf(sql: string, table: string): Set<string> | null {
  const re = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${escapeRe(table)}\\s*\\(`, 'i');
  const m = re.exec(sql);
  if (m === null) return null;
  let depth = 0, body = '';
  for (let i = m.index + m[0].length - 1; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
    if (depth > 0 && !(ch === '(' && body === '')) body += ch;
  }
  const cols = new Set<string>();
  let d = 0, cur = '';
  for (const ch of body + ',') {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === ',' && d === 0) {
      const name = /^\s*([a-z_][a-z0-9_]*)/i.exec(cur)?.[1]?.toLowerCase();
      if (name !== undefined && !/^(constraint|primary|foreign|unique|check|exclude|like)$/.test(name)) {
        cols.add(name);
      }
      cur = '';
      continue;
    }
    cur += ch;
  }
  return cols;
}

describe('bootstrap-схема не спорит с миграциями', () => {
  // Деплой применяет ТОЛЬКО migrations/ (start.js → migrate-standalone.js);
  // lib/database/schema.sql в нём не участвует. Когда одна таблица объявлена
  // в обоих местах с РАЗНЫМИ колонками, получаются две правды: к базе едет
  // одна, а читают люди ту, что попалась. Так вышло трижды за один день —
  // guide_earnings, guide_schedule и tour_availability.
  //
  // Повтор сам по себе не запрещён: миграции законно пересоздают таблицы
  // идемпотентно. Запрещено РАСХОЖДЕНИЕ.
  const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'migrations'))
    .filter(n => n.endsWith('.sql')).sort()
    .map(n => [`migrations/${n}`, strip(fs.readFileSync(path.join(ROOT, 'migrations', n), 'utf8'))] as const);

  it('файлы миграций находятся', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(100);
  });

  /**
   * Названные расхождения. Список закрыт и может только сокращаться.
   *
   * `chat_sessions.context` объявлена в bootstrap и отсутствует в
   * миграции 03, которая таблицу и создаёт. К коду отношения не имеет:
   * обращений к этой колонке нет ни одного (проверено 22.08.2026). Не удалена
   * из bootstrap потому, что неизвестно, есть ли она на проде, — а гадать о
   * боевой схеме и есть то, из-за чего расхождения появляются. Снимается
   * ответом `GET /api/cron/schema-audit`.
   */
  const KNOWN_DIVERGENCE = [
    'chat_sessions: в schema.sql есть context, в migrations/03_vector_search.sql — нет',
  ];

  it('колонки в bootstrap и в миграциях не расходятся', () => {
    const conflicts: string[] = [];
    for (const table of new Set(declaredTables())) {
      const boot = columnsOf(SQL, table);
      if (boot === null) continue;
      for (const [file, sql] of MIGRATIONS) {
        const mig = columnsOf(sql, table);
        if (mig === null) continue;
        // Миграция может ДОБАВИТЬ колонки к тому, что знает bootstrap, — это
        // развитие. Опасно обратное: bootstrap обещает колонку, которой в
        // применяемой схеме нет.
        const onlyInBoot = [...boot].filter(c => !mig.has(c));
        if (onlyInBoot.length > 0) {
          conflicts.push(`${table}: в schema.sql есть ${onlyInBoot.join(', ')}, в ${file} — нет`);
        }
        break; // достаточно первого объявления в миграциях: оно и создаёт таблицу
      }
    }
    const fresh = conflicts.filter(c => !KNOWN_DIVERGENCE.includes(c));
    expect(fresh, 'две правды об одной таблице: к базе едет версия из migrations/').toEqual([]);
  });

  it('список названных расхождений не протухает', () => {
    const conflicts: string[] = [];
    for (const table of new Set(declaredTables())) {
      const boot = columnsOf(SQL, table);
      if (boot === null) continue;
      for (const [file, sql] of MIGRATIONS) {
        const mig = columnsOf(sql, table);
        if (mig === null) continue;
        const onlyInBoot = [...boot].filter(c => !mig.has(c));
        if (onlyInBoot.length > 0) {
          conflicts.push(`${table}: в schema.sql есть ${onlyInBoot.join(', ')}, в ${file} — нет`);
        }
        break;
      }
    }
    const stale = KNOWN_DIVERGENCE.filter(k => !conflicts.includes(k));
    expect(stale, 'расхождение устранено — уберите строку из KNOWN_DIVERGENCE').toEqual([]);
  });
});
