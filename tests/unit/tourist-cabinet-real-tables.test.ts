/**
 * Кабинет туриста стоит на настоящих таблицах — сторож находок прогулки 10.09
 * (issue #1771, а также форма брони из #1769/#1780 и «Мои бронирования» #1770).
 *
 * Четыре находки из пяти (#1769, #1770, #1772, #1773) параллельно закрыл
 * PR #1781, и его сторож — tests/unit/tourist-path-sql-types.test.ts — здесь
 * не дублируется. Что здесь держится текстом (форма кода), а что — только
 * настоящей базой (`tests/integration/tourist-cabinet.pg.test.ts`), разделено
 * намеренно: текст не докажет, что запрос выполняется, но может запретить
 * возврат известных выдумок — таблиц без DDL и JOIN bigint = uuid.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

describe('форма брони: число уходит числом, выключенная кнопка говорит почему (#1769, #1780)', () => {
  const src = read('components/marketplace/BookingFormClient.tsx');
  it('форма шлёт tour_id числом, а не строкой из базы', () => {
    expect(src).toMatch(/tour_id:\s*Number\(tourId\)/);
  });
  it('английский текст валидатора до туриста не доходит', () => {
    expect(src).toMatch(/Не удалось отправить заявку/);
  });
  it('без даты кнопка выглядит выключенной и объясняет причину', () => {
    expect(src).toMatch(/disabled:opacity-50/);
    expect(src).toMatch(/Сначала выберите дату заезда/);
    expect(src).toMatch(/aria-describedby=/);
  });
});

describe('таблиц семейства tourist_* без DDL в коде больше нет (#1771)', () => {
  const ghosts = ['tourist_trips', 'trip_bookings', 'tourist_reviews', 'tourist_achievements', 'tourist_checklists'];
  it('ни один файл app/ и lib/ их не читает и не пишет', () => {
    const hits: string[] = [];
    for (const f of [...walk('app'), ...walk('lib')]) {
      const src = read(f);
      for (const g of ghosts) if (new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${g}\\b`).test(src)) hits.push(`${f}: ${g}`);
    }
    expect(hits).toEqual([]);
  });

  it('роуты, стоявшие на выдуманных таблицах, удалены', () => {
    for (const p of ['app/api/tourist/trips/route.ts', 'app/api/tourist/achievements/route.ts', 'app/api/tourist/checklists/route.ts']) {
      expect(existsSync(join(ROOT, p)), p).toBe(false);
    }
  });

  it('tourist_wishlist и tourist_notification_preferences объявлены миграцией', () => {
    const files = readdirSync(join(ROOT, 'migrations')).filter((f) => /^949_/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const ddl = files.map((f) => read(`migrations/${f}`)).join('\n');
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS tourist_wishlist/);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS tourist_notification_preferences/);
    // Форма — по живому коду роутов: каждая колонка, которую роут читает, в DDL есть.
    for (const col of ['notify_on_discount', 'notify_on_availability', 'push_recommendations', 'sms_emergency_alerts', 'language', 'timezone']) {
      expect(ddl).toContain(col);
    }
  });
});

describe('«Мои бронирования» — типы совпадают с реальной схемой (#1770)', () => {
  it('в кабинете нет JOIN на tour_assets (uuid) от operator_tours (bigint)', () => {
    for (const f of ['lib/tourist/cabinet.ts', 'app/api/bookings/my/route.ts']) {
      expect(read(f)).not.toMatch(/JOIN\s+tour_assets/);
    }
    expect(read('app/api/bookings/my/route.ts')).toContain('listMyBookings');
  });

  it('роуты кабинета не глушат отказ базы: в catch есть лог с SQLSTATE', () => {
    for (const f of ['app/api/bookings/my/route.ts', 'app/api/tourist/stats/route.ts', 'app/api/tourist/profile/route.ts']) {
      expect(read(f), f).toMatch(/console\.error\([^)]*sqlstate/s);
    }
  });
});
