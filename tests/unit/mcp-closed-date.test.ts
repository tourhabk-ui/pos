/**
 * Заявка на дату, которую закрыл Ведар по оценке (1421, 1435), и другие
 * компании к месту на дату — вызовом роута (план «после отказа», этап 6).
 *
 * Держит: заявка на такую дату уходит оператору вопросом, а не отказом «нет
 * мест»; «закрыл Ведар» говорится только по признаку из базы — не прочиталось
 * или закрыл оператор — прежний отказ; вместо «предложите другой тур» названы
 * компании с турами к тому же месту, а выбор остаётся за человеком.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import Ajv from 'ajv';
import type { CharterCarrier } from '@/lib/transfers/charter-format';

const { createLeadMock, query, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock, avail, offersMock } = vi.hoisted(() => ({
  offersMock: vi.fn(),
  createLeadMock: vi.fn(async (_: Record<string, unknown>) => 'lead-1' as string | null),
  query: vi.fn(),
  seatRequestMock: vi.fn(),
  sendPdAlertMock: vi.fn(),
  partnerNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
  personalNotifyMock: vi.fn(async () => ({ state: 'no_channel' })),
  avail: { remaining: 10, keepsSchedule: true },
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (p: Record<string, unknown>) => createLeadMock(p),
  createLeadDetailed: async (p: Record<string, unknown>) => { const id = await createLeadMock(p); return id ? { id, created: true } : null; },
  findRecentLeadByCommentPrefix: async () => null,
}));
vi.mock('@/lib/kuzmich/core', () => ({ executeKuzmichTool: async () => 'ok' }));
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: async (_id: string, from: string) => [{ date: from, remaining: avail.remaining, priceOverride: null }],
}));
vi.mock('@/lib/seat-requests/service', () => ({
  createSeatRequest: (...a: unknown[]) => seatRequestMock(...a),
  statusUrl: (t: string) => `https://vedarai.ru/seat/${t}`,
  tourKeepsSchedule: async () => avail.keepsSchedule,
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: (p: unknown) => sendPdAlertMock(p) }));
vi.mock('@/lib/notifications/partner-request-notify', () => ({ notifyPartnerRequestPersonally: (...a: unknown[]) => partnerNotifyMock(...(a as [])) }));
vi.mock('@/lib/notifications/lead-notify', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  notifyPartnerNewLeadPersonally: (...a: unknown[]) => personalNotifyMock(...(a as [])),
}));
vi.mock('@/lib/requests/other-offers', () => ({ loadOtherOffers: (...a: unknown[]) => offersMock(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query, connect: async () => ({ query, release: () => {} }) } }));
vi.mock('@/lib/rental/rental', () => ({
  loadRentalCompanies: async () => [{
    slug: 'test-prokat', name: 'Тест Прокат',
    offers: [{ title: 'Suzuki Jimny', priceRubPerDay: 5000, priceIsFrom: false, depositRub: 10000 }],
  }],
}));
const line = (to: string, priceRub: number) => ({ from: 'Петропавловск-Камчатский', to, priceRub, note: null, conditions: null, validYear: 2026 });
const CARRIER: CharterCarrier = {
  partnerId: 'partner-1', slug: 'shatun', name: 'Шатун', shortDescription: null, logo: null,
  vehicles: [{ kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 }],
  destinations: [line('Вулкан Авачинский', 65000)],
  extraDay: null, rates: [], seatClasses: [],
  photos: [], clips: [], legal: null, video: null,
  phone: '+79001112233', telegramHref: null, whatsappHref: null,
} as unknown as CharterCarrier;
vi.mock('@/lib/transfers/charter', () => ({ loadCharterCarriers: async () => [CARRIER] }));
import { POST } from '@/app/api/mcp/route';
import { WRITE_OUTPUT_SCHEMA } from '@/lib/mcp/test-run';
import { BOOKING_OFFERS_TIMEOUT_MS } from '@/lib/mcp/booking-closed-date';
import { DATE_CLOSED_BY_PLATFORM_SQL } from '@/lib/tours/date-closure';

const TOUR = { id: 70, title: 'Каньон Опасный', operator_id: 'op-uuid-1', base_price: 15000, price_unit: 'person', nearest_free_date: null };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const DATE = inDays(40);

let ip = 0;
async function call(args: Record<string, unknown>) {
  ip += 1;
  const res = await POST(new NextRequest('http://localhost/api/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.12.${Math.floor(ip / 250)}.${ip % 250}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_booking_request', arguments: args } }),
  }));
  return (await res.json()).result as { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
}
const BASE = { name: 'Иван Петров', phone: '+79001234567', consent: true, tour: '70', date: DATE, participants: 2 };

/** Что отвечает база на вопрос «дату закрыл Ведар?»: строки, пусто или отказ. */
let closure: 'platform' | 'no' | 'fails' = 'platform';
const OTHERS = {
  state: 'ok' as const, placeName: 'Каньон Опасный', placeUrl: 'https://vedarai.ru/places/kanon-opasnyj#tours', more: 2,
  offers: [
    { partnerId: 'p-b', partnerName: 'Компания Б', tourId: '201', title: 'К каньону на джипах', price: '12 000 ₽ за человека', seats: 'calendar' as const, url: 'https://vedarai.ru/catalog/tours/201', moreTours: 0, said: null },
    { partnerId: 'p-c', partnerName: 'Третья', tourId: '202', title: 'Каньон пешком', price: null, seats: 'by_request' as const, url: 'https://vedarai.ru/catalog/tours/202', moreTours: 0, said: null },
  ],
};

