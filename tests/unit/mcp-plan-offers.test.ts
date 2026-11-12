/**
 * Жильё и машина к плану в ответе make_trip_plan (аудит планировщика 07.11,
 * заявка 4.3 в #3076). Пруф с прода 06.11: на «план на 5 дней, жильё и
 * машина» в ответе стоял только ориентир цены сметы.
 *
 * Проверяется тем путём, которым ходят агент и человек: POST роута MCP и
 * исполнитель Кузьмича в чате. Движок плана и подбор вариантов подменены;
 * ночи, стоянки, слова и путь заявки — настоящие.
 *
 *  - подбор тот же, что у экрана планера: стоянки по зонам ночёвки, ночи в
 *    турах с проживанием не ищутся, гости — весь состав плана;
 *  - номер жилья бронируется на карточке по ссылке с датами стоянки, гостями
 *    и номером; агенту сказано, что create_stay_request такие объекты не
 *    принимает;
 *  - машина и прокат: агенту — инструмент заявки с plan_id, человеку в чате —
 *    форма на странице партнёра, без инструментов, которых у чата нет;
 *  - три исхода у каждого раздела; сбой сборки блока план не роняет и
 *    молча не пропадает.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { DayPlan } from '@/lib/planner/engine';
import type { ZoneId } from '@/lib/planner/constants';

const PLAN_ID = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const ROOM = '7f1e2d3c-4b5a-4968-8776-655443322110';
const STAY_A = 'a0000000-0000-4000-8000-000000000001';
const STAY_B = 'a0000000-0000-4000-8000-000000000002';

function day(n: number, type: DayPlan['type'], zone: ZoneId, lodgingIncluded?: boolean | null): DayPlan {
  return {
    day: n, type, zone, title: `День ${n}`, description: '', activityType: type === 'activity' ? 'volcano' : 'rest',
    priceFrom: 0, priceTo: 0, coords: [53, 158], defaultTransport: 'walking', allowedTransports: ['walking'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
    ...(lodgingIncluded !== undefined ? {
      realTour: {
        tourId: '51', operatorName: 'Оператор', operatorSlug: 'operator', operatorRating: 0, tourRating: null,
        reviewCount: 0, verified: true, maxParticipants: 10, weatherDependent: false, durationHours: null,
        priceUnit: 'per_person', lodgingIncluded,
      },
    } : {}),
  };
}

/**
 * План на 10–14 июля 2027: две ночи в Авачинской зоне, двухдневный тур с
 * проживанием в Восточной (дни 3–4: ночь между ними — в туре), ночь после
 * последнего дня тура — в Восточной (тур её не покрывает, #3199, Б32), день
 * отъезда.
 */
const DAYS: DayPlan[] = [
  day(1, 'arrival', 'avachinsky'),
  day(2, 'activity', 'avachinsky', false),
  day(3, 'activity', 'eastern', true),
  day(4, 'activity', 'eastern', true),
  day(5, 'departure', 'avachinsky'),
];

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
}));

const { recommendMock } = vi.hoisted(() => ({ recommendMock: vi.fn() }));
vi.mock('@/lib/planner', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, recommendTrip: (...a: unknown[]) => recommendMock(...a) };
});

const x = vi.hoisted(() => ({ lodging: vi.fn(), byRequest: vi.fn(), unzoned: vi.fn(), charter: vi.fn(), rental: vi.fn() }));
vi.mock('@/lib/planner/trip-extras-data', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findLodgingForStay: (...a: unknown[]) => x.lodging(...a),
  findRequestLodgingForStay: (...a: unknown[]) => x.byRequest(...a),
  countUnzonedPublicLodging: (...a: unknown[]) => x.unzoned(...a),
  findCharterOffers: (...a: unknown[]) => x.charter(...a),
  findCarRentalOffers: (...a: unknown[]) => x.rental(...a),
}));

// Прайс проката для проверки настоящего findCarRentalOffers (пауза сайта).
const { rentalCompanies } = vi.hoisted(() => ({ rentalCompanies: vi.fn() }));
vi.mock('@/lib/rental/rental', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rental/rental-format')>('@/lib/rental/rental-format');
  return { ...actual, loadRentalCompanies: (...a: unknown[]) => rentalCompanies(...a) };
});

import { POST } from '@/app/api/mcp/route';
import { executeKuzmichTool } from '@/lib/kuzmich/core';

