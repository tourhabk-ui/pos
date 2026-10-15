/**
 * Время тревог — стенное UTC, сравнение — с `UTC_WALL_NOW_SQL` (15.10, #2495,
 * владелец «го»).
 *
 * `external_alerts.created_at/expires_at/updated_at` и
 * `location_real_time_status.alert_expires_at` — `timestamp` без пояса со
 * стенным временем UTC (ингест и админка пишут датой JS с сервера в UTC).
 * `expires_at > NOW()` толковал его поясом сессии (+03 на проде): тревога
 * уходила из ленты на три часа раньше, закрытие «до 10 утра» гасло в 7 утра.
 * Этот же сторож на дереве main до правки нашёл 45 таких запросов в 31 файле.
 *
 * Поведение держит pg-тест с поясом МСК (`tests/integration/
 * safety-status-feed.pg.test.ts`: тревога со сроком через час жива,
 * погашенное не оживает, миграция 1267 однократна). Этот файл — запрет
 * (правило 13.10: регулярка по исходнику — только «этого быть не должно»):
 * в SQL со временем тревог не возвращается голый NOW() — ни в коде, ни в
 * миграциях новее 1267.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';

const ROOT = process.cwd();
const DIRS = ['app', 'lib', 'components'];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') out.push(...files(p)); continue; }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** SQL-строки файла: шаблонные литералы без блочных комментариев (в JSDoc бывают обратные кавычки). */
function sqlLiterals(src: string): Array<{ text: string; line: number }> {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, (m) => ' '.repeat(m.length));
  const out: Array<{ text: string; line: number }> = [];
  for (const m of code.matchAll(/`[^`]*`/g)) {
    // SQL-комментарий внутри запроса («прежнее created_at > NOW() …») — не запрос.
    out.push({ text: m[0].replace(/--[^\n]*/g, ''), line: code.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Что запрещено в SQL со временем тревог. */
const FORBIDDEN: Array<{ re: RegExp; what: string }> = [
  { re: /\b(?:\w+\.)?(?:expires_at|created_at)\s*(?:<=|>=|<|>|=)\s*NOW\(\)(?!\s*AT TIME ZONE)/i, what: 'сравнение или запись с голым NOW()' },
  { re: /NOW\(\)\s*-\s*(?:\w+\.)?created_at/i, what: 'возраст от голого NOW()' },
  // updated_at — только у самой таблицы тревог: location_real_time_status.updated_at
  // пишется в поясе сессии намеренно и читается isoUtcSql (тот же запрос пересчёта).
  { re: /UPDATE\s+external_alerts\b[\s\S]*\bupdated_at\s*=\s*NOW\(\)(?!\s*AT TIME ZONE)/i, what: 'updated_at тревоги от голого NOW()' },
];
const LRTS_FORBIDDEN = /\b(?:\w+\.)?alert_expires_at\s*(?:<=|>=|<|>)\s*NOW\(\)(?!\s*AT TIME ZONE)/i;
const INSERT_NOW = /INSERT INTO external_alerts[\s\S]*VALUES\s*\([^`]*\bNOW\(\)(?!\s*AT TIME ZONE)/i;

/** Нарушения в одном куске SQL; `where` — имя файла и строка для отчёта. */
function judge(text: string, where: string): string[] {
  const hits: string[] = [];
  if (/external_alerts/.test(text)) {
    for (const { re, what } of FORBIDDEN) if (re.test(text)) hits.push(`${where} — ${what}`);
    if (INSERT_NOW.test(text)) hits.push(`${where} — NOW() во времени новой тревоги`);
  }
  if (LRTS_FORBIDDEN.test(text)) hits.push(`${where} — alert_expires_at против голого NOW()`);
  return hits;
}

function findViolations(): string[] {
  const hits: string[] = [];
  for (const dir of DIRS) {
    for (const f of files(join(ROOT, dir))) {
      const src = readFileSync(f, 'utf8');
      if (!/external_alerts|alert_expires_at/.test(src)) continue;
      for (const lit of sqlLiterals(src)) hits.push(...judge(lit.text, `${relative(ROOT, f)}:${lit.line}`));
    }
  }
  return hits;
}

/**
 * Миграции тоже пишут тревоги: 718/729 заводили ручные записи с NOW(), 1123
 * гасила тревогу `SET expires_at = NOW()`. По новому правилу такое гашение
 * оставило бы тревогу в ленте ещё на три часа. До 1267 включительно — история
 * (её приводит сама 1267), дальше — то же соглашение, что в коде.
 */
const UTC_WALL_SINCE = 1267;

function migrationStatements(file: string): Array<{ text: string; line: number }> {
  const sql = readFileSync(join(ROOT, 'migrations', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/--[^\n]*/g, '');
  const out: Array<{ text: string; line: number }> = [];
  let line = 1;
  for (const stmt of sql.split(';')) {
    out.push({ text: stmt, line: line + (stmt.match(/^\s*/)?.[0].split('\n').length ?? 1) - 1 });
    line += stmt.split('\n').length - 1;
  }
  return out;
}

function findMigrationViolations(): string[] {
  const hits: string[] = [];
  for (const file of readdirSync(join(ROOT, 'migrations'))) {
    const n = Number(file.match(/^(\d+)_.*\.sql$/)?.[1]);
    if (!(n > UTC_WALL_SINCE)) continue;
    for (const st of migrationStatements(file)) hits.push(...judge(st.text, `migrations/${file}:${st.line}`));
  }
  return hits;
}

describe('время тревог — стенное UTC', () => {
  it('«сейчас» и ISO — по соглашению таблицы', () => {
    expect(UTC_WALL_NOW_SQL).toBe("(NOW() AT TIME ZONE 'UTC')");
    expect(utcWallIsoSql('created_at')).toBe(`to_char((created_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`);
  });

  it('в SQL со временем тревог нет голого NOW()', () => {
    expect(findViolations()).toEqual([]);
  });

  it('и в миграциях после 1267 — тоже', () => {
    expect(findMigrationViolations()).toEqual([]);
  });

  it('сторож видит то, что запрещает (иначе он немой)', () => {
    const probe = '`SELECT 1 FROM external_alerts WHERE expires_at > NOW() AND created_at > NOW() - INTERVAL \'1 day\'`';
    const lit = sqlLiterals(probe)[0].text;
    expect(FORBIDDEN.some(({ re }) => re.test(lit))).toBe(true);
    expect(FORBIDDEN.some(({ re }) => re.test('`SELECT 1 FROM external_alerts WHERE expires_at > (NOW() AT TIME ZONE \'UTC\')`'))).toBe(false);
    expect(LRTS_FORBIDDEN.test('rs.alert_expires_at > NOW()')).toBe(true);
    expect(INSERT_NOW.test('`INSERT INTO external_alerts (a, created_at) VALUES ($1, NOW())`')).toBe(true);
  });

  it('на настоящих миграциях до 1267 сторож краснеет: гашение 1123 и ручная запись 718', () => {
    const hits = (file: string) => migrationStatements(file).flatMap((st) => judge(st.text, file));
    expect(hits('1123_expire_cuks_anniversary_alert.sql').length).toBeGreaterThan(0);
    expect(hits('718_road_alerts_july.sql').length).toBeGreaterThan(0);
    // Сама 1267 сравнивает и пишет стенным UTC — ей сторож не мешает.
    expect(hits('1267_external_alerts_utc_wall.sql')).toEqual([]);
  });
});
