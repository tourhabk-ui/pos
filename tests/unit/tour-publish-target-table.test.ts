/**
 * #1827: те же четыре UPDATE-в-bookings/tours, что #1814 не касался.
 *
 * `tests/unit/compat-view-writes.test.ts` держит общее правило статическим
 * поиском по всему репозиторию. Этот файл проверяет СПЕЦИФИКУ трёх починенных
 * мест: правильную таблицу И что рядом не осталось имени `tours`/`bookings`
 * в том же запросе.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('PUT /api/bookings/[id] — special_requests пишется в operator_bookings', () => {
  it('UPDATE нацелен на operator_bookings, не на bookings', () => {
    const src = read('app/api/bookings/[id]/route.ts');
    expect(src).toMatch(/UPDATE\s+operator_bookings\s+SET\s+special_requests/);
    expect(src).not.toMatch(/UPDATE\s+bookings\s+SET/);
  });
});

describe('деактивация/публикация тура оператором — пишет operator_tours', () => {
  it('deactivate: UPDATE нацелен на operator_tours', () => {
    const src = read('app/api/operator/tours/[id]/deactivate/route.ts');
    expect(src).toMatch(/UPDATE\s+operator_tours\s+SET\s+is_active\s*=\s*false/i);
    expect(src).not.toMatch(/UPDATE\s+tours\s+SET/);
  });

  it('publish: UPDATE нацелен на operator_tours', () => {
    const src = read('app/api/operator/tours/[id]/publish/route.ts');
    expect(src).toMatch(/UPDATE\s+operator_tours\s+SET\s+is_active\s*=\s*true/i);
    expect(src).not.toMatch(/UPDATE\s+tours\s+SET/);
  });
});

describe('tourService.publish/unpublish (lib/services/tours/tour.service.ts) — живой путь чинится, сирота — нет', () => {
  const SRC = read('lib/services/tours/tour.service.ts');

  it('publish() и unpublish() пишут operator_tours — их реально зовёт /api/discovery/tours/[id]/publish', () => {
    const publishBody = SRC.slice(SRC.indexOf('async publish('), SRC.indexOf('async unpublish('));
    const unpublishBody = SRC.slice(SRC.indexOf('async unpublish('), SRC.indexOf('async getStats('));
    expect(publishBody).toMatch(/UPDATE\s+operator_tours\s+SET\s+is_active\s*=\s*TRUE/);
    expect(unpublishBody).toMatch(/UPDATE\s+operator_tours\s+SET\s+is_active\s*=\s*FALSE/);
  });

  it('update() остаётся объявленным долгом (сирота, колонки не сверены) — не тронут вслепую', () => {
    const updateBody = SRC.slice(SRC.indexOf('async update('), SRC.indexOf('async publish('));
    expect(updateBody, 'если update() починили — заодно проверить сопоставление колонок и убрать из compat-view-writes KNOWN_DEBT')
      .toMatch(/UPDATE\s+tours/);
  });

  it('живой вызывающий publish/unpublish существует — иначе фикс адресован не туда', () => {
    const route = read('app/api/discovery/tours/[id]/publish/route.ts');
    expect(route).toMatch(/tourService\.publish\(/);
    expect(route).toMatch(/tourService\.unpublish\(/);
  });
});