function dbReply(sql: string): { rows: unknown[] } {
  if (sql.includes('INSERT INTO mcp_handoffs')) return { rows: [{ id: '0b10231b-063c-4d6d-8778-8e18486b6fa4' }] };
  if (sql.includes('INSERT INTO trip_plan_drafts')) return { rows: [{ id: PLAN_ID }] };
  return { rows: [] };
}

let ipSeq = 0;
async function mcpPlan(args: Record<string, unknown>): Promise<string> {
  ipSeq += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.44.0.${ipSeq}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'make_trip_plan', arguments: args } }),
  }));
  const json = await res.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  expect(json.result.isError).toBeUndefined();
  return json.result.content[0]!.text;
}

const PLAN_ARGS = { days: '5', interests: 'вулканы', when: '2027-07-10', adults: '4', children: '[8]' };

/** Блок вариантов — от его заголовка до строки ID плана. */
function offersBlock(text: string): string {
  const from = text.indexOf('Жильё и машина к этому плану');
  expect(from).toBeGreaterThan(-1);
  const to = text.indexOf('ID плана', from);
  return text.slice(from, to === -1 ? undefined : to);
}

const plain = (s: string) => s.replace(/[  ]/g, ' ');

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  query.mockReset().mockImplementation(async (sql: string) => dbReply(sql));
  recommendMock.mockReset().mockResolvedValue({
    days: DAYS,
    warnings: [],
    priceBreakdown: {
      activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0],
      activityPricing: { tourPriced: 0, estimated: 0, excluded: 0 },
    },
    itinerary: '', catalogueOpen: null,
  });
  x.lodging.mockReset().mockImplementation(async (stay: { zone: string }) => stay.zone === 'avachinsky'
    ? {
      state: 'ok',
      items: [
        {
          id: STAY_A, name: 'Кутха', type: 'guesthouse', priceFrom: 9000, rating: null, reviewCount: 0, isVerified: true,
          stay: { kind: 'priced', total: 42000, rooms: 2, roomId: ROOM, roomName: 'Стандарт', maxGuests: 3 },
        },
        {
          id: STAY_B, name: 'Вилюй', type: 'hotel', priceFrom: null, rating: null, reviewCount: 0, isVerified: false,
          stay: { kind: 'no_fit', people: 5 },
        },
      ],
    }
    : { state: 'empty' });
  x.byRequest.mockReset().mockResolvedValue({ state: 'empty' });
  x.unzoned.mockReset().mockResolvedValue(0);
  x.charter.mockReset().mockResolvedValue({
    state: 'ok',
    items: [{ slug: 'shatun', name: 'Шатун', fleet: 'вахтовка, 26 мест', priceFromRub: 75000, destinations: 3, hourRub: null, dayRub: null, ratesFrom: false }],
  });
  x.rental.mockReset().mockResolvedValue({
    state: 'ok',
    items: [{ slug: 'laguna-prokat', name: 'Лагуна Прокат', offers: 3, priceFromRub: 5000, driverOptional: false }],
  });
});

