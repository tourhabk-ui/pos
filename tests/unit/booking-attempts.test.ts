/**
 * Перепись попыток брони: ноль касаний формы — это «не знаю», а не «не пытались».
 *
 * Соблазн здесь прямой: спросили «сколько было попыток», и хочется назвать
 * число. Но попытку меряет только маяк, а он не записал ни строки с миграции
 * 839 (42P08, CLAUDE.md §4.0). Выведи мы попытки из конверсий — получилась бы
 * цифра, за которой не стоит ничего, и следующий читатель принял бы её за
 * замер.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKING_ROUTES } from '@/app/api/cron/booking-attempts/route';

const SRC = readFileSync(join(process.cwd(), 'app/api/cron/booking-attempts/route.ts'), 'utf-8');

describe('попытки не выдумываются', () => {
  it('пустой журнал маяка даёт null, а не ноль', () => {
    expect(SRC).toMatch(/form_touches: beaconRows && beaconRows > 0 \? \(beacon\.value\?\.touches \?\? null\) : null/);
  });

  it('названа дата, с которой счёт честен', () => {
    expect(SRC).toContain('measurable_since');
  });

  it('причина неизмеримости написана словами, а не подразумевается', () => {
    expect(SRC).toContain('why_unmeasurable');
    expect(SRC).toContain('42P08');
  });

  it('сказано, что следа не оставляет: 400, закрытая вкладка, передумал', () => {
    expect(SRC).toContain('not_counted_as_failure');
  });
});

describe('следы разных судеб не складываются в одно число', () => {
  it('созданные, оплаченные и неоплаченные считаются раздельно', () => {
    for (const k of ['bookings_created', 'bookings_paid', 'bookings_unpaid']) {
      expect(SRC).toContain(k);
    }
  });

  it('сорванные пятисоткой — отдельным полем, а не в сумме попыток', () => {
    expect(SRC).toContain('failed_with_500');
    expect(SRC).not.toMatch(/attempts_total|total_attempts/);
  });

  it('возраст неоплаченной брони отдаётся: вчерашняя и полугодовая — разное', () => {
    expect(SRC).toContain('age_hours');
  });
});

describe('перепись только читает и не врёт окном', () => {
  it('ни одного изменяющего запроса', () => {
    expect(SRC).not.toMatch(/\b(INSERT INTO|UPDATE |DELETE FROM)\b/);
  });

  it('окно параметризовано, а не склеено строкой', () => {
    expect(SRC).toMatch(/\(\$1 \|\| ' days'\)::INTERVAL/);
  });

  it('отказ замера даёт null и пишется в лог', () => {
    expect(SRC).toMatch(/console\.error\(`\[booking-attempts\] замер/);
    expect(SRC).toMatch(/meaningful: failures === 0/);
  });
});

describe('список маршрутов брони соответствует коду', () => {
  it('маршрут формы на карточке тура в списке', () => {
    const form = readFileSync(join(process.cwd(), 'components/marketplace/BookingFormClient.tsx'), 'utf-8');
    const used = form.match(/fetch\('(\/api\/[^']+)'/)?.[1];
    expect(used, 'форма брони больше не шлёт на известный адрес').toBeTruthy();
    expect(BOOKING_ROUTES as readonly string[]).toContain(used as string);
  });

  it('каждый маршрут списка существует файлом', () => {
    for (const r of BOOKING_ROUTES) {
      const path = join(process.cwd(), 'app' + r, 'route.ts');
      expect(() => readFileSync(path, 'utf-8'), `нет файла для ${r}`).not.toThrow();
    }
  });
});
