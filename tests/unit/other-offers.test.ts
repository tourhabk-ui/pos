/**
 * «Другие компании к этому месту на вашу дату» (план «после отказа», этап 4а).
 *
 * После отказа оператора человеку называют компании, чьи туры идут к тому же
 * месту и могут принять его на дату заявки. Судится вызовом, без базы:
 *  - отбор: только туры со связью «к этому месту», не отказанный тур и не туры
 *    отказавшей компании; тур с календарём — только если в календаре на дату
 *    хватает мест; тур без календаря — только если дата не вне его сезона;
 *  - список — по компаниям: одна строка на компанию, её первый тур по правилу
 *    1в и число остальных подходящих;
 *  - порядок — правило 1в: сначала компании с местами в календаре на дату,
 *    затем остальные; внутри группы — жребий дня компании (не цена, не имя,
 *    не порядок базы);
 *  - ссылка — форма тура с датой и числом людей; имя и телефон человека сюда
 *    не приходят вовсе;
 *  - три исхода: есть / нет / «не прочиталось» — третий не выдаётся за второй.
 * Запросы — на настоящем PostgreSQL: tests/integration/request-chat.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: () => Promise.reject(new Error('база в этом тесте не зовётся')) } }));

import {
  OTHER_OFFERS_ANSWERS_SQL, OTHER_OFFERS_MAX, OTHER_OFFERS_TOUR_SQL, isOtherCompanyOffer, loadAskAnswers, loadOtherOffers, pickOtherOffers,
} from '@/lib/requests/other-offers';
import type { PlaceTourOffer, PlaceToursResult } from '@/lib/places/place-tours';
import { OFFER_ORDER_NOTE_ON_DATE_RU, companyLot } from '@/lib/tours/offer-order';

const DAY = '2026-11-12';
const DATE = '2026-12-02';
const BASE = 'https://vedarai.ru';

const offer = (over: Partial<PlaceTourOffer>): PlaceTourOffer => ({
  id: '1', slug: null, title: 'Тур', partnerId: 'p-a', partnerName: 'А', partnerSlug: null, partnerPublic: true, partnerVerified: null,
  basePrice: 10000, priceUnit: 'per_person', durationType: null, multiDayCount: null, durationHours: null,
  seasonStart: null, seasonEnd: null, nearestFreeDate: null, keepsSchedule: true, hasDatesByRequest: false, linkKind: 'main_place',
  ...over,
});
const pick = (offers: PlaceTourOffer[], free: string[], over: Partial<Parameters<typeof pickOtherOffers>[0]> = {}) => pickOtherOffers({
  offers, free: new Set(free), closed: new Set(), refusedTourId: '100', refusedPartnerId: 'p-refused', date: DATE, people: 2, day: DAY, base: BASE, ...over,
});

describe('отбор: кто может принять на дату', () => {
  it('отказанный тур, туры отказавшей компании и туры без связи «к этому месту» не называются', () => {
    const r = pick([
      offer({ id: '100', partnerId: 'p-refused', partnerName: 'Отказавшая' }),
      offer({ id: '101', partnerId: 'p-refused', partnerName: 'Отказавшая', title: 'Её второй тур' }),
      offer({ id: '102', partnerId: 'p-b', partnerName: 'Б', linkKind: 'unknown' }),
      offer({ id: '103', partnerId: 'p-c', partnerName: 'В', linkKind: 'waypoint', title: 'Через место' }),
    ], ['100', '101', '102', '103']);
    expect(r.offers.map((o) => [o.partnerName, o.tourId])).toEqual([['В', '103']]);
    expect(r.more).toBe(0);
  });

  it('календарь спрашивается у тех же туров, что идут в отбор: правило «другая компания» одно', () => {
    expect(isOtherCompanyOffer({ id: '103', partnerId: 'p-c', linkKind: 'waypoint' }, '100', 'p-refused')).toBe(true);
    expect(isOtherCompanyOffer({ id: '100', partnerId: 'p-c', linkKind: 'main_place' }, '100', 'p-refused')).toBe(false);
    expect(isOtherCompanyOffer({ id: '101', partnerId: 'p-refused', linkKind: 'main_place' }, '100', 'p-refused')).toBe(false);
    expect(isOtherCompanyOffer({ id: '102', partnerId: 'p-b', linkKind: 'unknown' }, '100', 'p-refused')).toBe(false);
  });

  it('тур с календарём называется, только если в календаре на дату хватает мест', () => {
    const r = pick([
      offer({ id: '1', partnerId: 'p-a', partnerName: 'А' }),
      offer({ id: '2', partnerId: 'p-b', partnerName: 'Б' }),
    ], ['2']);
    expect(r.offers.map((o) => o.tourId)).toEqual(['2']);
    expect(r.offers[0]!.seats).toBe('calendar');
  });

  it('тур без календаря называется «по заявке» — но не вне записанного сезона', () => {
    const byRequest = (id: string, partnerId: string, s: string | null, e: string | null) =>
      offer({ id, partnerId, partnerName: partnerId, keepsSchedule: false, hasDatesByRequest: true, seasonStart: s, seasonEnd: e });
    const r = pick([
      byRequest('1', 'p-none', null, null),                 // сезон не записан — границы нет
      byRequest('2', 'p-in', '2026-11-01', '2027-03-31'),   // дата в сезоне
      byRequest('3', 'p-before', '2027-06-01', '2027-09-30'), // сезон ещё не начался
      byRequest('4', 'p-after', '2026-06-01', '2026-09-30'),  // сезон кончился
      byRequest('5', 'p-open', '2026-11-20', null),           // только начало
    ], []);
    expect(r.offers.map((o) => o.partnerName).sort()).toEqual(['p-in', 'p-none', 'p-open']);
    expect(new Set(r.offers.map((o) => o.seats))).toEqual(new Set(['by_request']));
  });

  it('дата в календаре тура закрыта — он не называется, даже если другого календаря у него нет', () => {
    const offers = [
      offer({ id: '1', partnerId: 'p-closed', partnerName: 'Закрыла дату', keepsSchedule: false, hasDatesByRequest: true }),
      offer({ id: '2', partnerId: 'p-open', partnerName: 'По заявке', keepsSchedule: false, hasDatesByRequest: true }),
    ];
    expect(pick(offers, [], { closed: new Set(['1']) }).offers.map((o) => o.partnerName)).toEqual(['По заявке']);
  });
});

describe('список — по компаниям, порядок — правило 1в', () => {
  it('одна строка на компанию: её первый тур по правилу и число остальных подходящих', () => {
    const r = pick([
      offer({ id: '11', partnerId: 'p-a', partnerName: 'А', title: 'Первый' }),
      offer({ id: '12', partnerId: 'p-a', partnerName: 'А', title: 'Второй' }),
      offer({ id: '13', partnerId: 'p-a', partnerName: 'А', title: 'Без мест' }),
      offer({ id: '21', partnerId: 'p-b', partnerName: 'Б' }),
    ], ['11', '12', '21']);
    expect(r.offers).toHaveLength(2);
    const a = r.offers.find((o) => o.partnerName === 'А')!;
    // Тур без мест на дату в счёт «ещё» не входит.
    expect(a.moreTours).toBe(1);
    expect(['11', '12']).toContain(a.tourId);
    expect(r.offers.find((o) => o.partnerName === 'Б')!.moreTours).toBe(0);
  });

  it('сначала компании с местами в календаре на дату, затем остальные; внутри группы — жребий дня компании', () => {
    const cal = ['p-k1', 'p-k2', 'p-k3'];
    const req = ['p-r1', 'p-r2'];
    const offers = [
      ...req.map((p, i) => offer({ id: String(50 + i), partnerId: p, partnerName: p, keepsSchedule: false, hasDatesByRequest: true })),
      ...cal.map((p, i) => offer({ id: String(60 + i), partnerId: p, partnerName: p })),
    ];
    const r = pick(offers, ['60', '61', '62']);
    const byLot = (ids: string[]) => [...ids].sort((x, y) => companyLot(DAY, x) - companyLot(DAY, y));
    expect(r.offers.map((o) => o.partnerName)).toEqual([...byLot(cal), ...byLot(req)]);
    // Жребий — дня: на другой день порядок внутри групп считается заново тем же правилом.
    const next = pick(offers, ['60', '61', '62'], { day: '2026-11-13' });
    const byLotNext = (ids: string[]) => [...ids].sort((x, y) => companyLot('2026-11-13', x) - companyLot('2026-11-13', y));
    expect(next.offers.map((o) => o.partnerName)).toEqual([...byLotNext(cal), ...byLotNext(req)]);
  });

  it('цена места в списке не меняет: дешёвая компания не встаёт первой', () => {
    const offers = ['p-1', 'p-2', 'p-3', 'p-4'].map((p, i) => offer({ id: String(70 + i), partnerId: p, partnerName: p, basePrice: 1000 * (i + 1) }));
    const cheapFirst = pick(offers, ['70', '71', '72', '73']).offers.map((o) => o.partnerName);
    const flipped = pick(offers.map((o, i) => ({ ...o, basePrice: 1000 * (4 - i) })), ['70', '71', '72', '73']).offers.map((o) => o.partnerName);
    expect(flipped).toEqual(cheapFirst);
  });

  it(`называется не больше ${OTHER_OFFERS_MAX} компаний — остальные числом`, () => {
    const offers = Array.from({ length: OTHER_OFFERS_MAX + 3 }, (_, i) => offer({ id: String(80 + i), partnerId: `p-${i}`, partnerName: `К${i}` }));
    const r = pick(offers, offers.map((o) => o.id));
    expect(r.offers).toHaveLength(OTHER_OFFERS_MAX);
    expect(r.more).toBe(3);
  });

  it('строка: цена словами с единицей, ссылка на форму тура с датой и числом людей', () => {
    const r = pick([
      offer({ id: '90', slug: 'gorely-za-den', partnerId: 'p-a', partnerName: 'А', basePrice: 12000, priceUnit: 'per_person' }),
      offer({ id: '91', partnerId: 'p-b', partnerName: 'Б', basePrice: null }),
    ], ['90', '91'], { people: 3 });
    const a = r.offers.find((o) => o.partnerName === 'А')!;
    expect(a.price).toBe('12 000 ₽ за человека');
    expect(a.url).toBe('https://vedarai.ru/catalog/tours/gorely-za-den?date=2026-12-02&guests=3#booking');
    const b = r.offers.find((o) => o.partnerName === 'Б')!;
    // Цена не записана — null, а не ноль: слова «цена не указана» ставит текст сообщения.
    expect(b.price).toBeNull();
    expect(b.url).toBe('https://vedarai.ru/catalog/tours/91?date=2026-12-02&guests=3#booking');
  });

  it('подпись порядка называет правило и кончается «Место в списке не продаётся.»', () => {
    expect(OFFER_ORDER_NOTE_ON_DATE_RU).toContain('сначала те, у кого в календаре есть места на эту дату');
    expect(OFFER_ORDER_NOTE_ON_DATE_RU).toContain('жребий дня');
    expect(OFFER_ORDER_NOTE_ON_DATE_RU.endsWith('Место в списке не продаётся.')).toBe(true);
  });
});

describe('ответы компаний на вопрос «возьмёте?» (этап 4б)', () => {
  const LEAD = '11111111-1111-4111-8111-111111111111';
  const five = () => Array.from({ length: OTHER_OFFERS_MAX + 2 }, (_, i) => offer({ id: String(300 + i), partnerId: `p-${i}`, partnerName: `К${i}` }));

  it('«Не могу» — компании в списке этой заявки нет, со всеми её турами; порядок остальных прежний', () => {
    const offers = [
      offer({ id: '11', partnerId: 'p-a', partnerName: 'А' }),
      offer({ id: '12', partnerId: 'p-a', partnerName: 'А', title: 'Её второй' }),
      offer({ id: '21', partnerId: 'p-b', partnerName: 'Б' }),
      offer({ id: '31', partnerId: 'p-c', partnerName: 'В', keepsSchedule: false, hasDatesByRequest: true }),
    ];
    const before = pick(offers, ['11', '12', '21']).offers.map((o) => o.partnerName);
    const after = pick(offers, ['11', '12', '21'], { declined: new Set(['p-a']) }).offers.map((o) => o.partnerName);
    expect(before).toContain('А');
    expect(after).toEqual(before.filter((n) => n !== 'А'));
  });

  it('«Беру» — компания названа с ответом и тем туром, о котором её спрашивали; молчавшие — без ответа', () => {
    const offers = [
      offer({ id: '11', partnerId: 'p-a', partnerName: 'А', title: 'Первый' }),
      offer({ id: '12', partnerId: 'p-a', partnerName: 'А', title: 'О нём спрашивали' }),
      offer({ id: '21', partnerId: 'p-b', partnerName: 'Б' }),
    ];
    for (const asked of ['11', '12']) {
      const r = pick(offers, ['11', '12', '21'], { took: new Map([['p-a', asked]]) });
      const a = r.offers.find((o) => o.partnerName === 'А')!;
      expect([a.tourId, a.said, a.moreTours]).toEqual([asked, 'take', 1]);
      expect(r.offers.find((o) => o.partnerName === 'Б')!.said).toBeNull();
    }
    // Без ответов поле есть у каждой строки и пусто.
    expect(pick(offers, ['11', '12', '21']).offers.map((o) => o.said)).toEqual([null, null]);
  });

  it('«Беру» сильнее пустого календаря и сезона, но не закрытой даты', () => {
    const full = offer({ id: '41', partnerId: 'p-full', partnerName: 'Календарь без мест' });
    const season = offer({ id: '42', partnerId: 'p-season', partnerName: 'Вне сезона', keepsSchedule: false, hasDatesByRequest: true, seasonStart: '2027-06-01', seasonEnd: '2027-09-30' });
    const closed = offer({ id: '43', partnerId: 'p-closed', partnerName: 'Дата закрыта', keepsSchedule: false, hasDatesByRequest: true });
    const took = new Map([['p-full', '41'], ['p-season', '42'], ['p-closed', '43']]);
    // Без ответа ни один из трёх не называется.
    expect(pick([full, season, closed], [], { closed: new Set(['43']) }).offers).toEqual([]);
    const r = pick([full, season, closed], [], { closed: new Set(['43']), took });
    expect(r.offers.map((o) => [o.partnerName, o.said, o.seats]).sort()).toEqual([
      ['Вне сезона', 'take', 'by_request'],
      // Календарь мест не показывает — «места есть» по календарю не говорится: сказано только слово компании.
      ['Календарь без мест', 'take', 'by_request'],
    ]);
  });

  it('ответ про один тур не называет «Беру» у другого тура той же компании', () => {
    // Тур, о котором спрашивали, из «Туров к месту» ушёл — у компании остался другой, с местами.
    const r = pick([offer({ id: '52', partnerId: 'p-a', partnerName: 'А' })], ['52'], { took: new Map([['p-a', '51']]) });
    expect(r.offers.map((o) => [o.tourId, o.said])).toEqual([['52', null]]);
  });

  it('предел списка ответившую «Беру» не срезает, а порядок от ответов не меняется', () => {
    const offers = five();
    const free = offers.map((o) => o.id);
    const plain = pick(offers, free);
    expect(plain.offers).toHaveLength(OTHER_OFFERS_MAX);
    const order = [...offers].sort((x, y) => companyLot(DAY, x.partnerId) - companyLot(DAY, y.partnerId)).map((o) => o.partnerName);
    const last = [...offers].sort((x, y) => companyLot(DAY, x.partnerId) - companyLot(DAY, y.partnerId)).at(-1)!;
    const r = pick(offers, free, { took: new Map([[last.partnerId, last.id]]) });
    // Первые пять — те же и в том же порядке; ответившая — следом, на своём месте по жребию.
    expect(r.offers.map((o) => o.partnerName)).toEqual([...order.slice(0, OTHER_OFFERS_MAX), last.partnerName]);
    expect(r.offers.at(-1)!.said).toBe('take');
    expect(r.more).toBe(1);
    // Ответившая в первой пятёрке места не меняет.
    const first = offers.find((o) => o.partnerName === order[2])!;
    expect(pick(offers, free, { took: new Map([[first.partnerId, first.id]]) }).offers.map((o) => o.partnerName)).toEqual(order.slice(0, OTHER_OFFERS_MAX));
  });

  it('чтение со своей заявкой спрашивает ответы; без заявки — не спрашивает', async () => {
    const TOUR_ROW = { operator_id: 'p-refused', place_id: 'pl-1', place_name: 'Вулкан Горелый', place_slug: 'gorely', place_ark_id: null };
    const deps = (answers: ReturnType<typeof vi.fn>) => ({
      query: vi.fn(async () => ({ rows: [TOUR_ROW] })),
      placeTours: vi.fn(async (): Promise<PlaceToursResult> => ({ state: 'ok', day: DAY, offers: [
        offer({ id: '100', partnerId: 'p-refused' }),
        offer({ id: '201', partnerId: 'p-b', partnerName: 'Б' }),
        offer({ id: '202', partnerId: 'p-c', partnerName: 'В', keepsSchedule: false, hasDatesByRequest: true }),
      ] })),
      onDate: vi.fn(async () => ({ state: 'ok' as const, free: new Set(['201']), closed: new Set<string>() })),
      answers,
      now: new Date('2026-11-12T03:00:00Z'),
    });
    const said = vi.fn(async () => ({ state: 'ok' as const, declined: new Set(['p-b']), took: new Map([['p-c', '202']]) }));
    const withLead = await loadOtherOffers({ tourId: 100, date: DATE, people: 2, leadId: LEAD }, deps(said));
    expect(said).toHaveBeenCalledWith(LEAD, DATE);
    if (withLead.state !== 'ok') throw new Error('ожидался список');
    expect(withLead.offers.map((o) => [o.partnerName, o.said])).toEqual([['В', 'take']]);

    const silent = vi.fn(async () => ({ state: 'ok' as const, declined: new Set<string>(), took: new Map<string, string>() }));
    const noLead = await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, deps(silent));
    expect(silent).not.toHaveBeenCalled();
    if (noLead.state !== 'ok') throw new Error('ожидался список');
    expect(noLead.offers.map((o) => [o.partnerName, o.said])).toEqual([['Б', null], ['В', null]]);

    // Все ответили «Не могу» — называть некого.
    const all = vi.fn(async () => ({ state: 'ok' as const, declined: new Set(['p-b', 'p-c']), took: new Map<string, string>() }));
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2, leadId: LEAD }, deps(all))).toEqual({ state: 'none' });

    // Ответы не прочитались — «не прочиталось», а не список, где названа отказавшаяся.
    const broken = vi.fn(async () => ({ state: 'failed' as const }));
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2, leadId: LEAD }, deps(broken))).toEqual({ state: 'failed' });
  });

  it('ответы читаются по заявке и дате; вопрос без ответа список не меняет; отказ базы — «не прочиталось»', async () => {
    const q = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe(OTHER_OFFERS_ANSWERS_SQL);
      expect(params).toEqual([LEAD, DATE]);
      return { rows: [
        { partner_id: 'p-b', tour_id: '201', answer: 'decline' },
        { partner_id: 'p-c', tour_id: '202', answer: 'take' },
        // Строка без ответа или с незнакомым словом — не «Беру» и не «Не могу».
        { partner_id: 'p-d', tour_id: '203', answer: null as unknown as string },
        { partner_id: 'p-e', tour_id: '204', answer: 'maybe' },
      ] };
    });
    const r = await loadAskAnswers(LEAD, DATE, q);
    if (r.state !== 'ok') throw new Error('ожидались ответы');
    expect([...r.declined]).toEqual(['p-b']);
    expect([...r.took]).toEqual([['p-c', '202']]);
    // Запрос берёт только отвеченные вопросы этой заявки на эту дату.
    expect(OTHER_OFFERS_ANSWERS_SQL).toContain('a.answer IS NOT NULL');
    expect(OTHER_OFFERS_ANSWERS_SQL).toContain('a.lead_id = $1::uuid AND a.ask_date = $2::date');

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = vi.fn(async () => { throw Object.assign(new Error('db'), { code: '57P01' }); });
    expect(await loadAskAnswers(LEAD, DATE, down)).toEqual({ state: 'failed' });
    expect(spy.mock.calls.flat().map((x) => JSON.stringify(x)).join(' ')).toContain('57P01');
    spy.mockRestore();
  });
});

describe('чтение: три исхода', () => {
  const TOUR_ROW = { operator_id: 'p-refused', place_id: 'pl-1', place_name: 'Вулкан Горелый', place_slug: 'gorely', place_ark_id: null };
  const place = (offers: PlaceTourOffer[]): PlaceToursResult => (offers.length ? { state: 'ok', day: DAY, offers } : { state: 'empty', day: DAY });
  const world = (over: {
    tour?: typeof TOUR_ROW | null | 'throw';
    place?: PlaceToursResult;
    free?: { state: 'ok'; free: Set<string>; closed: Set<string> } | { state: 'failed' };
  } = {}) => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe(OTHER_OFFERS_TOUR_SQL);
      expect(params).toEqual(['100']);
      if (over.tour === 'throw') throw Object.assign(new Error('db'), { code: '57P01' });
      return { rows: over.tour === null ? [] : [over.tour ?? TOUR_ROW] };
    });
    const placeTours = vi.fn(async () => over.place ?? place([
      offer({ id: '100', partnerId: 'p-refused' }),
      offer({ id: '201', partnerId: 'p-b', partnerName: 'Б', title: 'Горелый за день' }),
      offer({ id: '202', partnerId: 'p-c', partnerName: 'В', keepsSchedule: false, hasDatesByRequest: true }),
    ]));
    const onDate = vi.fn(async () => over.free ?? { state: 'ok' as const, free: new Set(['201']), closed: new Set<string>() });
    return { query, placeTours, onDate, now: new Date('2026-11-12T03:00:00Z') };
  };

  it('есть: место, ссылка на «Туры к этому месту», компании; календарь на дату спрошен у всех других туров разом', async () => {
    const d = world();
    const r = await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, d);
    expect(r).toMatchObject({ state: 'ok', placeName: 'Вулкан Горелый', placeUrl: 'https://vedarai.ru/places/gorely#tours', more: 0 });
    if (r.state !== 'ok') throw new Error('ожидался список');
    expect(r.offers.map((o) => [o.partnerName, o.seats])).toEqual([['Б', 'calendar'], ['В', 'by_request']]);
    expect(d.placeTours).toHaveBeenCalledWith('pl-1', { now: d.now });
    // Один запрос на всех — и без отказанного тура: о нём спрашивать незачем.
    expect(d.onDate).toHaveBeenCalledTimes(1);
    expect(d.onDate).toHaveBeenCalledWith(['201', '202'], DATE, 2);
  });

  it('нет: у тура нет главного места; к месту нет других компаний; никто не может на дату', async () => {
    const noPlace = world({ tour: null });
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, noPlace)).toEqual({ state: 'none' });
    expect(noPlace.placeTours).not.toHaveBeenCalled();

    const alone = world({ place: place([offer({ id: '100', partnerId: 'p-refused' }), offer({ id: '101', partnerId: 'p-refused' })]) });
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, alone)).toEqual({ state: 'none' });
    // Спрашивать календарь не у кого — запрос не идёт.
    expect(alone.onDate).not.toHaveBeenCalled();

    const full = world({ place: place([offer({ id: '201', partnerId: 'p-b' })]), free: { state: 'ok', free: new Set(), closed: new Set() } });
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, full)).toEqual({ state: 'none' });

    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, world({ place: { state: 'empty', day: DAY } }))).toEqual({ state: 'none' });
  });

  it('не прочиталось — «failed», а не «нет»: тур, туры места, календарь на дату', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, world({ tour: 'throw' }))).toEqual({ state: 'failed' });
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, world({ place: { state: 'failed' } }))).toEqual({ state: 'failed' });
    expect(await loadOtherOffers({ tourId: 100, date: DATE, people: 2 }, world({ free: { state: 'failed' } }))).toEqual({ state: 'failed' });
    // В логе — номер тура и SQLSTATE, без текста ошибки базы.
    expect(spy.mock.calls.flat().map((x) => JSON.stringify(x)).join(' ')).toContain('57P01');
    spy.mockRestore();
  });

  it('кривые тур и дата базу не трогают', async () => {
    const d = world();
    expect(await loadOtherOffers({ tourId: 'abc', date: DATE, people: 2 }, d)).toEqual({ state: 'none' });
    expect(await loadOtherOffers({ tourId: 100, date: '02.12.2026', people: 2 }, d)).toEqual({ state: 'none' });
    expect(d.query).not.toHaveBeenCalled();
  });
});
