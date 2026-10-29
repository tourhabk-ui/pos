/**
 * Новый тур из миграции называет своё главное место — или причину, почему его
 * нет (слово владельца 29.10, «1в 2б 3 да»; миграция 1343).
 *
 * Карточка места показывает все туры к месту по связи
 * operator_tours.main_place_id, карточка тура — «к этому месту есть ещё N
 * предложений». До 29.10 туры, заведённые миграциями (1176, 1217, 1338,
 * 1339), связи не несли: INSERT её не называл, и к Горелому или Дачным
 * «Туры сюда» не показывали ни одного тура из десятка. 1343 связала 51 тур
 * задним числом; этот сторож держит, чтобы долг не копился снова.
 *
 * Что держит (текст SQL судится по смыслу — список колонок INSERT, правило
 * 13.10 это разрешает):
 *  - каждый файл миграций новее 1341 с `INSERT INTO operator_tours` называет
 *    в списке колонок `main_place_id` — или стоит в KNOWN_UNLINKED с причиной
 *    (облёт трёх вулканов, многодневный по районам, места нет в справочнике);
 *  - запись KNOWN_UNLINKED самоустаревает: файла нет или он уже пишет
 *    `main_place_id` — красный, «уберите запись»;
 *  - у каждой строки 1343 есть причина, имя места, slug тура из миграции,
 *    которая тур завела, и id места, известный миграциям или снимку схемы, —
 *    связь не выдумана.
 * Сам сторож проверен на подложенном каталоге: миграция с INSERT без
 * `main_place_id` — нарушение, с колонкой — нет.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrationNumber } from '@/lib/database/migration-order';

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, 'migrations');
const BASELINE = join(ROOT, 'lib', 'database', 'baseline', 'schema-baseline.sql');

/** Граница: 1343 связала всё, что было до неё; дальше — правило. */
const FROM_NUMBER = 1343;

/** Файл → причина, почему туры в нём не называют главное место. Только сокращается. */
const KNOWN_UNLINKED: Record<string, string> = {};

/** SQL без строчных комментариев: слово в шапке не INSERT. */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

/** Списки колонок всех `INSERT INTO operator_tours (…)` файла. */
export function tourInsertColumnLists(sql: string): string[][] {
  const out: string[][] = [];
  const src = code(sql);
  const re = /INSERT\s+INTO\s+operator_tours\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
    }
    out.push(src.slice(start, i - 1).split(',').map((c) => c.trim().toLowerCase()).filter(Boolean));
  }
  return out;
}

export interface Violation { file: string; reason: string }

/** Нарушения правила в каталоге `dir`: INSERT туров без главного места и без записи в реестре. */
export function unlinkedTourInserts(dir: string, known: Record<string, string>): Violation[] {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const out: Violation[] = [];
  for (const f of files) {
    const n = migrationNumber(f);
    if (n === null || n < FROM_NUMBER) continue;
    const lists = tourInsertColumnLists(readFileSync(join(dir, f), 'utf8'));
    if (lists.length === 0) continue;
    const missing = lists.some((cols) => !cols.includes('main_place_id'));
    if (missing && !(f in known)) {
      out.push({ file: f, reason: 'INSERT INTO operator_tours без main_place_id и без записи в KNOWN_UNLINKED' });
    }
  }
  return out;
}

/** Самоустаревание реестра: файла нет, он не заводит туров или уже пишет место. */
export function staleUnlinked(dir: string, known: Record<string, string>): Violation[] {
  const out: Violation[] = [];
  for (const [f, why] of Object.entries(known)) {
    if (!why.trim()) { out.push({ file: f, reason: 'пустая причина' }); continue; }
    const p = join(dir, f);
    if (!existsSync(p)) { out.push({ file: f, reason: 'файла нет — уберите запись' }); continue; }
    const lists = tourInsertColumnLists(readFileSync(p, 'utf8'));
    if (lists.length === 0 || lists.every((cols) => cols.includes('main_place_id'))) {
      out.push({ file: f, reason: 'файл уже пишет main_place_id или не заводит туров — уберите запись' });
    }
  }
  return out;
}

