// @vitest-environment node
/**
 * Трансфер — машина целиком, не место в ней (владелец 13.10: «у нас не
 * правильная логика бронируют целую машину а не место в ней»).
 *
 * Модуль мест (схема 926: поездки перевозчика с датами и свободными местами)
 * спрятан, а не удалён: таблицы, сервис и роуты остались. Здесь запрет на то,
 * чтобы поверхность, где турист или агент выбирает трансфер, снова потянулась
 * к витрине мест. Что поверхности показывают ВМЕСТО мест — машину под заказ по
 * прайсу перевозчика, — судят рендер и вызов: transfers-page,
 * transfer-card-standard, kuzmich-transfer-search, planner-trip-extras(-ui),
 * planner-plan-choices(-ui), saved-trip-estimate.
 *
 * Регулярка по исходнику — только запрет (CLAUDE.md, «Сторож судит поведение,
 * не текст»): витрины мест, её таблиц и цены места в этих файлах быть не должно.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\s\/\/[^\n]*/g, ' ');
const code = (f: string) => strip(readFileSync(join(process.cwd(), f), 'utf8'));

/** Поверхности выбора трансфера: витрина, страница перевозчика, Кузьмич и MCP, планер, поездка туриста, старый план поездки. */
const SURFACES = [
  'components/transfers/TransfersPage.tsx',
  'app/transfers/(list)/page.tsx',
  'components/transfers/CarrierPage.tsx',
  'lib/transfers/carrier-page.ts',
  'lib/kuzmich/transfer-search.ts',
  'lib/planner/trip-extras-data.ts',
  'app/api/planner/trip-extras/route.ts',
  'app/planner/TripExtrasSection.tsx',
  'lib/planner/plan-choices.ts',
  'lib/planner/estimate.ts',
  'lib/trips/trip-schema.ts',
  'app/hub/tourist/trips/[id]/_TripDetailClient.tsx',
  'app/api/trip/plan/route.ts',
] as const;

const SEAT_SALE: Array<[RegExp, string]> = [
  [/listPublishedTrips/, 'чтение витрины мест'],
  [/\btransfer_trips\b|\btransfer_seat_bookings\b/, 'таблицы мест в поездках'],
  [/price_per_seat|pricePerSeat/, 'цена места'],
  [/руб\/место|₽\/место|за место`/, 'цена «за место» в тексте'],
  [/seatsFree|seats_free/, 'остаток мест в поездке'],
];

describe('поверхности выбора трансфера не продают места', () => {
  it.each(SURFACES)('%s', (f) => {
    const src = code(f);
    for (const [re, what] of SEAT_SALE) expect(src, `${f}: ${what}`).not.toMatch(re);
  });
});
