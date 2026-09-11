// @vitest-environment node
/**
 * Сторож: путь туриста не падает на типах (#1769, #1770, #1772, #1773).
 *
 * Прогулка туристом 10.09 по локальной сборке с настоящим PostgreSQL нашла
 * четыре дефекта, каждый из которых ломал свой экран ЦЕЛИКОМ и с момента
 * заведения:
 *   - бронь с карточки тура: id тура (bigint) уходит строкой, схема требовала
 *     number — 400 у всех заявок, оператор не получал ничего;
 *   - «Мои бронирования»: JOIN tour_assets по bigint = uuid — 500, а кабинет
 *     рисовал «Бронирований пока нет»;
 *   - рекомендации: SELECT tour_id из operator_bookings (колонки нет) и
 *     сравнение bigint с text[] — 500, а кабинет рисовал «появятся после
 *     первого бронирования»;
 *   - каталог инструментов: ORDER BY по псевдониму агрегата — 500 всегда.
 *
 * Общий механизм — §4.0: молчащий catch и «пусто» вместо «отказ». Каждый
 * запрос проверен PREPARE на настоящей схеме (baseline + миграции) перед
 * правкой; здесь держится ФОРМА кода, чтобы дефект не вернулся молча.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('бронь с карточки тура (#1769)', () => {
  const src = read('app/api/hub/bookings/create/route.ts');
  it('tour_id принимается и числом, и строкой — id тура bigint, pg отдаёт строку', () => {
    expect(src).toMatch(/tour_id:\s*z\.coerce\.number\(\)\.int\(\)\.positive\(/);
  });
  it('ошибка типа от Zod не уходит туристу по-английски', () => {
    expect(src).toMatch(/first\.code === 'invalid_type'/);
    expect(src).toMatch(/заполнено неверно/);
  });
});

describe('мои бронирования (#1770)', () => {
  // SQL кабинета живёт в lib/tourist/cabinet.ts и гоняется на настоящем
  // PostgreSQL (tests/integration/tourist-cabinet.pg.test.ts); роут только
  // зовёт и оборачивает отказ.
  const sql = stripComments(read('lib/tourist/cabinet.ts'));
  const route = stripComments(read('app/api/bookings/my/route.ts'));
  it('нет JOIN tour_assets: tour_assets.tour_id — uuid, operator_tours.id — bigint', () => {
    expect(sql).not.toMatch(/JOIN\s+tour_assets/);
    expect(route).not.toMatch(/tour_assets/);
    expect(sql).toMatch(/ot\.photos AS tour_photos/);
    expect(route).toMatch(/listMyBookings/);
  });
  it('отказ запроса пишется в лог с SQLSTATE, а не глохнет', () => {
    expect(route).toMatch(/catch \((err|error)\)/);
    expect(route).toMatch(/console\.error\(\s*'\[bookings\/my\]/);
    expect(route).toMatch(/sqlstate/);
  });
});

describe('рекомендации туристу (#1772)', () => {
  const src = stripComments(read('lib/search/tour-recommend.ts'));
  it('история берётся из operator_tour_id — колонки tour_id у operator_bookings нет', () => {
    expect(src).not.toMatch(/SELECT tour_id FROM operator_bookings/);
    expect(src).toMatch(/SELECT operator_tour_id AS tour_id FROM operator_bookings/);
  });
  it('id туров сравниваются как bigint[], text[] остаётся только у категорий', () => {
    // Единственное законное употребление text[] — фильтр activity_type.
    expect(src.match(/\$\d+::text\[\]/g) ?? []).toEqual(['$4::text[]']);
    expect(src).toMatch(/activity_type = ANY\(\$4::text\[\]\)/);
    expect(src).toMatch(/id != ALL\(\$1::bigint\[\]\)/);
    expect(src).toMatch(/id = ANY\(\$1::bigint\[\]\)/);
    expect(src).toMatch(/t\.id != ALL\(\$2::bigint\[\]\)/);
  });
  it('ни одна стратегия не глушит отказ', () => {
    expect(src).not.toMatch(/catch \(err\) \{\s*return \[\];/);
  });
});

describe('каталог инструментов (#1773)', () => {
  const src = stripComments(read('app/api/tools/route.ts'));
  it('сортировка по count(*), не по псевдониму cnt', () => {
    expect(src).not.toMatch(/ORDER BY cnt/);
    expect(src).toMatch(/GROUP BY category ORDER BY count\(\*\) DESC/);
  });
  it('отказ пишется в лог', () => {
    expect(src).toMatch(/console\.error\(\s*'\[tools\]/);
  });
});

describe('кабинет туриста различает отказ и пустоту (§4.0)', () => {
  const src = read('app/hub/tourist/_TouristDashboardClient.tsx');
  it('у бронирований и рекомендаций есть состояние «не удалось загрузить»', () => {
    expect(src).toMatch(/setBookingsFailed\(true\)/);
    expect(src).toMatch(/Не удалось загрузить бронирования/);
    expect(src).toMatch(/setRecsFailed\(true\)/);
    expect(src).toMatch(/Не удалось загрузить рекомендации/);
  });
});
