/**
 * @vitest-environment jsdom
 *
 * Планер: шесть ошибок из внешнего прогона 14.11 (#3347).
 *
 * Проверяющий собрал два плана на проде (10–15.02.2027 и 20–26.07.2027) и
 * описал, что видит человек. Каждая ошибка здесь — вызовом настоящего
 * `recommendTrip` на подменённом хранилище или рендером, без сети и моделей:
 *
 *   а) дни плана отдавались туру, который в план не вставал: блок зоны
 *      растягивался под самый короткий тур, не спрашивая его дату выезда;
 *   б) «рыбалка — Западная зона в план не вошла» при рыбалке в плане;
 *   в) тур с единственным выездом в день прилёта получал совет «переставьте
 *      день плана», который исполнить нельзя;
 *   г) зимний день «Вулканы» шёл с летним советом «ботинки, дождевик»;
 *   д) «проживание 5 ночей» при шести ночах — без объяснения на экране;
 *   е) «Джип +3 000 ₽», «Вертолёт +25 000 ₽» — числа из кода без источника,
 *      и выбор транспорта у дня с туром и у свободного дня в городе.
 *
 * Даты — относительно сегодняшнего дня: тест с зашитым годом — бомба.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Tour {
  tourId: string; title: string; durationHours: number | null; zone: string; activityType: string;
  included?: string[] | null;
}
/** Туры по паре «зона:активность». */
let TOURS: Record<string, Tour[]> = {};
/** Даты выезда с местами по туру. Нет ключа — места на каждый день окна. */
let DATES: Record<string, string[]> = {};
/** Туры без календаря: дату подтверждает оператор. */
let NO_CALENDAR = new Set<string>();
/** Занятия, которые месяц открывают туры без календаря. */
let ON_REQUEST = new Set<string>();

function realTour(t: Tour) {
  return {
    tourId: t.tourId, title: t.title, shortDescription: null,
    operatorName: 'Оператор', operatorSlug: 'op', operatorRating: 0, operatorReviewCount: 0,
    operatorVerified: true, tourRating: null, tourReviewCount: 0, basePrice: 10000, priceUnit: 'per_person',
    maxParticipants: 10, minParticipants: 1,
    durationHours: t.durationHours, multiDayCount: null, difficulty: null,
    weatherDependent: false, seasonStart: null, seasonEnd: null, included: t.included ?? null,
    lat: 53, lng: 158, zone: t.zone, activityType: t.activityType,
  };
}

vi.mock('@/lib/planner/data', () => ({
  createPlannerCache: () => new Map(),
  fetchRealToursForZone: vi.fn(async (zone: string, act: string, limit: number) =>
    (TOURS[`${zone}:${act}`] ?? []).slice(0, limit).map(realTour)),
  fetchAvailabilityForTour: vi.fn(async (tourId: string, from: string, to: string) => {
    if (NO_CALENDAR.has(tourId)) return [];
    const slot = (date: string) => ({ date, availableSlots: 10, bookedSlots: 0, remaining: 10, priceOverride: null });
    if (DATES[tourId]) return DATES[tourId]!.filter((d) => d >= from && d <= to).map(slot);
    const out = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      out.push(slot(new Date(t).toISOString().slice(0, 10)));
    }
    return out;
  }),
  fetchZoneCapacity: vi.fn(async () => ({ tourCount: 0, totalSlots: 0, totalBooked: 0, utilizationPercent: null })),
  fetchContingencyAlternatives: vi.fn(async () => []),
  fetchReviewSignals: vi.fn(async () => null),
  fetchActivitiesBookableInMonth: vi.fn(async () => new Set<string>()),
  fetchActivitiesOnRequest: vi.fn(async () => ON_REQUEST),
  fetchTourKeepsSchedule: vi.fn(async (id: string) => !NO_CALENDAR.has(id)),
  fetchSelfSafety: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/place-load', () => ({
  fetchCandidateLoads: vi.fn(async () => new Map()),
  fetchTourLoads: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/planner/intelligence', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/planner/intelligence')>();
  return { ...real, fetchForecastDays: vi.fn(async () => ({ ok: false, reason: 'test' })) };
});
vi.mock('@/lib/ai/providers', () => ({ callAIWithModelDirect: vi.fn(async () => '') }));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => null }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { recommendTrip, type TripProfile } from '@/lib/planner/engine';
import { legShortfallMessage, zoneLegCost } from '@/lib/planner/zone-leg';
import { edgeOnlyDeparture, offDaysWarning } from '@/lib/planner/tour-day-fit';
import { ACTIVITY_CONSTRAINTS, OFF_SEASON_GEAR_NOTE, activityDayNotes } from '@/lib/planner/constants';
import { estimateGroup, type EstimateDay } from '@/lib/planner/estimate';
import { TransportSelector, dayOffersTransportChoice } from '@/app/planner/_PlannerClient';

