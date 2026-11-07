// @vitest-environment node
/**
 * Смета плана в ответе Кузьмича — из вывода инструмента, дословно (ai-debug run 23).
 *
 * На «Составь план на 5 дней в июле 2027 для двоих: рыбалка, вулкан, жильё и
 * машина» живой Кузьмич 07.11 ответил планом по дням без сметы и с припиской
 * «Цену, которой нет в данных этого ответа, не называю». Смету пишет
 * make_trip_plan, а модель её пересказывает: пересказ не той подписью или с
 * округлением сверка цен вырезает (#3126), и человек остаётся без цены.
 * Проверка — вызовом `checkAnswerPrices` на выводе настоящего форматтера плана.
 */
import { describe, it, expect } from 'vitest';
import { checkAnswerPrices, planEstimateBlock, PRICE_CUT_NOTE } from '@/lib/kuzmich/answer-quality';
import { formatPlanPrice, formatTripPlanForChat } from '@/lib/kuzmich/trip-plan-tool';
import type { DayPlan } from '@/lib/planner';
import type { PriceBreakdown } from '@/lib/planner/estimate';

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Авачинский вулкан',
  description: '', activityType: 'volcano', priceFrom: 18000, priceTo: 18000, realPrice: 18000,
  coords: [53.25, 158.75], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'moderate' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [],
  ...over,
});

const PB: PriceBreakdown = {
  activities: [46000, 52000], accommodation: [16000, 24000], transport: [2500, 5000],
  perPersonTotal: [64500, 81000],
  activityPricing: { tourPriced: 2, estimated: 0, excluded: 0 },
};

/** Вывод make_trip_plan: дни, пустая строка, смета, пустая строка, «Важно». */
const PLAN_OUTPUT = formatTripPlanForChat(
  [day({}), day({ day: 2, title: 'Рыбалка на чавычу', activityType: 'fishing', realPrice: 28000, priceFrom: 28000, priceTo: 28000 })],
  ['5 дней для Камчатки мало.'],
  null,
  { refusal: '', plannedFor: '10 июля 2027', priceLines: formatPlanPrice(PB, 'comfort', true) },
);
const ESTIMATE = formatPlanPrice(PB, 'comfort', true);
const PLAN_RUN = { name: 'make_trip_plan', producedData: true, output: PLAN_OUTPUT };

/** Ответ модели: план по дням, смета пересказом с округлением — её сверка вырежет. */
const RETOLD = [
  'Собрал план на 5 дней, июль 2027, двое взрослых.',
  'День 1. Восхождение на Авачинский вулкан — 18 000 ₽.',
  'День 2. Рыбалка на чавычу — 28 000 ₽.',
  'Ориентир на человека: около 65 000 – 80 000 ₽.',
  'Хотите сдвинуть даты?',
].join('\n');

describe('смета плана — из вывода инструмента', () => {
  it('вывод плана несёт смету отдельным блоком', () => {
    expect(planEstimateBlock([PLAN_RUN])).toEqual(ESTIMATE);
  });

  it('пересказ сметы вырезан — на его месте смета инструмента дословно, до приписки сверки', () => {
    const out = checkAnswerPrices(RETOLD, [PLAN_RUN]);
    expect(out).not.toContain('около 65 000');
    for (const line of ESTIMATE) expect(out).toContain(line);
    expect(out).toContain('День 2. Рыбалка на чавычу — 28 000 ₽.');
    // Приписка сверки остаётся последней: вырезанное было, и это сказано.
    expect(out.trimEnd().endsWith(PRICE_CUT_NOTE)).toBe(true);
    expect(out.indexOf(ESTIMATE[0]!)).toBeLessThan(out.indexOf(PRICE_CUT_NOTE));
  });

  it('вилка на человека и на группу одной строкой (как писала модель в run 22) — смета инструмента на месте', () => {
    // Числа на человека в источнике есть, но строка источника несёт одну вилку,
    // а строка ответа — две: сверка #3126 вырезает строку целиком.
    const merged = 'День 1. Восхождение на Авачинский вулкан — 18 000 ₽.\nОриентир на человека: 64 500–81 000 ₽ (уровень «комфорт»). На группу из двоих: 129 000–162 000 ₽.';
    const out = checkAnswerPrices(merged, [PLAN_RUN]);
    expect(out).not.toContain('129 000');
    expect(out).toContain(ESTIMATE[0]);
    expect(out).toContain(PRICE_CUT_NOTE);
  });

  it('модель сметы не написала — смета дописана в конец, приписки нет', () => {
    const answer = 'Собрал план на 5 дней.\nДень 1. Восхождение на Авачинский вулкан — 18 000 ₽.';
    const out = checkAnswerPrices(answer, [PLAN_RUN]);
    expect(out.startsWith(answer)).toBe(true);
    expect(out.endsWith(ESTIMATE.join('\n'))).toBe(true);
    expect(out).not.toContain(PRICE_CUT_NOTE);
  });

  it('смета переписана дословно — второй раз не ставится', () => {
    const answer = `Собрал план.\n${ESTIMATE[0]}`;
    expect(checkAnswerPrices(answer, [PLAN_RUN])).toBe(answer);
  });

  it('плана в ходе нет — смету взять неоткуда, ответ только сверен', () => {
    const tours = { name: 'get_tours', producedData: true, output: 'Ориентир на человека: 64 500 ₽–81 000 ₽ — не план' };
    expect(checkAnswerPrices('Туры на вулканы есть.', [tours])).toBe('Туры на вулканы есть.');
    expect(checkAnswerPrices('Туры на вулканы есть.', null)).toBe('Туры на вулканы есть.');
  });

  it('у последнего плана хода сметы нет — смета прежнего плана не приставляется', () => {
    const refused = { name: 'edit_trip_plan', producedData: true, output: 'Не собрал план по этим параметрам.' };
    expect(planEstimateBlock([PLAN_RUN, refused])).toEqual([]);
    expect(checkAnswerPrices('План не пересобран.', [PLAN_RUN, refused])).toBe('План не пересобран.');
  });
});