beforeEach(() => {
  process.env.MCP_HASH_SALT = 'соль-для-теста';
  avail.remaining = 0;
  avail.keepsSchedule = true;
  closure = 'platform';
  for (const m of [createLeadMock, seatRequestMock, sendPdAlertMock, partnerNotifyMock, personalNotifyMock]) m.mockClear();
  offersMock.mockReset().mockResolvedValue({ state: 'none' });
  sendPdAlertMock.mockResolvedValue({ delivered: true, channel: 'max', reason: 'доставлено в MAX' });
  query.mockReset().mockImplementation(async (sql: string) => {
    if (sql === DATE_CLOSED_BY_PLATFORM_SQL) {
      if (closure === 'fails') throw Object.assign(new Error('db'), { code: '57P01' });
      return { rows: closure === 'platform' ? [{ closed_by_platform: true }] : [] };
    }
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ a: '0', b: '0', c: '0' }] };
    if (/SELECT max_participants, group_size_unlimited, activity_type FROM operator_tours/.test(sql)) {
      return { rows: [{ max_participants: 12, group_size_unlimited: false, activity_type: 'jeep' }] };
    }
    if (/FROM operator_tours/.test(sql)) return { rows: [TOUR] };
    return { rows: [] };
  });
});

const lead = () => createLeadMock.mock.calls[0]?.[0] as { operator_id?: string; comment: string; source_data: Record<string, unknown> };
const closureAsked = () => query.mock.calls.filter((c) => c[0] === DATE_CLOSED_BY_PLATFORM_SQL);

