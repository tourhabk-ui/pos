// @vitest-environment node
/**
 * Заявка на машину с формы на странице перевозчика (POST /api/charter-requests,
 * стандарт карточки трансфера 13.10) и данные этой страницы.
 *
 * Сторож держит:
 *   · путь записи общий с MCP request_charter: тот же текст менеджеру, тот же
 *     повтор (прежний лид, второго нет), лид — перевозчику (operator_id);
 *   · согласие записано текстом «передачу перевозчику», источник — страница;
 *   · без согласия, с прошедшей датой, с группой больше парка — отказ с полем,
 *     ничего не записано; отказ базы — 503 и строка в логе, а не «нет такого»;
 *   · ответ на повтор неотличим от ответа на новую заявку;
 *   · загрузчик: строка прайса ведёт на место только видимое и только по
 *     записанной связи; перевозчик — только публичный и категории transfer;
 *   · страница: отказ опасностей или отзывов не роняет прайс и заявку; поездок
 *     с местами страница не читает — машину заказывают целиком (13.10).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { createLeadMock, recentLeadMock, carrierBySlug, dbQuery } = vi.hoisted(() => ({
  createLeadMock: vi.fn(),
  recentLeadMock: vi.fn(),
  carrierBySlug: vi.fn(),
  dbQuery: vi.fn(),
}));

vi.mock('@/lib/leads/create', () => ({
  createLead: (...a: unknown[]) => createLeadMock(...a),
  findRecentLeadByCommentPrefix: (...a: unknown[]) => recentLeadMock(...a),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/transfers/charter', async (orig) => ({
  ...(await orig<typeof import('@/lib/transfers/charter')>()),
  loadCarrierBySlug: (...a: unknown[]) => carrierBySlug(...a),
}));

import { POST } from '@/app/api/charter-requests/route';
import { loadCarrierPage } from '@/lib/transfers/carrier-page';
import { PD_CONSENT_CARRIER_VERSION } from '@/lib/legal/pd-consent';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { addDays } from '@/lib/transfers/charter-request-service';
import type { CarrierProfile } from '@/lib/transfers/charter-format';

const line = (to: string, priceRub: number, note: string | null = null) => ({
  from: 'Петропавловск-Камчатский', to, priceRub, note, conditions: 'при расчёте наличными', validYear: 2026, place: null,
});

const CARRIER: CarrierProfile = {
  partnerId: 'p-1', slug: 'shatun', name: 'Шатун', shortDescription: null, description: null, verified: true,
  vehicles: [
    { kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 },
    { kind: 'vahtovka', title: 'КамАЗ-2', seats: 26 },
  ],
  destinations: [line('Вулкан Горелый', 75000), line('Курильское озеро', 450000, 'плюс переправы')],
  extraDay: null, photos: [], clips: [], legal: null, video: null,
  phone: '+79001112233', telegramHref: null, whatsappHref: null,
};

const today = kamchatkaToday();
let ip = 0;
const body = (over: Record<string, unknown> = {}) => ({
  carrier: 'shatun', destination: 'Вулкан Горелый', date_from: addDays(today, 30), passengers: 8,
  name: 'Анна Петрова', phone: '+7 900 123-45-67', pd_consent: true, ...over,
});
const post = (b: unknown) => {
  ip += 1;
  return POST(new NextRequest('https://vedarai.ru/api/charter-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.0.0.${ip}` },
    body: JSON.stringify(b),
  }));
};

beforeEach(() => {
  createLeadMock.mockReset().mockResolvedValue('lead-1');
  recentLeadMock.mockReset().mockResolvedValue(null);
  carrierBySlug.mockReset().mockResolvedValue(CARRIER);
  dbQuery.mockReset();
});

describe('POST /api/charter-requests: заявка ложится перевозчику общим путём', () => {
  it('по прайсу: лид с operator_id, согласие «перевозчику», источник — страница, строка прайса в ответе', async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ success: true, data: { carrier: 'Шатун', price_line: { to: 'Вулкан Горелый', price_rub: 75000 } } });

    expect(carrierBySlug).toHaveBeenCalledWith('shatun');
    expect(createLeadMock).toHaveBeenCalledTimes(1);
    const lead = createLeadMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(lead).toMatchObject({ operator_id: 'p-1', phone: '+79001234567', skip_ai_processing: true, route_title: 'Вахтовка: Вулкан Горелый' });
    expect(String(lead.source_url)).toMatch(/\/transfers\/shatun$/);
    expect(lead.pd_consent).toMatchObject({ version: PD_CONSENT_CARRIER_VERSION, source: 'transfer-page', ip: '10.0.0.1' });
    expect(lead.source_data).toMatchObject({ source: 'transfer_page', kind: 'charter', in_price_list: true, carrier_slug: 'shatun', passengers: 8 });
    expect(String(lead.comment)).toMatch(/^\[Заявка на машину\] «Шатун», с /);
    expect(String(lead.comment)).toContain('по прайсу: Вулкан Горелый 75000 руб за машину');
    // Повтор ищется тем же префиксом, что у MCP: два входа — одна заявка.
    expect(recentLeadMock).toHaveBeenCalledWith('+79001234567', `[Заявка на машину] «Шатун», с ${body().date_from},`);
  });

  it('повтор: прежняя заявка, второй нет; ответ неотличим от первого', async () => {
    const first = await (await post(body())).json();
    recentLeadMock.mockResolvedValue('lead-1');
    createLeadMock.mockClear();
    const again = await (await post(body())).json();
    expect(createLeadMock).not.toHaveBeenCalled();
    expect(again).toEqual(first);
  });

  it('направления нет в прайсе — заявка принимается, цену назовёт перевозчик', async () => {
    const json = await (await post(body({ destination: 'Мутновский' }))).json();
    expect(json).toMatchObject({ success: true, data: { price_line: null } });
    const lead = createLeadMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(lead.source_data).toMatchObject({ in_price_list: false });
    expect(String(lead.comment)).toContain('в прайсе такого направления нет');
  });
});

describe('POST /api/charter-requests: отказ — с полем, ничего не записано', () => {
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
  it('телефон не похож на номер', async () => { await refused(body({ phone: 'привет' }), 400, 'phone'); });
  it('дата выезда прошла', async () => { await refused(body({ date_from: addDays(today, -1) }), 400, 'date_from'); });
  it('возвращение раньше выезда', async () => {
    await refused(body({ date_from: addDays(today, 30), date_to: addDays(today, 29) }), 400, 'date_to');
  });
  it('людей больше, чем мест в парке', async () => {
    const j = await refused(body({ passengers: 53 }), 400, 'passengers');
    expect(j.error).toContain('52');
  });
  it('такого перевозчика нет — 404', async () => {
    carrierBySlug.mockResolvedValue(null);
    await refused(body({ carrier: 'nobody' }), 404);
  });
  it('база не ответила — 503 и строка в логе с SQLSTATE, а не «перевозчика нет»', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    carrierBySlug.mockRejectedValue(Object.assign(new Error('terminating connection'), { code: '57P01' }));
    await refused(body(), 503);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sqlstate=57P01'), expect.any(String));
    err.mockRestore();
  });
  it('запись не прошла — 503, не «принято»', async () => {
    createLeadMock.mockResolvedValue(null);
    const res = await post(body());
    expect(res.status).toBe(503);
  });
});

describe('загрузчик перевозчика (lib/transfers/charter)', () => {
  const partnerRow = {
    id: 'p-1', slug: 'shatun', name: 'Шатун', short_description: null, hero_image: null, gallery: [],
    video_url: null, video_poster_url: null, gallery_credits: {}, video_clips: [],
    // company_name триггер 052 держит равным вывеске — юрлицо из него не берётся.
    company_name: 'Шатун',
    legal_info: { companyName: 'ИП Миронова Нина Васильевна', inn: '250302356113' },
    contacts: null, is_verified: true, description: 'Две вахтовки',
  };
  const priceRow = (to: string, place: { id: string; slug: string | null; name: string } | null) => ({
    partner_id: 'p-1', vehicle_kind: 'vahtovka', line_kind: 'destination', from_text: 'Петропавловск-Камчатский',
    to_text: to, price_rub: 75000, price_note: null, conditions: null, valid_year: 2026,
    place_id: place?.id ?? null, place_slug: place?.slug ?? null, place_name: place?.name ?? null,
  });

  it('место — только по записанной связи и только видимое; адрес по slug; перевозчик — публичный transfer', async () => {
    dbQuery.mockImplementation(async (sql: string) => {
      if (/FROM partners p/.test(sql)) return { rows: [partnerRow] };
      if (/FROM transfer_charter_prices c/.test(sql)) {
        return { rows: [
          priceRow('Вулкан Горелый', { id: 'pl-gor', slug: 'vulkan-gorelyj', name: 'Вулкан Горелый' }),
          priceRow('Без слага', { id: 'pl-x', slug: null, name: 'Место без адреса' }),
          priceRow('Курильское озеро', null),
        ] };
      }
      return { rows: [] };
    });
    const actual = await vi.importActual<typeof import('@/lib/transfers/charter')>('@/lib/transfers/charter');
    const c = await actual.loadCarrierBySlug('shatun');
    expect(c).toMatchObject({ verified: true, description: 'Две вахтовки', name: 'Шатун' });
    expect(c!.legal).toEqual({ name: 'ИП Миронова Нина Васильевна', inn: '250302356113', ogrn: null });
    expect(c!.destinations.map((d) => d.place)).toEqual([
      { id: 'pl-gor', href: '/places/vulkan-gorelyj', name: 'Вулкан Горелый' },
      { id: 'pl-x', href: '/places/pl-x', name: 'Место без адреса' },
      null,
    ]);
    const partnerSql = String(dbQuery.mock.calls.find((x) => /FROM partners p/.test(String(x[0])))?.[0]);
    expect(partnerSql).toContain("p.category = 'transfer'");
    expect(partnerSql).toContain('p.is_public = TRUE');
    const priceSql = String(dbQuery.mock.calls.find((x) => /FROM transfer_charter_prices c/.test(String(x[0])))?.[0]).replace(/\s+/g, ' ');
    expect(priceSql).toContain('LEFT JOIN places pl ON pl.id = c.place_id AND pl.is_visible = TRUE');
  });

  it('такого перевозчика нет — null, прайс не спрашивается', async () => {
    dbQuery.mockResolvedValue({ rows: [] });
    const actual = await vi.importActual<typeof import('@/lib/transfers/charter')>('@/lib/transfers/charter');
    expect(await actual.loadCarrierBySlug('nobody')).toBeNull();
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});

describe('данные страницы: три исхода у каждой части', () => {
  const LINKED: CarrierProfile = {
    ...CARRIER,
    destinations: [
      { ...line('Вулкан Горелый', 75000), place: { id: 'pl-gor', href: '/places/vulkan-gorelyj', name: 'Вулкан Горелый' } },
      { ...line('Горелый (пещеры)', 80000), place: { id: 'pl-gor', href: '/places/vulkan-gorelyj', name: 'Вулкан Горелый' } },
    ],
  };

  it('опасности объединены по месту, шаблонные — не факт; поездок с местами страница не читает', async () => {
    carrierBySlug.mockResolvedValue(LINKED);
    dbQuery.mockResolvedValue({ rows: [
      { place_id: 'pl-gor', hazard_types: ['volcanic_gas', 'weather'], profile_source: 'manual' },
      { place_id: 'pl-gor', hazard_types: ['weather', 'rockfall'], profile_source: null },
      // Шаблон по типу места (миграция 070) — не факт: «лавины» вулкану не выдумываем.
      { place_id: 'pl-gor', hazard_types: ['avalanche', 'altitude'], profile_source: 'type_template' },
    ] });
    const d = await loadCarrierPage('shatun');
    expect(d && 'trips' in d).toBe(false);
    expect(dbQuery.mock.calls.some(([sql]) => /transfer_trips|transfer_seat_bookings/.test(String(sql)))).toBe(false);
    expect(d?.safety).toEqual({ state: 'ok', byPlace: { 'pl-gor': ['volcanic_gas', 'weather', 'rockfall'] } });
    // Одно место у двух строк — один вопрос к базе про него.
    expect(dbQuery.mock.calls[0]![1]).toEqual([['pl-gor']]);
  });

  it('отказ опасностей и отзывов — «не смогли» по каждой части, перевозчик и прайс на месте', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    carrierBySlug.mockResolvedValue(LINKED);
    dbQuery.mockRejectedValue(Object.assign(new Error('boom'), { code: '42P01' }));
    const d = await loadCarrierPage('shatun');
    expect(d?.carrier.name).toBe('Шатун');
    expect(d?.safety).toEqual({ state: 'failed' });
    // Отзывы — та же база: не прочитались — «не смогли», а не «отзывов нет».
    expect(d?.reviews).toEqual({ state: 'failed' });
    expect(err).toHaveBeenCalledWith(expect.stringContaining('sqlstate=42P01'), expect.any(String));
    err.mockRestore();
  });

  it('нет связанных мест — база про опасности не спрашивается; нет перевозчика — null', async () => {
    dbQuery.mockResolvedValue({ rows: [] });
    const d = await loadCarrierPage('shatun');
    expect(d?.safety).toEqual({ state: 'ok', byPlace: {} });
    expect(dbQuery.mock.calls.some(([sql]) => /location_safety_profile/.test(String(sql)))).toBe(false);
    expect(d?.reviews).toEqual({ state: 'ok', items: [], count: 0, average: null });
    carrierBySlug.mockResolvedValue(null);
    expect(await loadCarrierPage('nobody')).toBeNull();
  });
});

describe('свой визит владельца', () => {
  it('заявка с меткой своего визита помечена is_self — вне счёта спроса (1145)', async () => {
    const { SELF_VISIT_COOKIE } = await import('@/lib/analytics/self-visit');
    ip += 1;
    const res = await POST(new NextRequest('https://vedarai.ru/api/charter-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': `10.0.1.${ip}`, cookie: `${SELF_VISIT_COOKIE}=1` },
      body: JSON.stringify(body()),
    }));
    expect(res.status).toBe(200);
    expect((createLeadMock.mock.calls[0]![0] as Record<string, unknown>).is_self).toBe(true);
    createLeadMock.mockClear();
    await post(body({ phone: '+79007654321' }));
    expect((createLeadMock.mock.calls[0]![0] as Record<string, unknown>).is_self).toBe(false);
  });
});