const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const trip = (arrival: string, days: number, interests: string[], extra: Partial<TripProfile> = {}): TripProfile => ({
  interests, arrivalDate: arrival, departureDate: addDays(arrival, days - 1),
  adults: 2, children: [], fitnessLevel: 'moderate', budgetTier: 'comfort', ...extra,
});
const text = (rec: Awaited<ReturnType<typeof recommendTrip>>) => rec.warnings.map((w) => w.message).join('\n');
const daysOf = (rec: Awaited<ReturnType<typeof recommendTrip>>, tourId: string) => rec.days.filter((d) => d.realTour?.tourId === tourId);

beforeEach(() => { TOURS = {}; DATES = {}; NO_CALENDAR = new Set(); ON_REQUEST = new Set(); });

describe('а) блок растягивается только под тур, который в этот день выезжает', () => {
  // Девять суток — длиннее блока одной зоны в поездке на две недели с двумя
  // занятиями: без растяжки такой тур не встаёт никогда.
  const LONG: Tour = { tourId: 't-long', title: 'Большой вулканический поход', durationHours: 9 * 24, zone: 'avachinsky', activityType: 'volcano' };
  const TREK: Tour = { tourId: 't-trek', title: 'Тропа за день', durationHours: 10, zone: 'avachinsky', activityType: 'trekking' };
  const ARRIVAL = `${NEXT_YEAR}-07-10`;
  const plan = () => recommendTrip(trip(ARRIVAL, 14, ['volcano', 'trekking'], { travelStyle: 'operator' }));

  beforeEach(() => {
    TOURS['avachinsky:volcano'] = [LONG];
    TOURS['avachinsky:trekking'] = [TREK];
  });

  it('выезд есть в первый день блока — блок растянут, тур стоит целиком, и это сказано', async () => {
    const rec = await plan();
    expect(daysOf(rec, 't-long')).toHaveLength(9);
    expect(text(rec)).toMatch(/«Большой вулканический поход» — 9 дн\.: тур продают целиком, поэтому под него отданы 9 дн\./);
  });

  it('выезд у тура только в этот день — то же самое: календарь из одной даты растяжке не мешает', async () => {
    const start = (await plan()).days.find((d) => d.realTour?.tourId === 't-long')!.day;
    DATES['t-long'] = [addDays(ARRIVAL, start - 1)];
    const rec = await plan();
    expect(daysOf(rec, 't-long')).toHaveLength(9);
    expect(text(rec)).toMatch(/под него отданы 9 дн\./);
  });

  it('выезда в первый день блока нет — блок не растянут, дни туру не отданы, а тур назван с датой выезда', async () => {
    const start = (await plan()).days.find((d) => d.realTour?.tourId === 't-long')!.day;
    // Выезд — на день позже начала блока: девять дней подряд с него в блок
    // уже не ложатся, и тур в план не встаёт.
    const departure = addDays(ARRIVAL, start);
    DATES['t-long'] = [departure];
    const rec = await plan();
    expect(daysOf(rec, 't-long')).toHaveLength(0);
    const said = text(rec);
    // До правки рядом стояли «под него отданы 9 дн.» и «у тура нет выезда».
    expect(said).not.toMatch(/тур продают целиком, поэтому под него отданы/);
    expect(said).toMatch(/Большой вулканический поход/);
    expect(rec.warnings.some((w) => w.type === 'tour_dates' || w.type === 'duration')).toBe(true);
  });
});