describe('make_trip_plan по MCP: жильё и машина к плану', () => {
  it('стоянки по зонам ночёвки, ночь в туре с проживанием не ищется, гости — весь состав плана', async () => {
    await mcpPlan(PLAN_ARGS);
    expect(x.lodging.mock.calls.map((c) => c[0])).toEqual([
      { zone: 'avachinsky', checkIn: '2027-07-10', checkOut: '2027-07-12', nights: 2 },
      { zone: 'eastern', checkIn: '2027-07-13', checkOut: '2027-07-14', nights: 1 },
    ]);
    // Четверо взрослых и ребёнок — пять мест.
    expect(x.lodging.mock.calls.map((c) => c[1])).toEqual([5, 5]);
  });

  it('номер — ссылкой на карточку с датами стоянки, гостями и номером; цена на группу; create_stay_request не предлагается', async () => {
    const block = plain(offersBlock(await mcpPlan(PLAN_ARGS)));
    expect(block).toContain('Жильё — Авачинская зона, 10.07 — 12.07 (2 ночи):');
    expect(block).toContain('«Кутха», гостевой дом, проверено платформой — 42 000 ₽ на группу за 2 ночи: 2 номера «Стандарт», до 3 гостей в номере.');
    expect(block).toContain(`/accommodations/${STAY_A}?check_in=2027-07-10&check_out=2027-07-12&adults=4&children=1&room=${ROOM}&rooms=2`);
    // Группа в один тип номеров не помещается — цена на группу не выдумывается.
    expect(block).toContain('«Вилюй», отель — цена не указана: группа целиком в один тип номеров не помещается — номера подберёт хозяин.');
    // «Номеров не нашли» читалось как «всё занято», хотя в зоне жилья нет (08.11).
    expect(block).toContain('Жильё — Восточная зона, 13.07 — 14.07 (1 ночь): в этой зоне жилья, свободного на все эти ночи, на платформе нет.');
    expect(block).not.toMatch(/без разметки зоны/);
    expect(block).toContain('Ещё 1 ночь — в турах с проживанием, на них жильё не искали.');
    expect(block).toContain('Бронь номера — на карточке по ссылке: даты стоянки, гости и номер уже подставлены. Оплата — владельцу при заселении, после подтверждения брони.');
    expect(block).toContain('create_stay_request такие объекты не принимает');
  });

  it('жильё по заявке хозяину (дом целиком, 08.11): строка с датами, путь заявки агенту; объекты без зоны — числом', async () => {
    x.byRequest.mockImplementation(async (stay: { zone: string }) => stay.zone === 'eastern'
      ? { state: 'ok', items: [{ id: STAY_B, name: 'Дом у озера', type: 'guesthouse', priceFrom: 24000, isVerified: false }] }
      : { state: 'empty' });
    x.unzoned.mockResolvedValue(2);
    const block = plain(offersBlock(await mcpPlan(PLAN_ARGS)));
    expect(block).toContain(`«Дом у озера» (accommodation: ${STAY_B}), гостевой дом — по заявке хозяину, от 24 000 ₽ за ночь; `
      + 'свободно ли на эти ночи и сколько человек примет, подтверждает хозяин.');
    expect(block).toContain(`/accommodations/${STAY_B}?check_in=2027-07-13&check_out=2027-07-14&adults=4&children=1`);
    expect(block).not.toMatch(/Восточная зона[^\n]*на платформе нет/);
    expect(block).toMatch(/create_stay_request \(accommodation, даты стоянки, гости\)/);
    expect(block).toContain('Ещё объектов жилья без разметки зоны: 2 — планер их не предлагает, они есть в каталоге');
    // Поиск по заявке — те же стоянки, что у номеров.
    expect(x.byRequest.mock.calls.map((c) => c[0])).toEqual(x.lodging.mock.calls.map((c) => c[0]));
  });

  it('подбор по заявке не прочитался — «не смогли проверить», а не «нет»', async () => {
    x.byRequest.mockResolvedValue({ state: 'unavailable' });
    const block = plain(offersBlock(await mcpPlan(PLAN_ARGS)));
    expect(block).toMatch(/Восточная зона, 13\.07 — 14\.07 \(1 ночь\): не смогли проверить/);
    expect(block).toMatch(/Авачинская зона[\s\S]*- остальное не смогли проверить/);
  });

  it('машина и прокат: агенту — инструмент заявки с plan_id и адрес партнёра; прокатчик виден без паузы сайта', async () => {
    const block = plain(offersBlock(await mcpPlan(PLAN_ARGS)));
    expect(block).toContain('«Шатун» (carrier: shatun), вахтовка, 26 мест — от 75 000 ₽ за машину · 3 направления в прайсе.');
    expect(block).toMatch(/\/transfers\/shatun/);
    expect(block).toMatch(/request_charter[^\n]*plan_id/);
    expect(block).toContain('«Лагуна Прокат» (company: laguna-prokat) — от 5 000 ₽ за сутки без водителя · 3 машины в прайсе.');
    expect(block).toMatch(/\/car-rental\/laguna-prokat/);
    expect(block).toMatch(/create_car_rental_request[^\n]*plan_id/);
    expect(x.rental).toHaveBeenCalledWith({ agents: true });
  });

  it('блок стоит до строки ID плана: ответ по-прежнему кончается адресом страницы плана', async () => {
    const text = await mcpPlan(PLAN_ARGS);
    expect(text.indexOf('Жильё и машина к этому плану')).toBeLessThan(text.indexOf('ID плана'));
    expect(text).toMatch(new RegExp(`/trip/${PLAN_ID}$`));
  });
});

