// @vitest-environment node
/**
 * «Другое жильё на ваши даты» после ответа хозяина «Занято» (план «после
 * отказа», этап 5). Судится вызовом, без базы:
 *  - отбор: объект, по которому ответили «Занято», не называется; сначала
 *    жильё с номерами по календарю, затем «по заявке хозяину»; зона объекта не
 *    размечена — список не строится; половина подбора не прочиталась — «не
 *    прочиталось», а не «нет»;
 *  - слова: «номера есть» — о календаре, цену и даты подтверждает хозяин;
 *    порядок назван правилом и кончается «Место в списке не продаётся.»;
 *  - сообщение гостю — от Ведара, а не словами хозяина, только после «Занято»
 *    и только пока заезд впереди; «ушло» говорится, когда MAX гостя принял;
 *  - вид заявки: поле other_stays только после «Занято», три исхода и «не про
 *    эту заявку»; странице слова для агента не уходят;
 *  - нажатие хозяина: «Занято» зовёт сообщение, «Свободно» и «Позвоню» — нет;
 *    сбой сообщения записанный ответ не отменяет.
 * Запросы — на настоящем PostgreSQL: tests/integration/request-chat.pg.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pool, postMock, tgMock } = vi.hoisted(() => ({ pool: vi.fn(), postMock: vi.fn(), tgMock: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => pool(...a) } }));
vi.mock('@/lib/requests/request-chat-service', () => ({ postOwnerMessage: (...a: unknown[]) => postMock(...a) }));
vi.mock('@/lib/notifications/tg-send', () => ({ tgSend: (...a: unknown[]) => tgMock(...a) }));

import { OTHER_STAYS_ZONE_SQL, loadOtherStays, pickOtherStays, type OtherStay } from '@/lib/stay/other-stays';
import {
  OTHER_STAYS_LIMIT_NOTE_RU, OTHER_STAYS_NOT_ANSWER_RU, OTHER_STAYS_ORDER_NOTE_RU, otherStayDatesWords, otherStayTypeWords,
} from '@/lib/stay/other-stays-words';
import {
  OTHER_STAYS_SUBJECT_SQL, guestOtherStaysText, tellGuestOtherStays,
} from '@/lib/stay/other-stays-notice';
import { otherStaysAsk, pageOtherStays, readStatusOtherStays } from '@/lib/stay/other-stays-status';
import { buildRequestView, type StatusRow } from '@/lib/mcp/request-status';
import { GET_REQUEST_STATUS_TOOL, OTHER_STAYS_STATES } from '@/lib/mcp/request-status-schema';
import { answerStayRequest, OTHER_STAYS_PRESS_BUDGET_MS } from '@/lib/stay/owner-answer-flow';
import { MANAGER_STAYS_MAX, managerStayAnswerText, ownerStayAnswerText } from '@/lib/stay/owner-answer';
import type { LodgingOption, RequestLodgingOption } from '@/lib/planner/trip-extras-data';

const REFUSED = '3b2551c7-ed5c-47c8-bb93-41ca6a278c1e';
const REQ = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f607';
const BASE = 'https://vedarai.ru';
const [IN, OUT] = ['2027-07-10', '2027-07-12'];
/** Сегодня по Камчатке — 01.07.2027: заезд 10.07 впереди. */
const NOW = Date.parse('2027-07-01T00:00:00Z');

const room = (over: Partial<LodgingOption>): LodgingOption => ({
  id: 'r-1', name: 'Отель', type: 'hotel', priceFrom: 6000, rating: null, reviewCount: 0, isVerified: false,
  stay: { kind: 'priced', total: 24000, rooms: 1, roomId: 'room', roomName: 'Двухместный', maxGuests: 2 },
  ...over,
});
const byReq = (over: Partial<RequestLodgingOption>): RequestLodgingOption => ({
  id: 'q-1', name: 'Гостевой дом', type: 'guesthouse', priceFrom: 5000, isVerified: false, ...over,
});
const pick = (rooms: LodgingOption[], byRequest: RequestLodgingOption[], guests = 2) => pickOtherStays({
  rooms, byRequest, refusedId: REFUSED, checkIn: IN, checkOut: OUT, guests, base: BASE,
});

