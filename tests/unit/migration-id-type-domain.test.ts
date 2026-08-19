/**
 * Идентификатор сверяется в одном домене типов.
 *
 * Миграция 874 не применялась на проде шесть попыток подряд, и реестр отказов
 * назвал причину словами: `operator does not exist: text = uuid`.
 *
 * В этой схеме «одинаковый id» живёт в двух типах сразу — и расходятся даже
 * две колонки одной таблицы (типы измерены на проде, не взяты из объявлений):
 *
 *   kamchatka_routes.id       — uuid
 *   places.id                 — text
 *   route_waypoints.route_id  — uuid
 *   route_waypoints.place_id  — text
 *
 * 167 объявляла обе колонки route_waypoints как UUID, но создавала таблицу
 * через `CREATE TABLE IF NOT EXISTS` поверх уже существовавшей — объявление не
 * применилось, и угадать, какая колонка какого типа, по файлам миграций нельзя.
 *
 * Работает это только на удаче неявных приведений: INSERT приводит text→uuid
 * присваиванием, а сравнение `=` — нет, для него такого оператора просто не
 * существует. Поэтому миграция, которая пишет `rw.route_id = m.route_id::uuid`,
 * читается правильной и падает целиком.
 *
 * Лечится не угадыванием типа, а отказом от предположения: обе стороны
 * приводятся к тексту. `uuid::text` даёт канонический нижний регистр, `text` не
 * меняется, и сравнение перестаёт зависеть от того, что объявлено в миграции
 * десятилетней давности. Обратное приведение (к `uuid`) запрещено отдельно:
 * `places.id` — свободный текст, и первая же не-uuid запись уронит прогон на
 * самом приведении, ещё до всякого сравнения.
 *
 * Сторож смотрит только НОВЫЕ миграции (870+). Старые уже применились такими,
 * какие есть, и переписывать применённое нельзя.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'migrations');
const FROM = 870;

/** Столбцы, чей тип на проде разошёлся с объявлением. */
const ID_COLUMNS = /\b\w+\.(route_id|place_id|id)\b/;

function newMigrations(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => {
      const n = Number(f.slice(0, 3));
      return Number.isFinite(n) && n >= FROM;
    });
}

/**
 * Псевдонимы списков VALUES: `) AS m(route_id, place_id)`.
 *
 * У литерала из VALUES своего типа нет — он принимает тип второй стороны
 * сравнения. Значит такая сторона никогда не бывает виновной, и требовать от
 * неё `::text` бессмысленно.
 */
function valuesAliases(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/\)\s*AS\s+(\w+)\s*\(/gi)) out.add(m[1]);
  return out;
}

/** Строки кода без комментариев — сравнения ищем только в них. */
function codeLines(sql: string): string[] {
  return sql.split('\n').map((l) => {
    const at = l.indexOf('--');
    return at === -1 ? l : l.slice(0, at);
  });
}

/** Строки-сравнения, где тип идентификатора предполагается. */
export function assumedIdTypes(sql: string): string[] {
  const literals = valuesAliases(sql);
  const bad: string[] = [];
  codeLines(sql).forEach((line, i) => {
    const m = line.match(/([\w.]+(?:::\s*\w+)?)\s*=\s*([\w.]+(?:::\s*\w+)?)/);
    if (!m) return;
    const [, left, right] = m;
    if (!ID_COLUMNS.test(left) && !ID_COLUMNS.test(right)) return;
    const typed = (side: string) =>
      /::\s*text\b/i.test(side) || literals.has(side.split('.')[0]);
    if (typed(left) && typed(right)) return;
    bad.push(`${i + 1}: ${line.trim()}`);
  });
  return bad;
}

describe('сторож ловит ровно тот отказ, что стоил шести попыток', () => {
  it('падавшая редакция 874 опознана', () => {
    const was = `UPDATE route_waypoints rw SET link_kind = 'waypoint'
  FROM (VALUES ('a','b')) AS m(route_id, place_id)
 WHERE rw.route_id = m.route_id::uuid;`;
    expect(assumedIdTypes(was).length).toBeGreaterThan(0);
  });

  it('починенная редакция чиста', () => {
    const now = `UPDATE route_waypoints rw SET link_kind = 'waypoint'
  FROM (VALUES ('a','b')) AS m(route_id, place_id)
 WHERE rw.route_id::text = m.route_id;`;
    expect(assumedIdTypes(now)).toEqual([]);
  });

  it('сверка колонок двух таблиц без приведения опознана', () => {
    expect(assumedIdTypes('WHERE p.id = rw.place_id').length).toBeGreaterThan(0);
    expect(assumedIdTypes('WHERE p.id::text = rw.place_id::text')).toEqual([]);
  });

  it('строковый литерал не считается сравнением типов', () => {
    expect(assumedIdTypes("WHERE rw.link_kind = 'unknown'")).toEqual([]);
  });
});

describe('новые миграции не предполагают тип идентификатора', () => {
  const files = newMigrations();

  it('новые миграции найдены', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('идентификаторы не приводятся к uuid', () => {
    const bad: string[] = [];
    for (const f of files) {
      codeLines(readFileSync(join(DIR, f), 'utf-8')).forEach((line, i) => {
        if (/::\s*uuid\b/i.test(line) && /=/.test(line)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad, 'приведение к uuid падает на первой же не-uuid записи places.id').toEqual([]);
  });

  it('в сравнении идентификаторов обе стороны — текст', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const line of assumedIdTypes(readFileSync(join(DIR, f), 'utf-8'))) {
        bad.push(`${f}:${line}`);
      }
    }
    expect(bad, 'сверять id разных таблиц можно только приведя обе стороны к тексту').toEqual([]);
  });
});
