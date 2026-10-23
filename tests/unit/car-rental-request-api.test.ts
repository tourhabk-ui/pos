// @vitest-environment node
/**
 * Заявка на прокат автомобиля с формы на странице прокатчика
 * (POST /api/car-rental-requests, витрина проката 23.10, схема 1317).
 *
 * Сторож держит вызовом роута:
 *   · лид ложится прокатчику (operator_id) общим путём: согласие записано
 *     текстом «прокату автомобилей», источник — страница, `source_data.kind =
 *     'car_rental'`, без AI-подбора; повтор — прежний лид, второго нет, и
 *     ответ неотличим от первого;
 *   · без согласия, с машиной не из прайса, с кривыми датами — отказ с полем,
 *     ничего не записано; отказ базы — 503 и строка в логе без телефона и
 *     имени, а не «нет такого»;
 *   · загрузчик: прокатчик — публичный партнёр со slug и живым прайсом, без
 *     фильтра по категории; условия и признак «также перевозчик» — тем же
 *     запросом.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createLeadMock, recentLeadMock, companyBySlug, dbQuery } = vi.hoisted(() => ({
  createLeadMock: vi.fn(),
  recentLeadMock: vi.fn(),
  companyBySlug: vi.fn(),
  dbQuery: vi.fn(),
}));

const { notifyMock, recordMock } = vi.hoisted(() => ({ notifyMock: vi.fn(), recordMock: vi.fn() }));
// Личная доставка прокатчику (23.10) — свой модуль со своим сторожем; здесь — что её зовут и чем.
vi.mock('@/lib/notifications/partner-request-notify', () => ({ notifyPartnerRequestPersonally: (...a: unknown[]) => notifyMock(...a) }));
vi.mock('@/lib/leads/delivery-outcome', () => ({ recordPartnerDelivery: (...a: unknown[]) => recordMock(...a) }));
vi.mock('@/lib/leads/create', () => ({
  createLead: (...a: unknown[]) => createLeadMock(...a),
  findRecentLeadByCommentPrefix: (...a: unknown[]) => recentLeadMock(...a),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/rental/rental', async (orig) => ({
  ...(await orig<typeof import('@/lib/rental/rental')>()),
  loadRentalCompanyBySlug: (...a: unknown[]) => companyBySlug(...a),
}));

import { POST } from '@/app/api/car-rental-requests/route';
import { PD_CONSENT_RENTAL_VERSION } from '@/lib/legal/pd-consent';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { addDays } from '@/lib/transfers/charter-request-service';
import { checkRentalDates } from '@/lib/rental/rental-request-service';
import type { RentalCompanyProfile, RentalOffer } from '@/lib/rental/rental-format';

const offer = (over: Partial<RentalOffer> = {}): RentalOffer => ({
  id: 'o-1', title: 'Toyota Land Cruiser Prado', bodyKind: 'suv', seats: 5, transmission: 'automatic', drive: '4wd',
  engineHp: null, priceRubPerDay: 7000, priceIsFrom: false, depositRub: 30000, driver: 'optional',
  conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null, ...over,
});

const COMPANY: RentalCompanyProfile = {
  partnerId: 'p-1', slug: 'laguna', name: 'Лагуна Прокат', shortDescription: null, description: null, verified: false,
  photos: [], phone: '+79001112233', telegramHref: null, legal: null, terms: null, alsoCarrier: false,
  offers: [offer(), offer({ id: 'o-2', title: 'ГАЗ Соболь', priceRubPerDay: 25000, priceIsFrom: true, depositRub: null, driver: 'self' })],
};

const today = kamchatkaToday();
let ip = 0;
const body = (over: Record<string, unknown> = {}) => ({
  company: 'laguna', car: 'Toyota Land Cruiser Prado', date_from: addDays(today, 30), date_to: addDays(today, 32),
  name: 'Анна Петрова', phone: '+7 900 123-45-67', pd_consent: true, ...over,
});
const post = (b: unknown, headers: Record<string, string> = {}) => {
  ip += 1;
  return POST(new NextRequest('https://vedarai.ru/api/car-rental-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.0.0.${ip}`, ...headers },
    body: JSON.stringify(b),
  }));
};

beforeEach(() => {
  createLeadMock.mockReset().mockResolvedValue('lead-1');
  recentLeadMock.mockReset().mockResolvedValue(null);
  companyBySlug.mockReset().mockResolvedValue(COMPANY);
  dbQuery.mockReset();
  notifyMock.mockReset().mockResolvedValue({ state: 'no_channel' });
  recordMock.mockReset().mockResolvedValue(true);
});

describe('POST /api/car-rental-requests: заявка ложится прокатчику', () => {
  it('лид с operator_id, согласие «прокату автомобилей», kind car_rental, без AI-подбора; строка прайса в ответе', async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      success: true,
      data: {
        company: 'Лагуна Прокат', car: 'Toyota Land Cruiser Prado', date_from: addDays(today, 30), date_to: addDays(today, 32),
        days: 3, price: { rub_per_day: 7000, is_from: false },
      },
    });

    expect(companyBySlug).toHaveBeenCalledWith('laguna');
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const lead = createLeadMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(lead).toMatchObject({
      operator_id: 'p-1', phone: '+79001234567', skip_ai_processing: true, route_title: 'Прокат: Toyota Land Cruiser Prado', is_self: false,
    });
    expect(String(lead.source_url)).toMatch(/\/car-rental\/laguna$/);
    expect(lead.pd_consent).toMatchObject({ version: PD_CONSENT_RENTAL_VERSION, source: 'car-rental-page', ip: '10.0.0.1' });
    expect(lead.source_data).toEqual({
      source: 'car_rental_page', kind: 'car_rental', company_id: 'p-1', company_slug: 'laguna',
      offer_title: 'Toyota Land Cruiser Prado', date_from: addDays(today, 30), date_to: addDays(today, 32), days: 3,
      price_rub_per_day: 7000, price_is_from: false, driver: 'optional',
    });
    expect(String(lead.comment)).toMatch(/^\[Заявка на прокат\] «Лагуна Прокат», с /);
    expect(String(lead.comment)).toContain('3 дня');
    expect(String(lead.comment).replace(/\u00a0/g, ' ')).toContain('машина по прайсу: Toyota Land Cruiser Prado — 7 000 ₽/сутки, без водителя или с водителем — цена водителя отдельно');
    expect(String(lead.comment)).toContain('залог по прайсу 30000 руб');
    expect(String(lead.comment)).toContain('телефон прокатчика: +79001112233');
    // Суммы нет: что входит в цену, не записано (§4.0).
    expect(String(lead.comment)).not.toMatch(/21 ?000|итог/);
    expect(recentLeadMock).toHaveBeenCalledWith('+79001234567', `[Заявка на прокат] «Лагуна Прокат», с ${body().date_from},`);
  });

  it('цена «от» — так и записана, залог не выдуман', async () => {
    const json = await (await post(body({ car: 'ГАЗ Соболь', comment: 'заберу у аэропорта' }))).json();
    expect(json).toMatchObject({ success: true, data: { car: 'ГАЗ Соболь', price: { rub_per_day: 25000, is_from: true } } });
    const lead = createLeadMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(lead.source_data).toMatchObject({ price_is_from: true, driver: 'self' });
    expect(String(lead.comment)).toContain('цена «от» — точную назовёт прокатчик');
    expect(String(lead.comment)).not.toContain('залог');
    expect(String(lead.comment)).toContain('пожелания: заберу у аэропорта');
  });

  it('повтор: прежняя заявка, второй нет; ответ неотличим от первого', async () => {
    const first = await (await post(body())).json();
    recentLeadMock.mockResolvedValue('lead-1');
    createLeadMock.mockClear();
    const again = await (await post(body())).json();
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(again).toEqual(first);
  });

  it('свой визит владельца помечен is_self — вне счёта спроса (1145)', async () => {
    const { SELF_VISIT_COOKIE } = await import('@/lib/analytics/self-visit');
    const res = await post(body(), { cookie: `${SELF_VISIT_COOKIE}=1` });
    expect(res.status).toBe(200);
    expect((createLeadMock.mock.calls[0]![0] as Record<string, unknown>).is_self).toBe(true);
  });
});

describe('POST /api/car-rental-requests: отказ — с полем, ничего не записано', () => {
  const refused = async (b: unknown, status: number, field?: string) => {
    const res = await post(b);
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.success).toBe(false);
    if (field) expect(json.field).toBe(field);
    expect(createLeadMock).not.toHaveBeenCalled();
    return json as { error: string };
  };

  it('без согласия', async () => {
    const j = await refused(body({ pd_consent: false }), 400, 'pd_consent');
    expect(j.error).toMatch(/согласие/);
  });
  it('машина не из прайса — 400 с полем car', async () => {
    const j = await refused(body({ car: 'Toyota Land Cruiser 200' }), 400, 'car');
    expect(j.error).toContain('нет в прайсе');
  });
  it('телефон не похож на номер', async () => { await refused(body({ phone: 'привет' }), 400, 'phone'); });
  it('дата начала прошла', async () => { await refused(body({ date_from: addDays(today, -1), date_to: addDays(today, 1) }), 400, 'date_from'); });
  it('дата начала дальше 400 дней', async () => { await refused(body({ date_from: addDays(today, 401), date_to: addDays(today, 402) }), 400, 'date_from'); });
  it('возврат раньше начала', async () => { await refused(body({ date_from: addDays(today, 30), date_to: addDays(today, 29) }), 400, 'date_to'); });
  it('аренда дольше 30 дней', async () => { await refused(body({ date_from: addDays(today, 30), date_to: addDays(today, 60) }), 400, 'date_to'); });
  it('без даты возврата — отказ: цена за сутки без числа суток ничего не говорит', async () => {
    await refused(body({ date_to: undefined }), 400, 'date_to');
  });
  it('такого прокатчика нет — 404', async () => {
    companyBySlug.mockResolvedValue(null);
    await refused(body({ company: 'nobody' }), 404);
  });
  it('база не ответила — 503 и строка в логе с SQLSTATE, без телефона и имени', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    companyBySlug.mockRejectedValue(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    await refused(body(), 503);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sqlstate=57P01'), expect.any(String));
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toMatch(/Анна|Петрова|9001234567/);
    err.mockRestore();
  });
  it('запись не прошла — 503, не «принято»', async () => {
    createLeadMock.mockResolvedValue(null);
    expect((await post(body())).status).toBe(503);
  });
});

describe('правило дат — вызовом', () => {
  it('30 суток включительно — да, 31 — нет; дата возврата обязательна по типу', () => {
    expect(checkRentalDates(addDays(today, 1), addDays(today, 30), today)).toEqual({ ok: true });
    expect(checkRentalDates(addDays(today, 1), addDays(today, 31), today)).toMatchObject({ ok: false, reason: 'bad_return', field: 'date_to', maxDays: 30 });
    expect(checkRentalDates(today, today, today)).toEqual({ ok: true });
    expect(checkRentalDates('2027-02-30', '2027-03-01', today)).toMatchObject({ ok: false, reason: 'not_in_calendar', field: 'date_from' });
    expect(checkRentalDates(addDays(today, 1), '2027-02-30', today)).toMatchObject({ ok: false, reason: 'not_in_calendar', field: 'date_to' });
  });
});

describe('загрузчик прокатчика (lib/rental/rental)', () => {
  const partnerRow = {
    id: 'p-1', slug: 'laguna', name: 'Лагуна Прокат', short_description: null, hero_image: null, gallery: [],
    gallery_credits: {}, contacts: { phone: '+7 (900) 111-22-33' }, is_verified: false, description: 'Прокат в городе',
    legal_info: { companyName: 'ИП Лагунова', inn: '410100000011' },
    terms_items: ['Залог возвращается', ''], terms_source_url: null, terms_seen_on: '2026-10-23', also_carrier: true,
  };
  const offerRow = {
    id: 'o-1', partner_id: 'p-1', title: 'Prado', body_kind: 'suv', seats: null, transmission: null, drive: null, engine_hp: null,
    price_rub_per_day: 7000, price_is_from: false, deposit_rub: null, driver: 'self', conditions: null, source_url: null, prices_seen_on: null,
  };

  it('прокатчик — публичный партнёр с живым прайсом, без фильтра по категории; условия и «также перевозчик» — тем же запросом', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (/FROM partners p/.test(sql)) return { rows: [partnerRow] };
      if (/FROM car_rental_offers o/.test(sql)) return { rows: [offerRow] };
      return { rows: [] };
    });
    const actual = await vi.importActual<typeof import('@/lib/rental/rental')>('@/lib/rental/rental');
    const c = await actual.loadRentalCompanyBySlug('laguna');
    expect(c).toMatchObject({
      name: 'Лагуна Прокат', verified: false, description: 'Прокат в городе', phone: '+79001112233', alsoCarrier: true,
      legal: { name: 'ИП Лагунова', inn: '410100000011', ogrn: null },
      terms: { items: ['Залог возвращается'], sourceUrl: null, seenOn: '2026-10-23' },
    });
    expect(c!.offers).toEqual([{
      id: 'o-1', title: 'Prado', bodyKind: 'suv', seats: null, transmission: null, drive: null, engineHp: null,
      priceRubPerDay: 7000, priceIsFrom: false, depositRub: null, driver: 'self', conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null,
    }]);
    const partnerSql = String(dbQuery.mock.calls.find((x) => /FROM partners p/.test(String(x[0])))?.[0]).replace(/\s+/g, ' ');
    expect(partnerSql).toContain('p.is_public = TRUE');
    expect(partnerSql).toContain('EXISTS (SELECT 1 FROM car_rental_offers o WHERE o.partner_id = p.id AND o.is_active)');
    expect(partnerSql).not.toMatch(/category/);
    expect(partnerSql).toContain('LEFT JOIN car_rental_terms t ON t.partner_id = p.id');
  });

  it('такого прокатчика нет — null, прайс не спрашивается; список по алфавиту без категории', async () => {
    dbQuery.mockResolvedValue({ rows: [] });
    const actual = await vi.importActual<typeof import('@/lib/rental/rental')>('@/lib/rental/rental');
    expect(await actual.loadRentalCompanyBySlug('nobody')).toBeNull();
    expect(dbQuery).toHaveBeenCalledTimes(1);
    dbQuery.mockClear();
    expect(await actual.loadRentalCompanies()).toEqual([]);
    const listSql = String(dbQuery.mock.calls[0]![0]).replace(/\s+/g, ' ');
    expect(listSql).toContain('ORDER BY lower(p.name), p.id');
    expect(listSql).not.toMatch(/category/);
  });
});

describe('POST /api/car-rental-requests: после записи — лично прокатчику', () => {
  it('факты машины и дат без телефона прокатчика, ПД заказчика; исход доставки — в журнал лида', async () => {
    await post(body({ comment: 'Нужны цепи' }));
    await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledTimes(1));
    const n = notifyMock.mock.calls[0]![0] as { partnerId: string; leadId: string; kind: string; lines: string[]; phone: string; comment: string | null };
    expect(n).toMatchObject({ partnerId: 'p-1', leadId: 'lead-1', kind: 'car_rental', phone: '+79001234567', comment: 'Нужны цепи' });
    const lines = n.lines.join('\n').replace(/\u00a0/g, ' ');
    expect(lines).toContain('Машина: Toyota Land Cruiser Prado — 7 000 ₽/сутки');
    expect(lines).toContain(`Даты: с ${addDays(today, 30)} по ${addDays(today, 32)}, 3 дня`);
    expect(lines).toContain('Залог по прайсу: 30000 руб');
    expect(lines).not.toMatch(/телефон прокатчика|79001112233|уточнить у прокатчика/);
    await vi.waitFor(() => expect(recordMock).toHaveBeenCalledWith('lead-1', 'p-1', { state: 'no_channel' }));
  });

  it('повтор заявки прокатчика второй раз не будит', async () => {
    recentLeadMock.mockResolvedValue('lead-1');
    await post(body());
    await new Promise((r) => setTimeout(r, 0));
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