beforeEach(() => {
  pool.mockReset(); postMock.mockReset(); tgMock.mockReset();
  tgMock.mockResolvedValue({ ok: true });
  postMock.mockResolvedValue({ outcome: 'sent', delivery: 'max' });
});

describe('отбор и порядок', () => {
  it('объект, по которому ответили «Занято», не называется; сначала жильё с номерами по календарю, затем «по заявке хозяину»', () => {
    const r = pick(
      [room({ id: 'r-1', name: 'Первый' }), room({ id: REFUSED, name: 'Отказавший' }), room({ id: 'r-2', name: 'Второй' })],
      [byReq({ id: REFUSED, name: 'Отказавший' }), byReq({ id: 'q-1', name: 'По заявке' })],
    );
    expect(r.map((s) => [s.name, s.dates])).toEqual([['Первый', 'calendar'], ['Второй', 'calendar'], ['По заявке', 'by_request']]);
  });

  it('порядок внутри групп — тот, что отдал подбор плана: здесь он не пересортируется и по цене не выстраивается', () => {
    const rooms = [room({ id: 'r-3', name: 'Дорогой', priceFrom: 20000 }), room({ id: 'r-4', name: 'Дешёвый', priceFrom: 1000 })];
    expect(pick(rooms, []).map((s) => s.name)).toEqual(['Дорогой', 'Дешёвый']);
    expect(pick([...rooms].reverse(), []).map((s) => s.name)).toEqual(['Дешёвый', 'Дорогой']);
  });

  it('цена всех ночей — только когда группа помещается; у жилья без номеров её нет; ссылка несёт даты и гостей', () => {
    const r = pick(
      [room({ id: 'r-1' }), room({ id: 'r-2', stay: { kind: 'no_fit', people: 9 } })],
      [byReq({ id: 'q-1', priceFrom: null })],
      9,
    );
    expect(r.map((s) => [s.id, s.stayTotal, s.priceFrom])).toEqual([['r-1', 24000, 6000], ['r-2', null, 6000], ['q-1', null, null]]);
    expect(r[0]!.url).toBe(`${BASE}/accommodations/r-1?check_in=${IN}&check_out=${OUT}&adults=9&children=0`);
    // Форма принимает до 20 взрослых — больше в ссылку не кладётся.
    expect(pick([room({ id: 'r-1' })], [], 35)[0]!.url).toContain('adults=20');
  });

  it('один и тот же объект в обеих половинах подбора называется один раз', () => {
    expect(pick([room({ id: 'x' })], [byReq({ id: 'x' })])).toHaveLength(1);
  });
});

