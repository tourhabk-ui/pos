/**
 * Кейс владельца 24.11–04.12, вторая волна (22.11) — чистые функции, без LLM
 * и без ПД. Движок (сезон тура, пятидневный тур) — planner-owner-case-2211.
 *   2) текст плана из чата/MCP: один раздел «Безопасность и разрешения», без
 *      «Важно»; совет по одежде — один раз; сводка о вулкане — один раз;
 *   3) «Посчитано X из Y позиций» в тексте плана;
 *   4) /trip: погода короткой строкой (plan-weather-planb держит источник);
 *   5) сводки — только о зонах плана, и в шапке /trip тоже.
 */
import { describe, it, expect } from 'vitest';
import type { DayPlan } from '@/lib/planner';
import { formatTripPlanForChat, formatPlanPrice } from '@/lib/kuzmich/trip-plan-tool';
import { clothingAdvice, safetyBlock, shortWeatherLine, SAFETY_BLOCK_TITLE } from '@/lib/planner/day-card-view';
import { estimateGroup } from '@/lib/planner/estimate';
import { placeTouchesZones, planHeaderStatus } from '@/lib/safety/place-zones';
import { warningsForPlanZones } from '@/lib/safety/mchs-bulletin';
import { tourFitsDate } from '@/lib/planner/tour-day-fit';

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Малкинские источники',
  description: '', activityType: 'hot_spring', priceFrom: 0, priceTo: 0,
  coords: [53.25, 158.75], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'easy' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [],
  ...over,
});
const WARM = 'Прогноз для зоны дня: Пасмурно, -18…-9 °C, без осадков, ветер до 3 м/с. Возьмите тёплый слой — флис или пуховку, шапку и перчатки.';
const SNOWY = 'Прогноз для зоны дня: Снег, -14…-2 °C, осадки 6 мм, ветер до 4 м/с. Возьмите непромокаемую обувь и гамаши от снега, тёплый слой — флис или пуховку, шапку и перчатки.';
const MUT_DAY = 'Турпортал края о вулкане Мутновский: не приближаться (источник https://t.me/visitkamchatka41/4983).';
const DIGEST = 'Сводки (МЧС, Турпортал края) о вулканах — Мутновский: не приближаться (сводка на 06:00 19.11–06:00 20.11). Безопасными эти места назвать нельзя.';

const DAYS: DayPlan[] = [
  day({ day: 1, type: 'arrival' as DayPlan['type'], title: 'Прилёт', weatherKit: WARM }),
  day({ day: 2, title: 'Зимняя рыбалка', activityType: 'fishing', weatherKit: SNOWY, dayWarnings: ['Нужен набор группы от 5 чел.: вас 2. Выезд подтверждает оператор.'] }),
  day({ day: 3, title: 'Облёт вулканов Мутновский и Горелый', activityType: 'helicopter', weatherKit: SNOWY, dayWarnings: [MUT_DAY] }),
  day({ day: 4, title: 'Малкинские источники', weatherKit: WARM }),
];

describe('текст плана: один раздел «Безопасность и разрешения»', () => {
  const text = formatTripPlanForChat(DAYS, [DIGEST, 'Территория медведей. Гид с фальшфейером обязателен.'], null, {
    refusal: '', plannedFor: '24 ноября',
    planNotes: ['Северная зона в план не вошла: туров там в ваши даты нет.'],
  });

  it('раздел один, «Важно» нет', () => {
    expect(text.split(`${SAFETY_BLOCK_TITLE}:`)).toHaveLength(2);
    expect(text).not.toContain('Важно:');
    // Строки о самом плане — под днями, не в разделе безопасности.
    expect(text.indexOf('Северная зона в план не вошла')).toBeLessThan(text.indexOf(`${SAFETY_BLOCK_TITLE}:`));
  });

  it('совет по одежде — одной строкой; сводка о Мутновском в разделе — один раз', () => {
    expect(text.match(/Одежда по прогнозу/g)).toHaveLength(1);
    expect(text).toContain('Одежда по прогнозу: возьмите тёплый слой — флис или пуховку, шапку и перчатки (дни 1–4); непромокаемую обувь и гамаши от снега (дни 2–3).');
    const block = text.slice(text.indexOf(`${SAFETY_BLOCK_TITLE}:`));
    expect(block.match(/Мутновский/g)).toHaveLength(1);
    // На самом дне строка о месте программы остаётся.
    expect(text).toContain(`   ! ${MUT_DAY}`);
    expect(block).toContain('Нужен набор группы от 5 чел.: вас 2. Выезд подтверждает оператор. (день 2)');
  });
});

