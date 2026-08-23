/**
 * Переброс брони переназначается в operator_bookings, а не в легаси-bookings.
 *
 * Находка прочёса 23.08 оказалась настоящей, но ошиблась в механизме. Она
 * ждала «бронь не переназначается, данные теряются, комиссия начисляется за
 * несуществующее действие». На деле хуже и чище: тот же `transfer.booking_id`
 * читается из `operator_bookings`, где `id` — bigint, а `bookings.id` — uuid.
 * Постгрес отвечал на это ошибкой типа, и вся транзакция — вместе с двумя
 * записями в `payouts` — откатывалась.
 *
 * То есть приём переброса С УКАЗАННЫМ целевым туром не работал никогда.
 * Без `targetTourId` ветка не выполнялась, и потому дефект не был виден:
 * половина сценария работала, и отказ выглядел случайным.
 *
 * Сторож держит свойство «читаем и пишем одну таблицу», а не расположение
 * строк: расхождение чтения и записи по одному ключу — и есть корень.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = [
  'app/api/operator/transfer-booking/[id]/accept/route.ts',
  'app/api/operator/transfer-booking/route.ts',
];

/** Только код: в комментариях легаси-таблица законно названа по имени. */
const codeOf = (p: string) =>
  readFileSync(join(process.cwd(), p), 'utf-8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('переброс брони пишет в ту же таблицу, из которой читает', () => {
  for (const file of FILES) {
    it(`${file}: записи в легаси-bookings нет`, () => {
      const code = codeOf(file);
      expect(code, 'вернулась запись в bookings — ключ uuid против bigint, транзакция откатится')
        .not.toMatch(/UPDATE\s+bookings\b/i);
    });

    it(`${file}: переназначение идёт в operator_bookings.operator_tour_id`, () => {
      const code = codeOf(file);
      expect(code).toMatch(/UPDATE\s+operator_bookings[\s\S]{0,80}operator_tour_id\s*=\s*\$\d/i);
    });

    it(`${file}: бронь читается из operator_bookings тем же ключом`, () => {
      const code = codeOf(file);
      expect(code).toMatch(/FROM\s+operator_bookings/i);
    });
  }
});

describe('cron-секрет сравнивается постоянным временем', () => {
  // Обычное === завершается на первом различающемся байте и утекает секрет
  // по времени ответа. Две копии этой ошибки остались в лид-роутах, когда
  // остальные cron-роуты уже перешли на timingSafeCompare.
  const SECRET_ROUTES = [
    'app/api/admin/leads/list/route.ts',
    'app/api/admin/leads/process-batch/route.ts',
    'app/api/admin/max-send/route.ts',
  ];

  for (const file of SECRET_ROUTES) {
    it(`${file}: без обычного сравнения строк`, () => {
      const code = codeOf(file);
      expect(code, 'секрет снова сравнивается посимвольно')
        .not.toMatch(/(?:headerSecret|provided|authorization)\s*(?:===|!==)\s*(?:cronSecret|process\.env\.CRON_SECRET)/);
    });
  }
});