describe('чтение: исходы', () => {
  const deps = (over: {
    zone?: string | null | 'throw' | 'no_row';
    rooms?: Awaited<ReturnType<NonNullable<Parameters<typeof loadOtherStays>[1]>['rooms'] & object>>;
    byRequest?: Awaited<ReturnType<NonNullable<Parameters<typeof loadOtherStays>[1]>['byRequest'] & object>>;
  } = {}) => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe(OTHER_STAYS_ZONE_SQL);
      expect(params).toEqual([REFUSED]);
      if (over.zone === 'throw') throw Object.assign(new Error('db'), { code: '57P01' });
      return { rows: over.zone === 'no_row' ? [] : [{ planner_zone: over.zone === undefined ? 'avachinsky' : over.zone }] };
    });
    const rooms = vi.fn(async () => over.rooms ?? { state: 'ok' as const, items: [room({ id: 'r-1', name: 'С номерами' })] });
    const byRequest = vi.fn(async () => over.byRequest ?? { state: 'ok' as const, items: [byReq({ id: 'q-1', name: 'По заявке' })] });
    return { query, rooms, byRequest };
  };
  const ARGS = { accommodationId: REFUSED, checkIn: IN, checkOut: OUT, guests: 2 };

  it('есть: зона объекта заявки, те же ночи и гости — в оба подбора плана', async () => {
    const d = deps();
    const r = await loadOtherStays(ARGS, d);
    expect(r).toMatchObject({ state: 'ok', zoneName: 'Авачинская зона' });
    if (r.state !== 'ok') throw new Error('ожидался список');
    expect(r.items.map((s) => [s.name, s.dates])).toEqual([['С номерами', 'calendar'], ['По заявке', 'by_request']]);
    const stay = { zone: 'avachinsky', checkIn: IN, checkOut: OUT, nights: 2 };
    expect(d.rooms).toHaveBeenCalledWith(stay, 2);
    expect(d.byRequest).toHaveBeenCalledWith(stay);
  });

  it('гостей не записано — места считаются на одного', async () => {
    const d = deps();
    await loadOtherStays({ ...ARGS, guests: null }, d);
    expect(d.rooms.mock.calls[0]![1]).toBe(1);
  });

  it('зона не размечена, незнакома или объекта нет — «зона не размечена»: подбор не зовётся, по названию зона не угадывается', async () => {
    for (const zone of [null, 'somewhere', 'no_row'] as const) {
      const d = deps({ zone });
      expect(await loadOtherStays(ARGS, d), String(zone)).toEqual({ state: 'unzoned' });
      expect(d.rooms).not.toHaveBeenCalled();
      expect(d.byRequest).not.toHaveBeenCalled();
    }
  });

  it('нет: оба подбора пусты; в зоне только сам отказавший объект', async () => {
    expect(await loadOtherStays(ARGS, deps({ rooms: { state: 'empty' }, byRequest: { state: 'empty' } }))).toEqual({ state: 'none' });
    expect(await loadOtherStays(ARGS, deps({
      rooms: { state: 'empty' }, byRequest: { state: 'ok', items: [byReq({ id: REFUSED })] },
    }))).toEqual({ state: 'none' });
  });

  it('не прочиталось — «failed», а не «нет»: зона, подбор с номерами, подбор по заявке', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadOtherStays(ARGS, deps({ zone: 'throw' }))).toEqual({ state: 'failed' });
    // Одна половина прочиталась, другая нет: список неполон, и ни «нет», ни «вот всё» по нему сказать нельзя.
    expect(await loadOtherStays(ARGS, deps({ rooms: { state: 'unavailable' } }))).toEqual({ state: 'failed' });
    expect(await loadOtherStays(ARGS, deps({ byRequest: { state: 'unavailable' } }))).toEqual({ state: 'failed' });
    expect(await loadOtherStays(ARGS, deps({ rooms: { state: 'unavailable' }, byRequest: { state: 'empty' } }))).toEqual({ state: 'failed' });
    expect(spy.mock.calls.flat().map((x) => JSON.stringify(x)).join(' ')).toContain('57P01');
    spy.mockRestore();
  });

  it('кривые даты базу не трогают', async () => {
    const d = deps();
    expect(await loadOtherStays({ ...ARGS, checkIn: '10.07.2027' }, d)).toEqual({ state: 'none' });
    expect(await loadOtherStays({ ...ARGS, checkOut: IN }, d)).toEqual({ state: 'none' });
    expect(d.query).not.toHaveBeenCalled();
  });
});