describe('одежда и погода', () => {
  it('одинаковые дни у всех вещей — дни один раз', () => {
    const one = clothingAdvice([day({ day: 1, weatherKit: WARM }), day({ day: 2, weatherKit: WARM })]);
    expect(one).toEqual({ text: 'Одежда по прогнозу: возьмите тёплый слой — флис или пуховку, шапку и перчатки.', days: [1, 2] });
    expect(safetyBlock(DAYS, []).filter((it) => it.text.startsWith('Одежда'))).toHaveLength(1);
  });

  it('короткая строка погоды /trip — как в тексте плана', () => {
    expect(shortWeatherLine(-18, -9, 'Пасмурно')).toBe('−18…−9 °C, пасмурно');
    expect(shortWeatherLine(Number.NaN, 1, 'x')).toBeNull();
  });
});

describe('«Посчитано X из Y позиций» в тексте плана', () => {
  it('строка стоит рядом с итогом', () => {
    const est = estimateGroup([
      { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт' },
      { day: 2, type: 'activity', zone: 'avachinsky', title: 'Рыбалка', priceFrom: 9000, priceTo: 9000, realPrice: 9000, realTour: { tourId: '1', priceUnit: 'per_person', lodgingIncluded: false } },
      { day: 3, type: 'departure', zone: 'avachinsky', title: 'Вылет' },
    ] as never, { adults: 2, children: [], budgetTier: 'comfort' });
    const lines = formatPlanPrice({ tours: [9000, 9000], activityPricing: { tourPriced: 1, open: 0, excluded: 0, unpriced: 0 } } as never, true, est);
    expect(lines.join('\n')).toMatch(/Посчитано 1 из \d+ позиций\./);
  });
});

describe('сводки — только о зонах плана', () => {
  it('вулкан чужой зоны не пишется; своей — пишется; место без привязки — остаётся', () => {
    expect(placeTouchesZones('Вулкан Ключевской: не приближаться', ['avachinsky'])).toBe(false);
    expect(placeTouchesZones('Вулкан Мутновский: не приближаться', ['avachinsky'])).toBe(true);
    expect(placeTouchesZones('Штормовое предупреждение', ['avachinsky'])).toBe(true);
    const ws = [
      { place: 'Ключевской', stems: ['ключевск'] },
      { place: 'Мутновский', stems: ['мутновск'] },
      { place: 'Шивелуч', stems: ['шивелуч'] },
    ];
    expect(warningsForPlanZones(ws, ['avachinsky']).map((w) => w.place)).toEqual(['Мутновский']);
    // Место названо в программе дня — остаётся, какая бы ни была зона.
    expect(warningsForPlanZones(ws, ['avachinsky'], ['МЧС о вулкане Шивелуч: не ближе 10 км']).map((w) => w.place)).toEqual(['Мутновский', 'Шивелуч']);
  });

  it('шапка /trip берёт сводку о зонах плана', () => {
    const status = planHeaderStatus({ data: {
      hasAlert: true, topTitle: 'Вулкан Ключевской: не приближаться',
      feedTitles: ['Вулкан Ключевской: не приближаться', 'Вулкан Мутновский: не приближаться'],
    } }, ['avachinsky']);
    expect(status).toEqual({ title: 'Вулкан Мутновский: не приближаться', hasAlert: true });
  });
});

describe('тур с кончившимся сезоном', () => {
  it('без календаря — не встаёт на день после конца сезона; с календарём — по своим датам', () => {
    const past = { kind: 'request' as const, seasonStart: '2026-06-01', seasonEnd: '2026-09-15', days: 2 };
    expect(tourFitsDate(past, '2026-11-29', '2026-11-22')).toBe(false);
    expect(tourFitsDate({ kind: 'request', seasonStart: null, seasonEnd: null, days: 1 }, '2026-11-29', '2026-11-22')).toBe(true);
    expect(tourFitsDate({ kind: 'dated', dates: new Set(['2026-11-29']) }, '2026-11-29', '2026-11-22')).toBe(true);
  });
});
