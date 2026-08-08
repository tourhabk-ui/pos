/**
 * Слоты групповых туров: занятость считается по реальной колонке (evo #55e7c991).
 *
 * Дефект: в одном запросе к operator_bookings занятость считалась по
 * b.participants, а spots_left — по несуществующей b.guests_count. Любой
 * запрос слотов группового тура падал SQL-ошибкой в 500 — выбор даты для
 * групповых туров был недоступен.
 *
 * guests_count — колонка ДРУГИХ таблиц (agent_bookings, миграция 054; legacy
 * bookings через алиас, миграция 132). У operator_bookings есть только
 * participants (миграция 040). Сторож держит запросы этого роута на реальной
 * колонке и не даёт опечатке вернуться.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'app/api/tours/[id]/time-slots/route.ts'),
  'utf-8',
);

describe('слоты групповых туров считают по operator_bookings.participants', () => {
  it('в роуте нет обращений к guests_count — у operator_bookings такой колонки нет', () => {
    expect(SRC).not.toMatch(/guests_count/);
  });

  it('и занятость, и spots_left считаются по participants', () => {
    const sums = SRC.match(/SUM\(b\.participants\)/g) ?? [];
    expect(sums.length, 'обе агрегации должны идти по participants').toBeGreaterThanOrEqual(2);
  });
});