describe('слова', () => {
  it('«номера есть» — о календаре; у жилья без номеров даты и цену подтверждает хозяин; число гостей — только записанное', () => {
    expect(otherStayDatesWords({ dates: 'calendar', priceFrom: 6000, stayTotal: 24000 }, 2))
      .toBe('в календаре на эти ночи номера на 2 гостей есть — 24 000 ₽ за все ночи');
    expect(otherStayDatesWords({ dates: 'calendar', priceFrom: 6000, stayTotal: 24000 }, 1)).toContain('на 1 гостя есть');
    expect(otherStayDatesWords({ dates: 'calendar', priceFrom: 6000, stayTotal: 24000 }, null))
      .toBe('в календаре на эти ночи номера есть — 24 000 ₽ за все ночи');
    // Группа не помещается в один тип номеров — «места на группу есть» не говорится.
    expect(otherStayDatesWords({ dates: 'calendar', priceFrom: 6000, stayTotal: null }, 9))
      .toBe('в календаре на эти ночи есть свободные номера; поместится ли вся группа — подтверждает хозяин; от 6 000 ₽ за ночь');
    expect(otherStayDatesWords({ dates: 'by_request', priceFrom: 5000, stayTotal: null }, 2))
      .toBe('номеров на Ведаре нет — даты и цену подтверждает хозяин; от 5 000 ₽ за ночь');
    // Цена не названа — её в строке нет, а не «0 ₽».
    expect(otherStayDatesWords({ dates: 'by_request', priceFrom: null, stayTotal: null }, 2))
      .toBe('номеров на Ведаре нет — даты и цену подтверждает хозяин');
  });

  it('порядок назван правилом и кончается «Место в списке не продаётся.»; оценок нет; тип — словом, незнакомый — молчанием', () => {
    // У двух групп ключи порядка разные — названы оба: у жилья «по заявке хозяину» оценка в порядок не входит.
    expect(OTHER_STAYS_ORDER_NOTE_RU).toContain('сначала жильё, где по календарю Ведара номера свободны на все ваши ночи (проверенные Ведаром, затем по оценке гостей и цене за ночь)');
    expect(OTHER_STAYS_ORDER_NOTE_RU).toContain('затем жильё, где даты подтверждает хозяин (проверенные Ведаром, затем по цене за ночь)');
    // Список неполон по построению — об этом сказано, а не обрезано молча.
    expect(OTHER_STAYS_LIMIT_NOTE_RU).toBe('В списке не больше 3 объектов каждого вида — остальное жильё смотрите в каталоге.');
    expect(OTHER_STAYS_ORDER_NOTE_RU.endsWith('Место в списке не продаётся.')).toBe(true);
    expect(OTHER_STAYS_NOT_ANSWER_RU).toContain('Это не ответ хозяев этих объектов');
    expect(OTHER_STAYS_NOT_ANSWER_RU).toContain('имя и телефон получит только тот хозяин, которому вы её оставите');
    expect(`${OTHER_STAYS_ORDER_NOTE_RU} ${OTHER_STAYS_NOT_ANSWER_RU}`).not.toMatch(/рекоменд|лучш|дешевл|выгодн|советуем/i);
    expect(otherStayTypeWords('guesthouse')).toBe('Гостевой дом');
    expect(otherStayTypeWords('igloo')).toBe('');
  });
});