describe('что не показано — сказано', () => {
  it('ночи незаполненных дней в подбор не входят, и ответ это говорит', async () => {
    // День 3 движок не заполнил (разрыв нумерации, 19.09).
    recommendMock.mockResolvedValue({
      days: [day(1, 'arrival', 'avachinsky'), day(2, 'activity', 'avachinsky'), day(4, 'activity', 'avachinsky'), day(5, 'departure', 'avachinsky')],
      warnings: [],
      priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0], activityPricing: { tourPriced: 0, estimated: 0, excluded: 0 } },
      itinerary: '', catalogueOpen: null,
    });
    const block = plain(offersBlock(await mcpPlan(PLAN_ARGS)));
    expect(x.lodging.mock.calls.map((c) => c[0])).toEqual([
      { zone: 'avachinsky', checkIn: '2027-07-10', checkOut: '2027-07-12', nights: 2 },
      { zone: 'avachinsky', checkIn: '2027-07-13', checkOut: '2027-07-14', nights: 1 },
    ]);
    expect(block).toContain('Ещё 1 ночь — у незаполненных дней плана: зоны ночёвки у них нет, жильё не искали.');
  });

  it('стоянок больше четырёх и перевозчиков больше трёх — остальные названы числом и адресом', async () => {
    const zones: ZoneId[] = ['avachinsky', 'eastern', 'avachinsky', 'western', 'avachinsky', 'eastern'];
    recommendMock.mockResolvedValue({
      days: [...zones.map((z, i) => day(i + 1, i === 0 ? 'arrival' : 'activity', z)), day(7, 'departure', 'avachinsky')],
      warnings: [],
      priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0], activityPricing: { tourPriced: 0, estimated: 0, excluded: 0 } },
      itinerary: '', catalogueOpen: null,
    });
    x.charter.mockResolvedValue({
      state: 'ok',
      items: ['a', 'b', 'c', 'd'].map((k) => ({ slug: `carrier-${k}`, name: `Перевозчик ${k}`, fleet: null, priceFromRub: 10000, destinations: 1, hourRub: null, dayRub: null, ratesFrom: false })),
    });
    const block = plain(offersBlock(await mcpPlan({ ...PLAN_ARGS, days: '7' })));
    // Шесть стоянок: подобраны первые четыре, о двух сказано.
    expect(x.lodging).toHaveBeenCalledTimes(4);
    expect(block).toContain('Ещё 2 стоянки — жильё на них подберёт планировщик: https://vedarai.ru/planner');
    expect(block).toContain('«Перевозчик c»');
    expect(block).not.toContain('«Перевозчик d»');
    expect(block).toContain('- ещё 1 — https://vedarai.ru/transfers');
  });
});

describe('formatPlanOffers: «жильё не нужно» — только когда искать было нечего', () => {
  const base = { stays: [], moreStays: 0, charter: { state: 'empty' as const }, rental: { state: 'empty' as const } };
  const ctx = { surface: 'mcp' as const, adults: 2, children: [], site: 'https://vedarai.ru' };

  it('ночей нет; все ночи в турах — так и сказано', async () => {
    const { formatPlanOffers } = await import('@/lib/kuzmich/plan-offers');
    expect(formatPlanOffers({ ...base, nightsInTours: 0, gapNights: 0 }, ctx)).toContain('Жильё: ночей в плане нет — жильё не нужно.');
    expect(formatPlanOffers({ ...base, nightsInTours: 2, gapNights: 0 }, ctx)).toContain('Жильё: все ночи плана — в турах с проживанием, отдельное жильё не нужно.');
  });

  it('стоянок нет, а незаполненные ночи есть — не «не нужно», а «не искали»', async () => {
    const { formatPlanOffers } = await import('@/lib/kuzmich/plan-offers');
    const lines = formatPlanOffers({ ...base, nightsInTours: 1, gapNights: 2 }, ctx).join('\n');
    expect(lines).not.toMatch(/не нужно/);
    expect(lines).toContain('Жильё: 1 ночь — в турах с проживанием, на них жильё не искали.');
    expect(lines).toContain('Ещё 2 ночи — у незаполненных дней плана: зоны ночёвки у них нет, жильё не искали.');
  });
});

describe('make_trip_plan в чате Кузьмича', () => {
  it('человеку — формы на страницах партнёров, без инструментов заявки, которых у чата нет', async () => {
    const block = plain(offersBlock(await executeKuzmichTool('make_trip_plan', PLAN_ARGS as Record<string, string>)));
    expect(block).not.toMatch(/request_charter|create_car_rental_request|create_stay_request|carrier:|company:|search_transfers|search_car_rental/);
    expect(block).toContain('Заявка на машину — формой на странице перевозчика');
    expect(block).toContain('Заявка на прокат — формой на странице прокатчика');
    // Бронь номера — та же карточка, что у агента.
    expect(block).toContain(`/accommodations/${STAY_A}?check_in=2027-07-10`);
    expect(x.rental).toHaveBeenCalledWith({ agents: false });
  });
});

