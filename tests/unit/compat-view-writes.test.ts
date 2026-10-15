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
 * Известного долга нет (аудит 15.10, P2-02). Список держал три файла:
 *
 * - `app/api/tours/route.ts` (POST) — писал в `tours` колонками, которых у неё
 *   нет (`title`, `max_participants`, `min_participants`): 42703 на разборе,
 *   не выполнялся ни разу; вызывающих не было — POST снят;
 * - `app/api/tours/create/route.ts` — вызывающих не было — роут удалён;
 * - `lib/services/tours/tour.service.ts` — сирота `update()` (#1827) снят.
 *
 * Прежняя причина в этой шапке («поля без прямого дома в operator_tours»)
 * была верна только про второй файл; первый не выполнялся вовсе. Новая
 * запись сюда — не способ пройти проверку: писать надо в operator_*.
 */
const KNOWN_DEBT: string[] = [];

/**
 * Имя таблицы так, как его пишут в SQL: со схемой `public.` или без, в
 * кавычках или без. До P2-02 проверка видела только голое `tours (` — и
 * `INSERT INTO public.tours (...)` или `INSERT INTO tours SELECT ...` прошли
 * бы мимо неё.
 */
function tableRe(t: string): string {
  return `(?:"?public"?\\.)?"?${t}"?`;
}

/** Запись в таблицу: INSERT со списком колонок или без него, UPDATE с псевдонимом или без. */
function writesTo(src: string, t: string): boolean {
  return (
    new RegExp(`INSERT\\s+INTO\\s+${tableRe(t)}(?:\\s*\\(|\\s+(?:SELECT|VALUES|DEFAULT|WITH)\\b)`, 'i').test(src) ||
    new RegExp(`UPDATE\\s+(?:ONLY\\s+)?${tableRe(t)}(?:\\s+(?:AS\\s+)?\\w+)?\\s+SET\\b`, 'i').test(src)
  );
}

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
      if (writesTo(src, view)) {
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
    expect(KNOWN_DEBT).toHaveLength(0);
  });

  it('бронирование тура пишет в мастер-таблицу', () => {
    // С 15.10 (аудит, P2-01) строку брони тура пишет одна общая вставка;
    // прежний /api/tours/[id]/book удалён. Её перепись — booking-single-writer.
    const src = readFileSync(join(ROOT, 'lib/bookings/reserve.ts'), 'utf-8');
    expect(src).toContain('INSERT INTO operator_bookings');
    expect(code(src)).not.toContain('INSERT INTO bookings');
  });
});

describe('распознаватель записи видит все формы и не путает соседей', () => {
  // Сторож на сторожа: регулярка, которая не узнаёт запись, зеленеет ровно
  // тогда, когда запись появилась (CLAUDE.md, правило 10.09).
  it.each([
    'INSERT INTO tours (name) VALUES ($1)',
    'insert into public.tours (name) values ($1)',
    'INSERT INTO "tours" SELECT * FROM x',
    'INSERT INTO tours VALUES ($1)',
    'UPDATE tours SET name = $1',
    'UPDATE public.tours t SET name = $1',
    'UPDATE bookings AS b SET status = $1',
  ])('ловит: %s', (sql) => {
    expect(writesTo(sql, 'tours') || writesTo(sql, 'bookings')).toBe(true);
  });

  it.each([
    'INSERT INTO operator_tours (title) VALUES ($1)',
    'INSERT INTO tour_assets (tour_id) VALUES ($1)',
    'UPDATE operator_bookings SET booking_status = $1',
    'UPDATE tours_archive SET x = 1',
    'DELETE FROM tours WHERE id = $1',
  ])('не путает: %s', (sql) => {
    expect(writesTo(sql, 'tours') || writesTo(sql, 'bookings')).toBe(false);
  });
});

/**
 * Ссылка на запрещённую таблицу — тоже запись в неё по смыслу (аудит 15.10,
 * P2-02). `conversations.tour_id` на проде — uuid с внешним ключом на `tours`,
 * и кнопка «Написать оператору» писала туда id из `operator_tours` (bigint):
 * 22P02 на каждом создании беседы с карточки тура. `reviews.tour_id` — тот же
 * ключ: отзыв из `POST /api/discovery/reviews` ложился туда, где отзывы о туре
 * не читает никто.
 *
 * Пары «таблица.колонка → tours/bookings» берутся из `docs/DB_SCHEMA.md` —
 * схемы, снятой с настоящего PostgreSQL, — а не из списка в тесте: снимет
 * миграция внешний ключ — пара уйдёт из проверки сама, заведёт новый — войдёт.
 */