describe('сообщение гостю', () => {
  const ITEMS: OtherStay[] = [
    { id: 'r-1', name: 'Отель «Гейзер» & Ко', type: 'hotel', dates: 'calendar', priceFrom: 6000, stayTotal: 24000, url: `${BASE}/accommodations/r-1?check_in=${IN}&check_out=${OUT}&adults=2&children=0` },
    { id: 'q-1', name: 'Дом у реки', type: 'guesthouse', dates: 'by_request', priceFrom: null, stayTotal: null, url: `${BASE}/accommodations/q-1?check_in=${IN}&check_out=${OUT}&adults=2&children=0` },
  ];
  const SUBJECT = { accommodation_id: REFUSED, accommodation_name: 'Кутха <дом>', check_in: IN, check_out: OUT, guests: 2, guest_chat: '7002' };
  const world = (over: { subject?: typeof SUBJECT | null; load?: Awaited<ReturnType<typeof loadOtherStays>>; send?: ReturnType<typeof vi.fn> } = {}) => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toBe(OTHER_STAYS_SUBJECT_SQL);
      expect(params).toEqual([REQ]);
      return { rows: over.subject === null ? [] : [over.subject ?? SUBJECT] };
    });
    const load = vi.fn(async () => over.load ?? { state: 'ok' as const, zoneName: 'Авачинская зона', items: ITEMS });
    const sendMax = over.send ?? vi.fn(async () => ({ ok: true }));
    return { query, load, sendMax, now: () => NOW };
  };

  it('текст: чьё это сообщение, что известно о ночах, ссылка на карточку, кому уйдут данные и правило порядка', () => {
    const text = guestOtherStaysText({ refusedName: 'Кутха <дом>', zoneName: 'Авачинская зона', checkIn: IN, checkOut: OUT, guests: 2, items: ITEMS });
    expect(text.split('\n')).toEqual([
      '<b>Другое жильё на ваши даты — Авачинская зона</b>',
      'С 10.07.2027 по 12.07.2027, гостей: 2. Это сообщение Ведара, а не хозяина «Кутха &lt;дом&gt;».',
      `1. «Отель «Гейзер» &amp; Ко» (отель) — в календаре на эти ночи номера на 2 гостей есть — 24 000 ₽ за все ночи. Заявка: ${BASE}/accommodations/r-1?check_in=${IN}&amp;check_out=${OUT}&amp;adults=2&amp;children=0`,
      `2. «Дом у реки» (гостевой дом) — номеров на Ведаре нет — даты и цену подтверждает хозяин. Заявка: ${BASE}/accommodations/q-1?check_in=${IN}&amp;check_out=${OUT}&amp;adults=2&amp;children=0`,
      `${OTHER_STAYS_LIMIT_NOTE_RU} ${BASE}/accommodations`,
      OTHER_STAYS_NOT_ANSWER_RU,
      OTHER_STAYS_ORDER_NOTE_RU,
    ]);
  });

  it('читается только заявка с ответом «Занято»; имя и телефон гостя запрос не выбирает', () => {
    expect(OTHER_STAYS_SUBJECT_SQL).toContain("s.owner_answer = 'busy'");
    expect(OTHER_STAYS_SUBJECT_SQL).not.toMatch(/guest_name|guest_phone|comment/);
  });

  it('MAX гостя принял — «ушло»; в подбор идут объект, ночи и гости заявки', async () => {
    const w = world();
    expect(await tellGuestOtherStays(REQ, w)).toEqual({ state: 'sent', names: ['Отель «Гейзер» & Ко', 'Дом у реки'] });
    expect(w.load).toHaveBeenCalledWith({ accommodationId: REFUSED, checkIn: IN, checkOut: OUT, guests: 2 });
    expect(w.sendMax).toHaveBeenCalledTimes(1);
    expect(w.sendMax.mock.calls[0]![0]).toBe('7002');
    expect(String(w.sendMax.mock.calls[0]![1])).toContain('Это сообщение Ведара, а не хозяина');
  });

  it('чата нет, MAX не принял или завис — «на странице заявки», а не «ушло»', async () => {
    const noChat = world({ subject: { ...SUBJECT, guest_chat: null } });
    expect(await tellGuestOtherStays(REQ, noChat)).toMatchObject({ state: 'page' });
    expect(noChat.sendMax).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await tellGuestOtherStays(REQ, world({ send: vi.fn(async () => ({ ok: false })) }))).toMatchObject({ state: 'page' });
    expect(await tellGuestOtherStays(REQ, world({ send: vi.fn(async () => { throw new Error('net'); }) }))).toMatchObject({ state: 'page' });
    expect(await tellGuestOtherStays(REQ, { ...world({ send: vi.fn(() => new Promise<{ ok: boolean }>(() => {})) }), timeoutMs: 20 })).toMatchObject({ state: 'page' });
    // В логе — номер заявки, без чата гостя и без названий.
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/7002|Гейзер/);
    warn.mockRestore();
  });

  it('называть нечего: ответ не «Занято», заезд прошёл, не нашли, зона не размечена, не прочиталось, база упала — гостю ничего', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases = [
      world({ subject: null }),
      world({ subject: { ...SUBJECT, check_in: '2027-06-30', check_out: '2027-07-02' } }),
      world({ load: { state: 'none' } }),
      world({ load: { state: 'unzoned' } }),
      world({ load: { state: 'failed' } }),
    ];
    for (const w of cases) {
      expect(await tellGuestOtherStays(REQ, w)).toEqual({ state: 'nothing' });
      expect(w.sendMax).not.toHaveBeenCalled();
    }
    // Заезд прошёл — подбор даже не зовётся.
    expect(cases[1]!.load).not.toHaveBeenCalled();
    // Сегодняшний заезд — ещё впереди.
    expect(await tellGuestOtherStays(REQ, world({ subject: { ...SUBJECT, check_in: '2027-07-01' } }))).toMatchObject({ state: 'sent' });
    const broken = world();
    broken.query.mockRejectedValue(Object.assign(new Error('db'), { code: '57P01' }));
    expect(await tellGuestOtherStays(REQ, broken)).toEqual({ state: 'nothing' });
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('вид заявки: поле other_stays', () => {
  const STAY: StatusRow = {
    key_id: 'K', tool_name: 'create_stay_request', lead_id: null, seat_request_id: null, stay_request_id: 'SR',
    lead_status: null, route_title: null, booking_status: null, booking_date: null, booking_participants: null, booking_tour: null,
    seat_status: null, deadline_at: null, answered_at: null, seat_date: null, seat_participants: null, alt_date: null, failure_kind: null, seat_tour: null,
    lead_consent_at: null, lead_consent_source: null, seat_consent_at: null, seat_consent_source: null,
    stay_accommodation_id: REFUSED, stay_name: 'Кутха', stay_check_in: IN, stay_check_out: OUT, stay_guests: 2,
    stay_owner_channel: 'max', stay_platform_channel: 'max', stay_delivery_recorded_at: new Date(NOW),
    stay_consent_at: new Date(NOW), stay_consent_source: 'mcp',
  } as StatusRow;
  const BUSY: StatusRow = { ...STAY, stay_owner_answer: 'busy' };
  const ask = (row: StatusRow, today = '2027-07-01') => otherStaysAsk(row, buildRequestView(row, NOW), today);
  const OK = {
    state: 'ok' as const, zoneName: 'Авачинская зона',
    items: [
      { id: 'r-1', name: 'Отель', type: 'hotel', dates: 'calendar' as const, priceFrom: 6000, stayTotal: 24000, url: `${BASE}/accommodations/r-1?check_in=${IN}` },
      { id: 'q-1', name: 'Дом', type: 'igloo', dates: 'by_request' as const, priceFrom: null, stayTotal: null, url: `${BASE}/accommodations/q-1?check_in=${IN}` },
    ],
  };

  it('называть — только после «Занято» и пока заезд впереди; в чтение идут объект, ночи и гости', () => {
    expect(ask(BUSY)).toEqual({ accommodationId: REFUSED, checkIn: IN, checkOut: OUT, guests: 2 });
    expect(ask(STAY)).toBeNull();
    expect(ask({ ...STAY, stay_owner_answer: 'free' })).toBeNull();
    expect(ask({ ...STAY, stay_owner_answer: 'call' })).toBeNull();
    // Заезд сегодня — ещё впереди; вчера — уже нет.
    expect(ask(BUSY, IN)).not.toBeNull();
    expect(ask(BUSY, '2027-07-11')).toBeNull();
    expect(ask({ ...BUSY, stay_guests: null })?.guests).toBeNull();
    expect(ask({ ...BUSY, stay_check_out: IN })).toBeNull();
    // Заявка на тур с отказом — не про жильё.
    expect(otherStaysAsk(BUSY, { kind: 'lead', state: 'declined' }, '2027-07-01')).toBeNull();
  });

  it('названо: тем же порядком, что отдал загрузчик; тип — словом или null; агенту сказано, что это и что с этим делать', async () => {
    const load = vi.fn(async () => OK);
    const o = await readStatusOtherStays(BUSY, buildRequestView(BUSY, NOW), { load, now: () => NOW });
    expect(o).toMatchObject({
      state: 'listed', zone: 'Авачинская зона', check_in: IN, check_out: OUT, guests: 2,
      stays: [
        { name: 'Отель', accommodation_id: 'r-1', type: 'Отель', dates: 'calendar', price_from: 6000, stay_total: 24000 },
        { name: 'Дом', accommodation_id: 'q-1', type: null, dates: 'by_request', price_from: null, stay_total: null },
      ],
    });
    expect(load).toHaveBeenCalledWith({ accommodationId: REFUSED, checkIn: IN, checkOut: OUT, guests: 2 });
    expect(o!.how).toContain('не ответ хозяев этих объектов');
    expect(o!.how).toContain('create_stay_request');
    expect(o!.how).toContain('только после его согласия');
    expect(o!.how).toContain('жильё выбирает человек, не вы');
    expect(o!.how).toContain(OTHER_STAYS_ORDER_NOTE_RU);
    expect(o!.how).toContain(`${OTHER_STAYS_LIMIT_NOTE_RU} Искать шире — search_accommodations.`);
  });

  it('не найдено — «none»; не прочиталось, бросило или зависло — «failed»; зона не размечена — поля нет вовсе', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const core = buildRequestView(BUSY, NOW);
    const read = (load: Parameters<typeof readStatusOtherStays>[2] extends infer D ? D extends { load?: infer L } ? L : never : never, timeoutMs?: number) =>
      readStatusOtherStays(BUSY, core, { load, now: () => NOW, timeoutMs });
    const none = await read(vi.fn(async () => ({ state: 'none' as const })));
    expect(none).toMatchObject({ state: 'none', zone: null, stays: [], check_in: IN, guests: 2 });
    expect(none!.how).toContain('не нашёл');
    for (const o of [
      await read(vi.fn(async () => ({ state: 'failed' as const }))),
      await read(vi.fn(async () => { throw new Error('boom'); })),
      await read(vi.fn(() => new Promise<never>(() => {})), 20),
    ]) {
      expect(o).toMatchObject({ state: 'failed', stays: [] });
      expect(o!.how).toContain('не значит, что его нет');
    }
    // «Рядом» не искали — сказать «не нашёл» было бы неправдой.
    expect(await read(vi.fn(async () => ({ state: 'unzoned' as const })))).toBeNull();
    warn.mockRestore();
  });

  it('странице — тот же список без слов для агента; поля объявлены в схеме инструмента', async () => {
    const o = await readStatusOtherStays(BUSY, buildRequestView(BUSY, NOW), { load: vi.fn(async () => OK), now: () => NOW });
    const page = pageOtherStays(o);
    expect(page).not.toHaveProperty('how');
    expect(page!.stays).toEqual(o!.stays);
    expect(pageOtherStays(null)).toBeNull();
    const schema = GET_REQUEST_STATUS_TOOL.outputSchema.properties.other_stays;
    expect(Object.keys(o!).sort()).toEqual(Object.keys(schema.properties).sort());
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    for (const s of o!.stays) expect(Object.keys(s).sort()).toEqual(Object.keys(schema.properties.stays.items.properties).sort());
    expect([...schema.properties.state.enum]).toEqual([...OTHER_STAYS_STATES]);
    // После «Занято» агенту сказано, где список.
    expect(buildRequestView(BUSY, NOW).next).toContain('other_stays');
  });
});

