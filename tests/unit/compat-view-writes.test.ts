/**
 * В `bookings` и `tours` не пишут.
 *
 * Миграция 132 планировала сделать их VIEW над operator_bookings и
 * operator_tours, чтобы шестьдесят legacy-маршрутов не переписывать разом.
 * Читать через них CLAUDE.md уже запрещает. Писать — запрещает тем более, и
 * вот почему это не вкусовщина:
 *
 * **Разбор 11.09 (#1814) показал: план 132 не выполнился.** `DROP VIEW IF
 * EXISTS bookings` глушит только «не существует» — а `bookings` была
 * ТАБЛИЦЕЙ, и `DROP VIEW` на ней падает с ошибкой; вся миграция шла одной
 * транзакцией и откатилась целиком (это же откатило добавление колонки
 * `operator_bookings.user_id` из того же файла — её вернула отдельно
 * миграция 906). Прод сегодня (`schema-baseline.sql`) держит `bookings` как
 * настоящую, отдельную, несовместимую таблицу: `id uuid` (не `bigint`, как у
 * `operator_bookings`), без `refund_amount`/`cancelled_by`/`cancelled_at`.
 * Запись в неё не «читает старые данные по забытому имени» — она падает на
 * разборе (`42703 undefined_column` или несовпадение типа id) и НЕ
 * ВЫПОЛНЯЕТСЯ НИКОГДА, ровно тот класс дефекта, что ложный «инкремент»
 * 24.08. `lib/bookings/booking.service.ts` жил с этим четырьмя UPDATE
 * (confirm/cancel/reschedule/complete, #1814) — молча, потому что тест ниже
 * проверял только `INSERT`.
 *
 * VIEW из плана 132 в любом случае не подошло бы: она не подхватывает новые
 * колонки базы. `end_date` добавили в operator_bookings миграцией 140 — во
 * view его не было бы и сегодня. `total_price` там выражение COALESCE, в
 * которое PostgreSQL писать не даёт.
 *
 * Тест держит правило: новые записи в `bookings`/`tours` не появляются — ни
 * INSERT, ни UPDATE.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const COMPAT_VIEWS = ['bookings', 'tours'];

/**
 * Известный долг: два legacy-маршрута создания тура, которые пишут поля без
 * прямого дома в operator_tours — `season` и `coordinates` (JSON против
 * season_start/season_end и latitude/longitude), `requirements`. Перенос
 * требует продуктовых решений, а не переименования колонок, и на платформе,
 * которая обещает не выдумывать данные, угадывать сопоставление нельзя.
 * Список закрыт: он может только сокращаться.
 *
 * `app/api/operator/tours/route.ts` вычеркнут (аудит кабинета оператора,
 * 24.08): INSERT переписан на operator_tours напрямую, поля без прямого
 * дома (season/coordinates/requirements) не угаданы, а честно убраны из
 * схемы запроса — эндпоинт писал в VIEW и падал на КАЖДОМ вызове, теперь
 * пишет в мастер-таблицу и работает.
 */
const KNOWN_DEBT = [
  'app/api/tours/route.ts',
  'app/api/tours/create/route.ts',
  /**
   * Найдены 11.09 расширением проверки на UPDATE (#1814 чинил только
   * lib/bookings/booking.service.ts; эти четыре — тот же класс дефекта в
   * соседних доменах, не тронуты этой правкой). Каждый UPDATE отвергается на
   * разборе (`bookings`/`tours` — отдельные несовместимые таблицы, не view,
   * см. шапку файла) и не выполняется никогда:
   * PUT /api/bookings/[id] не сохраняет special_requests ни разу;
   * деактивация/публикация тура оператором не выполняется ни разу.
   * Заведён #1827 — чинить предстоит отдельно, не задним числом здесь.
   */
  'app/api/bookings/[id]/route.ts',
  'app/api/operator/tours/[id]/deactivate/route.ts',
  'app/api/operator/tours/[id]/publish/route.ts',
  'lib/services/tours/tour.service.ts',
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
      if (
        new RegExp(`INSERT\\s+INTO\\s+${view}\\s*\\(`, 'i').test(src) ||
        new RegExp(`UPDATE\\s+${view}\\s+SET`, 'i').test(src)
      ) {
        offenders.push({ file, view });
      }
    }
  }

  it('новых записей в bookings и tours не появляется (ни INSERT, ни UPDATE)', () => {
    const unexpected = offenders.filter((o) => !KNOWN_DEBT.includes(o.file));
    expect(
      unexpected.map((o) => `${o.file} → ${o.view}`),
      'писать надо в operator_bookings / operator_tours: это отдельная несовместимая таблица (#1814), не view',
    ).toEqual([]);
  });

  it('список известного долга не разрастается и не протухает', () => {
    // Каждая строка списка должна соответствовать реальному нарушению: иначе
    // список превращается в кладбище, где новое нарушение спрячется незаметно.
    const stale = KNOWN_DEBT.filter((f) => !offenders.some((o) => o.file === f));
    expect(stale, 'долг починен — убрать строку из списка').toEqual([]);
    expect(KNOWN_DEBT).toHaveLength(6);
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