describe('б) «зона в план не вошла» говорит, что занятие в плане всё же есть', () => {
  const cost = zoneLegCost('avachinsky', 'western');

  it('занятие обслужено в другой зоне — так и сказано, совета «выберите ближе к городу» нет', () => {
    const msg = legShortfallMessage('western', cost, 2, ['рыбалка'], ['рыбалка']);
    expect(msg).toMatch(/^Рыбалка — Западная зона в план не вошла: на неё нужно 3 дня/);
    expect(msg).toContain('Рыбалка в плане есть — в другой зоне.');
    expect(msg).toContain('Хотите именно сюда — добавьте дни к поездке.');
    expect(msg).not.toContain('выберите занятие ближе к городу');
  });

  it('занятия в плане нет — прежний совет остаётся, и «в плане есть» не говорится', () => {
    const msg = legShortfallMessage('western', cost, 2, ['рыбалка'], []);
    expect(msg).toContain('Добавьте дни к поездке или выберите занятие ближе к городу.');
    expect(msg).not.toContain('в плане есть');
  });

  it('из двух занятий зоны в плане одно — названо оно, совет остаётся для второго', () => {
    const msg = legShortfallMessage('western', cost, 2, ['рыбалка', 'сплав'], ['рыбалка']);
    expect(msg).toContain('Рыбалка в плане есть — в другой зоне.');
    expect(msg).toContain('выберите занятие ближе к городу');
    expect(msg).not.toMatch(/Сплав в плане есть/);
  });

  it('занятие, которого в этой зоне не просили, «обслуженным» не называется', () => {
    expect(legShortfallMessage('western', cost, 2, ['рыбалка'], ['вулканы'])).not.toContain('в плане есть');
  });

  it('движок: рыболовный тур стоит в Авачинской зоне — строка о Западной зоне это говорит', async () => {
    TOURS['avachinsky:volcano'] = [{ tourId: 't-volc', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' }];
    TOURS['avachinsky:fishing'] = [{ tourId: 't-fish-near', title: 'Рыбалка у города', durationHours: 10, zone: 'avachinsky', activityType: 'fishing' }];
    TOURS['western:fishing'] = [{ tourId: 't-fish-west', title: 'Рыбалка на западе', durationHours: 10, zone: 'western', activityType: 'fishing' }];
    const rec = await recommendTrip(trip(`${NEXT_YEAR}-07-10`, 5, ['fishing', 'volcano']));
    const leg = rec.warnings.find((w) => w.type === 'zone_days' && /Западная зона в план не вошла/.test(w.message));
    // Сценарий держит правило только там, где зона и правда не вошла, а
    // рыбалка в плане есть; иначе проверять нечего — и это отказ теста.
    expect(leg, 'Западная зона вошла в план — сценарий не воспроизводит случай').toBeDefined();
    expect(rec.days.some((d) => d.type === 'activity' && d.activityType === 'fishing'), 'рыбалки в плане нет').toBe(true);
    expect(leg!.message).toContain('в плане есть — в другой зоне');
    expect(leg!.severity).toBe('info');
    expect(leg!.message).toMatch(/^[А-ЯЁ]/);
  });
});

describe('в) выезд тура в день прилёта назван причиной', () => {
  const edges = { arrival: '2027-07-20', departure: '2027-07-26' };

  it('единственный выезд — в день прилёта: сказано это, совета «переставьте день» нет', () => {
    const msg = offDaysWarning([{ title: 'Летняя рыбалка на чавычу', dates: ['2027-07-20'] }], edges)!;
    expect(msg).toContain('«Летняя рыбалка на чавычу» (выезд 20 июля — день прилёта)');
    expect(msg).toContain('сдвиньте даты поездки или спросите оператора о другой дате');
    expect(msg).not.toContain('переставьте день плана');
  });

  it('выезды в день прилёта и в день вылета — названы оба', () => {
    expect(edgeOnlyDeparture(['2027-07-20', '2027-07-26'], edges)).toBe('both');
    expect(offDaysWarning([{ title: 'Тур', dates: ['2027-07-20', '2027-07-26'] }], edges)).toContain('дни прилёта и вылета');
    expect(offDaysWarning([{ title: 'Тур', dates: ['2027-07-26'] }], edges)).toContain('день вылета');
  });

  it('есть выезд и в обычный день — причина прежняя: день можно переставить', () => {
    expect(edgeOnlyDeparture(['2027-07-20', '2027-07-23'], edges)).toBeNull();
    const msg = offDaysWarning([{ title: 'Тур', dates: ['2027-07-20', '2027-07-23'] }], edges)!;
    expect(msg).toContain('переставьте день плана на дату выезда');
    expect(msg).not.toContain('день прилёта');
  });

  it('у местного дня прилёта нет — его первый день причиной не называется', () => {
    expect(edgeOnlyDeparture(['2027-07-20'], { arrival: null, departure: null })).toBeNull();
    expect(offDaysWarning([{ title: 'Тур', dates: ['2027-07-20'] }])).toContain('переставьте день плана');
  });

  it('движок: тур с выездом только в день прилёта в план не встаёт, и причина — день прилёта', async () => {
    const ARRIVAL = `${NEXT_YEAR}-07-20`;
    TOURS['avachinsky:fishing'] = [{ tourId: 't-fish', title: 'Летняя рыбалка на чавычу', durationHours: 10, zone: 'avachinsky', activityType: 'fishing' }];
    DATES['t-fish'] = [ARRIVAL];
    const rec = await recommendTrip(trip(ARRIVAL, 7, ['fishing']));
    expect(daysOf(rec, 't-fish')).toHaveLength(0);
    const said = text(rec);
    expect(said).toContain('«Летняя рыбалка на чавычу» (выезд 20 июля — день прилёта)');
    expect(said).not.toContain('переставьте день плана');
  });
});

describe('г) совет по снаряжению — только в сезон занятия', () => {
  const volcano = ACTIVITY_CONSTRAINTS.volcano!;
  const GEAR = 'Обязательны: трекинговые ботинки, дождевик, слои одежды';

  it('в сезон совет есть, вне сезона вместо него сказано, что снаряжение назовёт оператор', () => {
    expect(volcano.months).toContain(7);
    expect(volcano.months).not.toContain(2);
    expect(activityDayNotes(volcano, 7)).toContain(GEAR);
    expect(activityDayNotes(volcano, 7)).not.toContain(OFF_SEASON_GEAR_NOTE);
    expect(activityDayNotes(volcano, 2)).toContain(OFF_SEASON_GEAR_NOTE);
    expect(activityDayNotes(volcano, 2)).not.toContain(GEAR);
  });

  it('совет о гиде от сезона не зависит', () => {
    for (const m of [2, 7]) expect(activityDayNotes(volcano, m)).toContain('Рекомендуется гид — активная вулканическая зона');
  });

  it('у занятия без сезонного совета вне сезона ничего не добавляется', () => {
    const bears = ACTIVITY_CONSTRAINTS.bears!;
    expect(activityDayNotes(bears, 2)).toEqual(bears.safetyNotes);
  });

  it('движок: февральский день «Вулканы» по туру без календаря идёт без летнего совета', async () => {
    TOURS['avachinsky:volcano'] = [{ tourId: 't-winter', title: 'Зимний выход к вулкану', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' }];
    NO_CALENDAR = new Set(['t-winter']);
    ON_REQUEST = new Set(['volcano']);
    const rec = await recommendTrip(trip(`${NEXT_YEAR}-02-10`, 6, ['volcano'], { travelStyle: 'operator' }));
    const day = daysOf(rec, 't-winter')[0];
    expect(day, 'тур без календаря в план не встал — сценарий не воспроизводит случай').toBeDefined();
    expect(day!.dayWarnings).toContain(OFF_SEASON_GEAR_NOTE);
    expect(day!.dayWarnings.join('\n')).not.toContain('дождевик');
  });

  it('движок: июльский день «Вулканы» совет по снаряжению сохраняет', async () => {
    TOURS['avachinsky:volcano'] = [{ tourId: 't-summer', title: 'Вулкан за день', durationHours: 10, zone: 'avachinsky', activityType: 'volcano' }];
    const rec = await recommendTrip(trip(`${NEXT_YEAR}-07-10`, 5, ['volcano'], { travelStyle: 'operator' }));
    const day = daysOf(rec, 't-summer')[0];
    expect(day).toBeDefined();
    expect(day!.dayWarnings).toContain(GEAR);
  });
});

describe('д) ночи, включённые в тур, названы числом', () => {
  const planDay = (day: number, type: EstimateDay['type'], extra: Partial<EstimateDay> = {}): EstimateDay => ({
    day, type, zone: 'avachinsky', title: `День ${day}`, priceFrom: 0, priceTo: 0, ...extra,
  });
  const inTour = { tourId: 't-base', priceUnit: 'per_person', lodgingIncluded: true as const };
  const estimate = (days: EstimateDay[]) => estimateGroup(days, { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' });

  it('тур в три дня с проживанием: в строках проживания на две ночи меньше, и это сказано', () => {
    const est = estimate([
      planDay(1, 'arrival'),
      planDay(2, 'activity', { realPrice: 60000, realTour: inTour }),
      planDay(3, 'activity', { realTour: inTour }),
      planDay(4, 'activity', { realTour: inTour }),
      planDay(5, 'activity'),
      planDay(6, 'departure'),
    ]);
    // Ночей в поездке пять; две из них — внутри тура (N дней — N−1 ночей).
    const lodging = est.lines.filter((l) => l.kind === 'lodging');
    expect(lodging.map((l) => l.basis)).toEqual(['3 ночи × 2 чел.']);
    expect(est.assumptions).toContain('В строках проживания нет 2 ночей: они входят в цену тура.');
  });

  it('одна такая ночь — в единственном числе', () => {
    const est = estimate([
      planDay(1, 'arrival'),
      planDay(2, 'activity', { realPrice: 40000, realTour: inTour }),
      planDay(3, 'activity', { realTour: inTour }),
      planDay(4, 'departure'),
    ]);
    expect(est.assumptions).toContain('В строках проживания нет 1 ночи: она входит в цену тура.');
  });

  it('туров с проживанием нет — строки нет', () => {
    const est = estimate([planDay(1, 'arrival'), planDay(2, 'activity'), planDay(3, 'departure')]);
    expect(est.assumptions.join('\n')).not.toContain('В строках проживания нет');
  });
});

describe('е) выбор транспорта дня: без цен из кода и только там, где он есть', () => {
  it('у кнопок нет цен: ни «₽», ни «+» в подписи', () => {
    render(<TransportSelector selected="walking" onChange={() => {}} allowed={['walking', 'jeep', 'helicopter']} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('title'))).toEqual(['Пешком', 'Джип', 'Вертолёт']);
    for (const b of buttons) expect(b.getAttribute('title')).not.toMatch(/₽|\+|\d/);
  });

  it('выбор — из разрешённого дню, а не из всего, что бывает в зоне', () => {
    render(<TransportSelector selected="walking" onChange={() => {}} allowed={['walking', 'jeep']} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('title'))).toEqual(['Пешком', 'Джип']);
    expect(screen.queryByTitle('Вертолёт')).toBeNull();
  });

  it('выбирать не из чего — селектора нет', () => {
    const { container } = render(<TransportSelector selected="jeep" onChange={() => {}} allowed={['jeep']} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('у дня с туром выбора нет; у дня без тура с двумя видами транспорта — есть', () => {
    const tour = { tourId: 't' } as never;
    expect(dayOffersTransportChoice({ type: 'activity', realTour: tour, allowedTransports: ['jeep', 'helicopter'] }, false)).toBe(false);
    expect(dayOffersTransportChoice({ type: 'activity', allowedTransports: ['walking', 'jeep'] }, false)).toBe(true);
    expect(dayOffersTransportChoice({ type: 'activity', allowedTransports: ['walking', 'jeep'] }, undefined)).toBe(true);
    expect(dayOffersTransportChoice({ type: 'activity', allowedTransports: ['jeep'] }, false)).toBe(false);
    expect(dayOffersTransportChoice({ type: 'activity', allowedTransports: ['walking', 'jeep'] }, true)).toBe(false);
    expect(dayOffersTransportChoice({ type: 'rest', allowedTransports: ['walking', 'jeep'] }, false)).toBe(false);
  });

  it('запрет: надбавок за транспорт в коде экрана больше нет', () => {
    const src = readFileSync(join(process.cwd(), 'app/planner/_PlannerClient.tsx'), 'utf-8');
    expect(src).not.toMatch(/priceAdd\s*:/);
  });
});

describe('мелочи экрана из того же прогона', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

  it('вилка цены в строке сметы — тем же тире, что в её сумме и на карточке дня', () => {
    const est = estimateGroup(
      [
        { day: 1, type: 'arrival', zone: 'avachinsky', title: 'Прилёт', priceFrom: 0, priceTo: 0 },
        { day: 2, type: 'activity', zone: 'avachinsky', title: 'День у океана', priceFrom: 4000, priceTo: 12000 },
        { day: 3, type: 'departure', zone: 'avachinsky', title: 'Вылет', priceFrom: 0, priceTo: 0 },
      ],
      { adults: 2, children: [], budgetTier: 'comfort', tripOrigin: 'visitor' },
    );
    const line = est.lines.find((l) => l.kind === 'activity');
    // Разряды в числе — неразрывным пробелом: сверяем по виду, не по байту.
    expect(line?.basis).toMatch(/^4\s000 — 12\s000 ₽ × 2 чел\.$/);
  });

  it('«Поделиться» в MAX несёт ссылку на маршрут, как и в Telegram', async () => {
    const { maxShareUrl, telegramShareUrl } = await import('@/lib/trips/share-links');
    const url = 'https://vedarai.ru/trip/abc';
    const max = new URL(maxShareUrl(url, 'Маршрут — 6 дней по Камчатке'));
    expect(max.origin + max.pathname).toBe('https://max.ru/:share');
    expect(max.searchParams.get('text')).toBe(`Маршрут — 6 дней по Камчатке\n${url}`);
    const tg = new URL(telegramShareUrl(url, 'Маршрут'));
    expect(tg.searchParams.get('url')).toBe(url);
    expect(tg.searchParams.get('text')).toBe('Маршрут');
  });

  it('запрет: в панелях «Поделиться» кнопка MAX не ведёт в чат бота', () => {
    // Чат Кузьмича — не «поделиться»: ссылка на маршрут в него не попадает.
    for (const p of ['app/planner/_PlannerClient.tsx', 'app/trip/[token]/_TripShareClient.tsx']) {
      expect(read(p), p).not.toMatch(/KUZMICH_MAX_URL/);
    }
  });

  it('запрет: «Вулкан» в единственном числе подписью занятия больше не стоит', () => {
    expect(read('app/planner/_PlannerClient.tsx')).not.toMatch(/volcano:\s*'Вулкан'/);
  });
});