describe('дата, которую закрыл Ведар, — заявка оператору вопросом, а не «нет мест» (этап 6)', () => {
  it('заявка создаётся оператору тура: в ней сказано, кто закрыл дату и что от него нужно', async () => {
    const r = await call(BASE);
    expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(closureAsked()[0]![1]).toEqual(['70', DATE]);
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    expect(lead().operator_id).toBe('op-uuid-1');
    expect(lead().comment).toContain(`[Заявка на бронь] Тур "Каньон Опасный" (ID70), дата ${DATE}, участников 2.`);
    expect(lead().comment).toContain('Дату в календаре закрыл Ведар по описанию тура (зимой тур под вопросом) — вы её не закрывали. Ходите ли вы в этот день? Если да — откройте дату в календаре.');
    expect(lead().source_data).toMatchObject({ tool: 'create_booking_request', tour_id: 70, date: DATE, participants: 2, date_closed_by: 'platform' });
    const text = r.content[0]!.text;
    expect(text).toContain(`Заявка оператору отправлена вопросом: "Каньон Опасный", ${DATE}.`);
    expect(text).toContain('Эту дату в календаре закрыл Ведар по описанию тура — оператор её не закрывал и не подтверждал');
    expect(text).toContain('Места заявка не закрепляет. Это заявка, не оплата.');
    // Что оператор ответит и перезвонит — не обещается; сказано, где появится ответ.
    expect(text).toContain('Оператору задан вопрос, ходит ли он в этот день: его ответ появится в статусе заявки');
    expect(text).not.toMatch(/[Оо]ператор (ответит|перезвонит)/);
    // Ни «мест нет», ни «оператор закрыл»: ни то ни другое о такой дате не правда.
    expect(text).not.toMatch(/нет свободных мест|заявка не создана|[Оо]ператор закрыл/);
    // Обещания «свободно N мест» тоже нет: мест на закрытой дате в системе нет.
    expect(text).not.toMatch(/свободно \d+ мест/);
    expect(new Ajv({ strict: false }).validate(WRITE_OUTPUT_SCHEMA, r.structuredContent)).toBe(true);
  });

  it('дату закрыл не Ведар (оператор, занята, строки нет) — прежний отказ, заявки нет', async () => {
    closure = 'no';
    const r = await call(BASE);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.content[0]!.text).toMatch(/нет свободных мест — заявка не создана/);
    expect(r.content[0]!.text).not.toMatch(/закрыл Ведар/);
  });

  it('кто закрыл, не прочиталось — «закрыл Ведар» не утверждается: прежний отказ, заявки нет', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    closure = 'fails';
    const r = await call(BASE);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.content[0]!.text).toMatch(/нет свободных мест — заявка не создана/);
    expect(r.content[0]!.text).not.toMatch(/закрыл Ведар/);
    expect(error.mock.calls.flat().join(' ')).toMatch(/date-closure.*57P01/);
    error.mockRestore();
  });

  it('места на дате есть, но меньше группы — дата открыта: признак не спрашивается, отказ прежний', async () => {
    avail.remaining = 1;
    const r = await call(BASE);
    expect(closureAsked()).toHaveLength(0);
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.content[0]!.text).toMatch(/только 1 мест, а нужно 2 — заявка не создана/);
  });

  it('пробный вызов: сказано, что ушло бы оператору вопросом; заявки нет', async () => {
    const r = await call({ ...BASE, test: true });
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(r.content[0]!.text).toContain('заявка оператору вопросом: тур "Каньон Опасный" (ID70)');
    expect(r.content[0]!.text).toContain('дату в календаре закрыл Ведар по описанию тура, оператор её не закрывал');
  });
});