describe('нажатие хозяина', () => {
  const KUTKHA = { partnerId: '22222222-2222-4222-8222-222222222222', partnerName: 'Кутха' };
  const FACTS = { accommodation_name: 'Кутха', check_in: IN, check_out: OUT, guests: 2 };
  const SENT = { state: 'sent' as const, names: ['Отель', 'Дом', 'Третий', 'Четвёртый'] };

  it('«Занято»: после слов хозяина — сообщение Ведара; хозяину и менеджеру сказано, что названо и куда', async () => {
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    const tellOthers = vi.fn(async () => SENT);
    const r = await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max', tellOthers });
    expect(tellOthers).toHaveBeenCalledWith(REQ);
    // Сначала слова хозяина в переписку заявки, потом сообщение Ведара.
    expect(postMock.mock.invocationCallOrder[0]!).toBeLessThan(tellOthers.mock.invocationCallOrder[0]!);
    expect(r.tell).toEqual({ kind: 'answered', answer: 'busy', guestTold: true, others: SENT });
    expect(ownerStayAnswerText(r.tell)).toBe(
      '<b>Ваш ответ:</b> занято. Гостю сообщил. Ведар отдельным сообщением назвал гостю другое жильё на эти даты (4). Больше ничего делать не нужно.',
    );
    const manager = String(tgMock.mock.calls[0]![1]);
    expect(manager).toContain(`Другое жильё на эти даты в той же зоне (по календарю Ведара, это не ответ хозяев): «Отель», «Дом», «Третий» и ещё ${SENT.names.length - MANAGER_STAYS_MAX}. Гостю оно названо сообщением в MAX.`);
  });

  it('гость без MAX или MAX не принял — хозяину и менеджеру сказано «на странице заявки», а не «назвал сообщением»', () => {
    const page = { state: 'page' as const, names: ['Отель'] };
    const owner = ownerStayAnswerText({ kind: 'answered', answer: 'busy', guestTold: true, others: page });
    expect(owner).toContain('Другое жильё на эти даты (1) Ведар показывает гостю на странице его заявки: в MAX оно не ушло или MAX у гостя не подключён.');
    expect(owner).not.toContain('отдельным сообщением');
    const manager = managerStayAnswerText({
      partnerName: 'Кутха', requestId: REQ, answer: 'busy', facts: { accommodationName: 'Кутха', checkIn: IN, checkOut: OUT, guests: 2 }, others: page,
    });
    expect(manager).toContain('В MAX гостю оно не ушло или MAX у него не подключён — список стоит на странице его заявки.');
    expect(manager).not.toContain('названо сообщением в MAX');
  });

  it('называть было нечего — о другом жилье ни слова; у «Свободно» и «Позвоню» сообщение Ведара не зовётся', async () => {
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    const nothing = vi.fn(async () => null);
    const r = await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max', tellOthers: nothing });
    expect(ownerStayAnswerText(r.tell)).toBe('<b>Ваш ответ:</b> занято. Гостю сообщил. Больше ничего делать не нужно.');
    expect(String(tgMock.mock.calls[0]![1])).not.toContain('Другое жильё на эти даты');
    for (const answer of ['free', 'call'] as const) {
      pool.mockResolvedValueOnce({ rows: [FACTS] });
      const tellOthers = vi.fn(async () => SENT);
      const other = await answerStayRequest({ partner: KUTKHA, requestId: REQ, answer, via: 'max', tellOthers });
      expect(tellOthers, answer).not.toHaveBeenCalled();
      expect(other.tell).toEqual({ kind: 'answered', answer, guestTold: true });
      // Даже если бы список пришёл, у этих ответов он хозяину не называется.
      expect(ownerStayAnswerText({ kind: 'answered', answer, guestTold: true, others: SENT })).not.toContain('другое жильё');
    }
  });

  it('сообщение Ведара упало или зависло — ответ хозяина записан, гостю его слова ушли, о другом жилье не сказано', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    pool.mockResolvedValueOnce({ rows: [FACTS] });
    const thrown = await answerStayRequest({
      partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max', tellOthers: vi.fn(async () => { throw new Error('boom'); }),
    });
    expect(thrown.tell).toEqual({ kind: 'answered', answer: 'busy', guestTold: true, others: null });
    expect(tgMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      pool.mockResolvedValueOnce({ rows: [FACTS] });
      let done: Awaited<ReturnType<typeof answerStayRequest>> | undefined;
      const run = answerStayRequest({
        partner: KUTKHA, requestId: REQ, answer: 'busy', via: 'max', tellOthers: vi.fn(() => new Promise<null>(() => {})),
      }).then((x) => { done = x; });
      await vi.advanceTimersByTimeAsync(OTHER_STAYS_PRESS_BUDGET_MS - 1);
      expect(done).toBeUndefined();
      await vi.advanceTimersByTimeAsync(2);
      await run;
      expect(done!.tell).toEqual({ kind: 'answered', answer: 'busy', guestTold: true, others: null });
      expect(ownerStayAnswerText(done!.tell)).not.toContain('другое жильё');
    } finally {
      vi.useRealTimers();
      error.mockRestore();
    }
  });
});