describe('новые туры из миграций называют главное место (1343)', () => {
  it('ни одного INSERT туров без main_place_id и без причины', () => {
    expect(unlinkedTourInserts(MIGRATIONS, KNOWN_UNLINKED)).toEqual([]);
  });

  it('реестр исключений не протух', () => {
    expect(staleUnlinked(MIGRATIONS, KNOWN_UNLINKED)).toEqual([]);
  });

  describe('сторож на подложенном каталоге', () => {
    let dir = '';
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
    const put = (name: string, sql: string) => writeFileSync(join(dir, name), sql);

    it('INSERT без колонки — нарушение; с колонкой, до границы или в реестре — нет', () => {
      dir = mkdtempSync(join(tmpdir(), 'tour-main-place-'));
      put('1341_before.sql', `INSERT INTO operator_tours (operator_id, title) VALUES ('a', 'b');`);
      put('1343_no_place.sql', `-- INSERT INTO operator_tours (main_place_id) в комментарии не считается\nINSERT INTO operator_tours (operator_id, title, slug)\nSELECT v.op, v.t, v.s FROM (VALUES ('a','b','c')) AS v(op, t, s);`);
      put('1344_with_place.sql', `INSERT INTO operator_tours (operator_id, title, main_place_id, main_place_source) VALUES ('a', 'b', 'p', 'verified');`);
      put('1345_known.sql', `INSERT INTO operator_tours (operator_id, title) VALUES ('a', 'b');`);
      expect(unlinkedTourInserts(dir, { '1345_known.sql': 'облёт трёх вулканов — одного места нет' }))
        .toEqual([{ file: '1343_no_place.sql', reason: expect.stringContaining('без main_place_id') }]);
    });

    it('запись реестра без файла, без INSERT или уже с колонкой — протухла', () => {
      dir = mkdtempSync(join(tmpdir(), 'tour-main-place-'));
      put('1344_with_place.sql', `INSERT INTO operator_tours (operator_id, main_place_id) VALUES ('a', 'p');`);
      put('1346_no_insert.sql', `UPDATE operator_tours SET title = 'x';`);
      put('1347_ok.sql', `INSERT INTO operator_tours (operator_id) VALUES ('a');`);
      const stale = staleUnlinked(dir, {
        '1344_with_place.sql': 'причина',
        '1346_no_insert.sql': 'причина',
        '1399_gone.sql': 'причина',
        '1347_ok.sql': 'многодневный по районам',
      }).map((v) => v.file).sort();
      expect(stale).toEqual(['1344_with_place.sql', '1346_no_insert.sql', '1399_gone.sql']);
    });
  });
});

describe('1343: каждая связь названа и не выдумана', () => {
  const sql = readFileSync(join(MIGRATIONS, '1343_tour_main_place_verified.sql'), 'utf8');
  const wanted = sql.slice(sql.indexOf('WITH wanted('), sql.indexOf('UPDATE operator_tours t'));
  const rows = [...code(wanted).matchAll(/\('([^']*)', '([^']*)', '([^']*)', '([^']*)', '((?:[^']|'')*)'\)/g)]
    .map(([, op, slug, placeId, placeName, reason]) => ({ op, slug, placeId, placeName, reason }));

  // Все файлы, которые заводят туры, — откуда slug «настоящий».
  const tourFiles = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && f !== '1343_tour_main_place_verified.sql')
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .filter((s) => /INSERT\s+INTO\s+operator_tours/i.test(code(s)));
  const otherSql = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql') && f !== '1343_tour_main_place_verified.sql')
    .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'))
    .join('\n') + readFileSync(BASELINE, 'utf8');

  it('51 строка, у каждой причина, имя места и slug тура', () => {
    expect(rows).toHaveLength(51);
    for (const r of rows) {
      expect(r.reason.trim().length, r.slug).toBeGreaterThan(5);
      expect(r.placeName.trim().length, r.slug).toBeGreaterThan(2);
      expect(r.slug, r.slug).toMatch(/^[a-z0-9-]+$/);
      expect(r.placeId, r.slug).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(rows.map((r) => r.slug)).size, 'тур связан один раз').toBe(rows.length);
  });

  it('тур заведён миграцией, место известно миграциям или снимку схемы', () => {
    for (const r of rows) {
      expect(tourFiles.some((s) => s.includes(`'${r.slug}'`)), `тур ${r.slug}`).toBe(true);
      expect(otherSql.includes(r.placeId), `место ${r.placeId} (${r.placeName})`).toBe(true);
    }
  });

  it('продавец сверяется: строка ложится только у тура этого партнёра', () => {
    const update = code(sql.slice(sql.indexOf('UPDATE operator_tours t')));
    expect(update).toMatch(/JOIN partners pa ON pa\.slug = w\.op_slug/);
    expect(update).toMatch(/t\.operator_id::text = pa\.id::text/);
    expect(update).toMatch(/t\.main_place_id IS NULL/);
    expect(update).toMatch(/pl\.name = w\.place_name/);
  });
});
