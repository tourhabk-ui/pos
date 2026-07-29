/**
 * В совместимые VIEW не пишут.
 *
 * `bookings` и `tours` — не таблицы, а VIEW над operator_bookings и
 * operator_tours (миграция 132), сделанные когда-то, чтобы шестьдесят legacy-
 * маршрутов не переписывать разом. Читать через них CLAUDE.md уже запрещает.
 * Писать — запрещает тем более, и вот почему это не вкусовщина:
 *
 * VIEW не подхватывает новые колонки базы. `end_date` добавили в
 * operator_bookings миграцией 140 — во view его нет и сегодня. `currency` в
 * список выборки не попал изначально. `total_price` там вообще выражение
 * COALESCE, в которое PostgreSQL писать не даёт. Поэтому
 * `INSERT INTO bookings (..., end_date, currency, total_price, ...)` падал на
 * разборе при КАЖДОМ вызове: бронирование тура существовало в виде маршрута и
 * не существовало как работающая функция. Фронт его не звал, поэтому поломка
 * молчала — ровно тот же класс, что зелёный KVERT с нулём вулканов.
 *
 * Тест держит правило: новые записи в совместимые view не появляются.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const COMPAT_VIEWS = ['bookings', 'tours'];

/**
 * Известный долг: три legacy-маршрута создания тура, которые пишут поля без
 * прямого дома в operator_tours — `season` и `coordinates` (JSON против
 * season_start/season_end и latitude/longitude), `requirements`, `route_id`.
 * Перенос требует продуктовых решений, а не переименования колонок, и на
 * платформе, которая обещает не выдумывать данные, угадывать сопоставление
 * нельзя. Живой путь оператора идёт мимо них — /api/hub/operator/tours пишет
 * в operator_tours напрямую. Список закрыт: он может только сокращаться.
 */
const KNOWN_DEBT = [
  'app/api/operator/tours/route.ts',
  'app/api/tours/route.ts',
  'app/api/tours/create/route.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const FILES = [...walk('app'), ...walk('lib')];

/** Строки-комментарии отбрасываем: соседний комментарий объясняет запрет и сам его цитирует. */
function code(src: string): string {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n');
}

describe('запись в совместимые view', () => {
  const offenders: Array<{ file: string; view: string }> = [];

  for (const file of FILES) {
    const src = code(readFileSync(join(ROOT, file), 'utf-8'));
    for (const view of COMPAT_VIEWS) {
      if (new RegExp(`INSERT\\s+INTO\\s+${view}\\s*\\(`, 'i').test(src)) {
        offenders.push({ file, view });
      }
    }
  }

  it('новых записей в bookings и tours не появляется', () => {
    const unexpected = offenders.filter((o) => !KNOWN_DEBT.includes(o.file));
    expect(
      unexpected.map((o) => `${o.file} → ${o.view}`),
      'писать надо в operator_bookings / operator_tours: view не подхватывает новые колонки базы',
    ).toEqual([]);
  });

  it('список известного долга не разрастается и не протухает', () => {
    // Каждая строка списка должна соответствовать реальному нарушению: иначе
    // список превращается в кладбище, где новое нарушение спрячется незаметно.
    const stale = KNOWN_DEBT.filter((f) => !offenders.some((o) => o.file === f));
    expect(stale, 'долг починен — убрать строку из списка').toEqual([]);
    expect(KNOWN_DEBT).toHaveLength(3);
  });

  it('бронирование тура пишет в мастер-таблицу', () => {
    const src = readFileSync(join(ROOT, 'app/api/tours/[id]/book/route.ts'), 'utf-8');
    expect(src).toContain('INSERT INTO operator_bookings');
    expect(code(src)).not.toContain('INSERT INTO bookings');
  });
});

describe('занятость тура считается по людям', () => {
  it('места занимают участники, а не число заявок', () => {
    // COUNT(*) считал заявки: одна бронь на десятерых занимала одно место из
    // max_group_size. На выходе в поле перебор группы — это гид на четверых
    // с толпой, а не строчка в отчёте.
    const src = readFileSync(join(ROOT, 'app/api/tours/[id]/book/route.ts'), 'utf-8');
    expect(src).toContain('COALESCE(SUM(participants), 0)');
    expect(code(src)).not.toContain('COUNT(*) as bookings');
  });
});