describe('три исхода у каждого раздела', () => {
  it('не смогли проверить — не «нет»; перевозчиков нет; прокат на паузе сайта — когда вернётся', async () => {
    x.lodging.mockResolvedValue({ state: 'unavailable' });
    x.charter.mockResolvedValue({ state: 'empty' });
    x.rental.mockResolvedValue({ state: 'paused', returnsOn: 'во вторник, 27 октября' });
    const block = plain(offersBlock(await executeKuzmichTool('make_trip_plan', PLAN_ARGS as Record<string, string>)));
    expect(block).toContain('Жильё — Авачинская зона, 10.07 — 12.07 (2 ночи): не смогли проверить — сбой на нашей стороне; это не значит, что вариантов нет.');
    expect(block).not.toMatch(/не нашли/);
    expect(block).not.toMatch(/Бронь номера/);
    expect(block).toContain('Машина с водителем под заказ: перевозчиков с прайсом на платформе пока нет.');
    expect(block).toContain('Прокат автомобилей вернётся на сайт во вторник, 27 октября.');
  });

  it('проката нет — честное «пока нет»; машины под заказ не проверены — так и сказано', async () => {
    x.charter.mockResolvedValue({ state: 'unavailable' });
    x.rental.mockResolvedValue({ state: 'empty' });
    const block = plain(offersBlock(await mcpPlan(PLAN_ARGS)));
    expect(block).toContain('Машина с водителем под заказ: не смогли проверить — сбой на нашей стороне; это не значит, что вариантов нет.');
    expect(block).toContain('Аренды автомобилей на платформе пока нет.');
  });

  it('сбой сборки блока план не роняет и молча не пропадает', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    x.charter.mockRejectedValue(new Error('boom'));
    const text = await mcpPlan(PLAN_ARGS);
    expect(text).toContain('День 1.');
    expect(text).toContain('Жильё и машину к этому плану не смогли проверить — сбой на нашей стороне; это не значит, что вариантов нет.');
    expect(text).toMatch(new RegExp(`/trip/${PLAN_ID}$`));
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/plan-offers/);
    spy.mockRestore();
  });

  it('плана нет — нет и блока: варианты не подбираются', async () => {
    recommendMock.mockResolvedValue({
      days: [], warnings: [],
      priceBreakdown: { activities: [0, 0], accommodation: [0, 0], transport: [0, 0], perPersonTotal: [0, 0], activityPricing: { tourPriced: 0, estimated: 0, excluded: 0 } },
      itinerary: '', catalogueOpen: null,
    });
    const text = await executeKuzmichTool('make_trip_plan', PLAN_ARGS as Record<string, string>);
    expect(text).not.toContain('Жильё и машина к этому плану');
    expect(x.lodging).not.toHaveBeenCalled();
    expect(x.charter).not.toHaveBeenCalled();
  });
});

describe('прокатчик под паузой сайта: людям — нет, агенту — да (владелец 23.10)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('findCarRentalOffers: сайт — «paused», агент по MCP — прайс', async () => {
    const { findCarRentalOffers } = await vi.importActual<typeof import('@/lib/planner/trip-extras-data')>('@/lib/planner/trip-extras-data');
    const { RENTAL_SITE_PAUSE } = await import('@/lib/rental/site-pause');
    rentalCompanies.mockResolvedValue([{
      partnerId: 'p-1', slug: RENTAL_SITE_PAUSE.slugs[0], name: 'Лагуна Прокат', shortDescription: null, photos: [], phone: null, telegramHref: null,
      offers: [{
        id: 'o-1', title: 'Prado', bodyKind: 'suv', seats: 5, transmission: null, drive: null, engineHp: null,
        priceRubPerDay: 7000, priceIsFrom: false, depositRub: null, driver: 'self', conditions: null, sourceUrl: null, pricesSeenOn: null,
      }],
    }]);
    // Минута до конца паузы — она ещё идёт.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.parse(RENTAL_SITE_PAUSE.until) - 60_000));
    expect(await findCarRentalOffers()).toEqual({ state: 'paused', returnsOn: RENTAL_SITE_PAUSE.returnsOn });
    expect(await findCarRentalOffers({ agents: true })).toMatchObject({ state: 'ok', items: [{ slug: RENTAL_SITE_PAUSE.slugs[0], priceFromRub: 7000 }] });
  });
});