function legacyFkColumns(): { pairs: Array<{ table: string; column: string }>; declared: number } {
  const doc = readFileSync(join(ROOT, 'docs/DB_SCHEMA.md'), 'utf-8');
  const pairs: Array<{ table: string; column: string }> = [];
  for (const line of doc.split('\n')) {
    const head = /^\*\*(\w+)\*\* · /.exec(line);
    if (!head) continue;
    const table = head[1];
    // Сами `tours`/`bookings` запрещены целиком проверкой выше.
    if (COMPAT_VIEWS.includes(table)) continue;
    for (const m of line.matchAll(/(\w+) → (tours|bookings)\.id\b/g)) {
      pairs.push({ table, column: m[1] });
    }
  }
  const declared = (doc.match(/^\*\*(\w+)\*\* · .*$/gm) ?? [])
    .filter((l) => !COMPAT_VIEWS.includes(/^\*\*(\w+)\*\*/.exec(l)?.[1] ?? ''))
    .reduce((n, l) => n + (l.match(/ → (?:tours|bookings)\.id\b/g)?.length ?? 0), 0);
  return { pairs, declared };
}

/** Пишет ли исходник колонку `column` таблицы `table`: в списке колонок INSERT или в SET у UPDATE. */
function writesColumn(src: string, table: string, column: string): boolean {
  const col = new RegExp(`(?<![\\w.])"?${column}"?(?!\\w)`);
  const ins = new RegExp(`INSERT\\s+INTO\\s+${tableRe(table)}\\s*\\(([^)]*)\\)`, 'gi');
  for (const m of src.matchAll(ins)) if (col.test(m[1])) return true;
  const upd = new RegExp(
    `UPDATE\\s+(?:ONLY\\s+)?${tableRe(table)}(?:\\s+(?:AS\\s+)?\\w+)?\\s+SET\\b([\\s\\S]*?)(?:\\bWHERE\\b|\\bRETURNING\\b|\\bFROM\\b|[\`']|$)`,
    'gi',
  );
  const set = new RegExp(`(?<![\\w.])"?${column}"?\\s*=`);
  for (const m of src.matchAll(upd)) if (set.test(m[1])) return true;
  return false;
}

describe('колонки-ссылки на tours/bookings не пишутся', () => {
  const { pairs, declared } = legacyFkColumns();

  it('пары прочитаны из схемы все до одной', () => {
    // Ноль пар при непустой схеме — отказ разбора, а не «нарушений нет» (§4.0).
    expect(pairs.length, 'разбор docs/DB_SCHEMA.md разошёлся с числом стрелок на tours/bookings').toBe(declared);
    expect(
      declared,
      'внешних ключей на tours/bookings в схеме не осталось — проверка стала пустой; снять её вместе с этим ожиданием',
    ).toBeGreaterThan(0);
  });

  it('распознаватель колонки видит запись и не путает соседние имена', () => {
    expect(writesColumn('INSERT INTO conversations (type, tour_id) VALUES ($1, $2)', 'conversations', 'tour_id')).toBe(true);
    expect(writesColumn('UPDATE reviews SET tour_id = $1 WHERE id = $2', 'reviews', 'tour_id')).toBe(true);
    expect(writesColumn('INSERT INTO mchs_registrations (operator_booking_id) VALUES ($1)', 'mchs_registrations', 'booking_id')).toBe(false);
    expect(writesColumn('UPDATE conversations SET updated_at = NOW() WHERE id = $1', 'conversations', 'tour_id')).toBe(false);
    expect(writesColumn('INSERT INTO reviews (place_id, rating) VALUES ($1, $2)', 'reviews', 'tour_id')).toBe(false);
  });

  it('ни один файл app/ и lib/ не пишет такую колонку', () => {
    const found: string[] = [];
    for (const file of FILES) {
      const src = code(readFileSync(join(ROOT, file), 'utf-8'));
      for (const { table, column } of pairs) {
        if (writesColumn(src, table, column)) found.push(`${file} → ${table}.${column}`);
      }
    }
    expect(
      found,
      'колонка ссылается на запрещённую tours/bookings (CLAUDE.md §4): ссылку на operator_* заводит миграция колонки, а до неё колонку не писать',
    ).toEqual([]);
  });
});

describe('занятость тура считается по людям', () => {
  it('места занимают участники, а не число заявок', () => {
    // COUNT(*) считал заявки: одна бронь на десятерых занимала одно место из
    // max_group_size. На выходе в поле перебор группы — это гид на четверых
    // с толпой, а не строчка в отчёте.
    // Гейт брони тура — общий (lib/bookings/reserve.ts: readTourDays) с 15.10.
    const src = readFileSync(join(ROOT, 'lib/bookings/reserve.ts'), 'utf-8');
    expect(src).toContain('COALESCE(SUM(b.participants), 0)');
    expect(code(src)).not.toContain('COUNT(*) as bookings');
  });
});