describe('другие компании к месту на дату — вместо «предложите другой тур» (этап 6)', () => {
  it('отказ «мест нет»: названы компании с турами к тому же месту; выбор — за человеком', async () => {
    closure = 'no';
    offersMock.mockResolvedValue(OTHERS);
    const r = await call(BASE);
    expect(createLeadMock).not.toHaveBeenCalled();
    // Список спрошен по туру, дате и числу людей заявки — без заявки и без телефона.
    expect(offersMock.mock.calls[0]![0]).toEqual({ tourId: 70, date: DATE, people: 2 });
    const text = r.content[0]!.text;
    expect(text).toMatch(/нет свободных мест — заявка не создана/);
    expect(text).not.toContain('предложите другой тур');
    expect(text).toContain(`К тому же месту («Каньон Опасный») на ${DATE} есть туры других компаний:`);
    expect(text).toContain('1. «Компания Б» — тур "К каньону на джипах" (ID201), 12 000 ₽ за человека; в календаре на эту дату места на 2 чел. есть.');
    expect(text).toContain('2. «Третья» — тур "Каньон пешком" (ID202), цена не указана; расписания на Ведаре нет — дату подтверждает оператор.');
    expect(text).toContain('И ещё компаний: 2 — на карточке места: https://vedarai.ru/places/kanon-opasnyj#tours');
    expect(text).toContain('Это не ответ этих компаний, а их календарь на Ведаре');
    expect(text).toContain('Тур и компанию выбирает человек');
    expect(text).toMatch(/Место в списке не продаётся\.$/);
    expect(text).not.toMatch(/лучш|дешевл|рекоменд|советуем/i);
    // Имени и телефона человека в списке нет.
    expect(text.slice(text.indexOf('К тому же месту'))).not.toMatch(/Иван|Петров|9001234567/);
  });

  it('дата закрыта Ведаром: заявка ушла вопросом, и те же компании названы — оператор может не ходить', async () => {
    offersMock.mockResolvedValue(OTHERS);
    const r = await call(BASE);
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const text = r.content[0]!.text;
    expect(text).toContain('Заявка оператору отправлена вопросом');
    expect(text).toContain(`К тому же месту («Каньон Опасный») на ${DATE} есть туры других компаний:`);
    // Список — последним блоком: после слов о заявке, а не посреди них.
    expect(text.indexOf('К тому же месту')).toBeGreaterThan(text.indexOf('Места заявка не закрепляет'));
    expect(text).toMatch(/Место в списке не продаётся\.$/);
  });

  it('других нет или список не прочитался — прежние слова; «других нет» не говорится', async () => {
    closure = 'no';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const answer of [{ state: 'none' }, { state: 'failed' }, { ...OTHERS, offers: [] }]) {
      offersMock.mockResolvedValue(answer);
      const text = (await call(BASE)).content[0]!.text;
      expect(text, JSON.stringify(answer.state)).toMatch(/В ближайшие 30 дней подходящих дат нет — предложите другой тур\.$/);
      expect(text).not.toMatch(/других компаний|других нет/);
    }
    offersMock.mockRejectedValue(Object.assign(new Error('db'), { code: '57014' }));
    const broken = (await call(BASE)).content[0]!.text;
    expect(broken).toMatch(/предложите другой тур\.$/);
    expect(error.mock.calls.flat().join(' ')).toMatch(/другие компании на дату не прочитаны.*57014/);
    error.mockRestore();
  });

  it('список завис — ответ не ждёт его дольше срока и идёт без списка', async () => {
    closure = 'no';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      offersMock.mockImplementation(() => new Promise<never>(() => undefined));
      const pending = call(BASE);
      await vi.advanceTimersByTimeAsync(BOOKING_OFFERS_TIMEOUT_MS + 50);
      const text = (await pending).content[0]!.text;
      expect(text).toMatch(/нет свободных мест — заявка не создана/);
      expect(text).not.toContain('других компаний');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('описание create_booking_request называет заявку-вопрос на дату, закрытую Ведаром', () => {
  // Урок аудита 09.11 (группа сверх выезда): поведение, которого нет в описании,
  // агент человеку не обещает — он обещает отказ.
  it('третий случай запроса вместо отказа назван, и фраза о согласии в копии для моста не обрезана', async () => {
    const { BOOKING_REQUEST_TOOL } = await import('@/lib/mcp/public-tools');
    expect(BOOKING_REQUEST_TOOL.description)
      .toMatch(/Запрос оператору вместо отказа, без закрепления мест:[^.]*дату закрыл Ведар, не оператор, — вопрос, ходит ли он в этот день\./);
    expect(BOOKING_REQUEST_TOOL.description).not.toMatch(/в двух случаях/);
  });
});
