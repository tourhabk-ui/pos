// @vitest-environment node
/**
 * Гостевой дом «Кутха» (#2238, миграция 1179): карточка партнёра со звонком.
 *
 * Объект без своего сайта брони: цены и даты у владельца, связь — телефоном.
 * Держится:
 * 1. номер хранится и проверяется одной формой (+7 и десять цифр) — базой и кодом;
 * 2. в миграции только названное: цена не выдумана (единицы «от 28 000 ₽» нет),
 *    зона планера не угадана, повтор ничего не плодит;
 * 3. номер идёт на карточку и больше никуда: ни в публичный список, ни в ответы
 *    Кузьмича и MCP (модели зарубежные, pd-guard) — только признак «есть»;
 * 4. на карточке без номеров — звонок вместо фразы про «оператора платформы»
 *    (оплата платформой выключена 05.10), и нажатие считается спросом.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.hoisted(() => vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>());
vi.mock('@/lib/db-pool', () => ({ pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) } }));
vi.mock('@/lib/stay/demand-record', () => ({ recordAgentStaySearch: async () => {} }));

import { normalizeContactPhone, formatContactPhone } from '@/lib/stay/contact-phone';
import { searchAccommodationsForKuzmich } from '@/lib/kuzmich/accommodation-search';
import { FUNNEL_STEPS, EXECUTION_STEPS } from '@/lib/funnel/steps';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const MIG = 'migrations/1179_kutha_guesthouse.sql';

beforeEach(() => { poolQueryMock.mockReset(); });

describe('форма номера', () => {
  it('хранится «+7XXXXXXXXXX»; 8-форма приводится, мусор — null', () => {
    expect(normalizeContactPhone('+79622152777')).toBe('+79622152777');
    expect(normalizeContactPhone('8 (962) 215-27-77')).toBe('+79622152777');
    expect(normalizeContactPhone('+7 962 215-27-77')).toBe('+79622152777');
    for (const bad of [null, undefined, '', '12345', '+1234567890', 'javascript:alert(1)', '+7962215277', '+796221527771', 42]) {
      expect(normalizeContactPhone(bad), String(bad)).toBeNull();
    }
  });

  it('человеку — с пробелами и дефисами', () => {
    expect(formatContactPhone('+79622152777')).toBe('+7 962 215-27-77');
    expect(formatContactPhone(null)).toBeNull();
  });

  it('база проверяет ту же форму', () => {
    const sql = read(MIG);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS contact_phone TEXT/);
    expect(sql).toMatch(/contact_phone ~ '\^\\\+7\[0-9\]\{10\}\$'/);
  });
});

describe('миграция 1179', () => {
  const insert = read(MIG).slice(read(MIG).indexOf('INSERT INTO accommodations'));

  it('названо только слово владельца: имя, тип, координаты 2ГИС, телефон', () => {
    expect(insert).toMatch(/'Кутха'/);
    expect(insert).toMatch(/'guesthouse'/);
    expect(insert).toMatch(/'lat', 53\.094924, 'lng', 158\.5432/);
    expect(insert).toMatch(/'\+79622152777'/);
  });

  it('«от 28 000 ₽» — словами и без единицы, числом в цену не уходит (§4.0)', () => {
    expect(insert).not.toMatch(/price_per_night_from/);
    expect(insert).toMatch(/без единицы/);
  });

  it('это гостевой дом, не отель; зону планера не угадываем (1031); платформа ничего не продаёт', () => {
    expect(insert).not.toMatch(/отел/i);
    expect(insert).not.toMatch(/planner_zone/);
    expect(insert).toMatch(/платформа оплату не принимает/);
  });

  it('повтор ничего не плодит и не перетирает правки', () => {
    expect(insert).toMatch(/WHERE NOT EXISTS/);
    expect(insert).not.toMatch(/ON CONFLICT[\s\S]*DO UPDATE/);
  });
});

describe('номер не выходит за карточку (pd-guard)', () => {
  it('публичный список не выбирает contact_phone', () => {
    expect(read('app/api/accommodations/route.ts')).not.toMatch(/contact_phone/);
  });

  it('инструмент Кузьмича/MCP выбирает признак, а не номер', () => {
    const src = read('lib/kuzmich/accommodation-search.ts');
    expect(src).toMatch(/\(contact_phone IS NOT NULL\) AS has_contact_phone/);
    expect(src.replace(/\(contact_phone IS NOT NULL\)/g, '')).not.toMatch(/(?<![a-z_])contact_phone/);
    expect(src).not.toMatch(/tel:/);
  });

  it('в ответе агенту: телефон «есть на карточке», самого номера нет, цена не названа', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{
        id: 'a1', name: 'Кутха', type: 'guesthouse', address: 'пос. Пионерский', location_zone: 'Пионерский',
        price_per_night_from: null, rating: null, external_booking_url: null, has_contact_phone: true,
      }],
    });
    const out = await searchAccommodationsForKuzmich({});
    expect(out).toContain('Кутха');
    expect(out).toContain('у владельца по телефону');
    expect(out).toContain('на карточке по ссылке выше');
    expect(out).not.toMatch(/\+7|8\s?9\d\d|962/);
    expect(out).not.toContain('цена по запросу');
  });

  it('без номера и без сайта — прежнее «цена по запросу»', async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [{
        id: 'a2', name: 'X', type: 'hotel', address: 'a', location_zone: null,
        price_per_night_from: null, rating: null, external_booking_url: null, has_contact_phone: false,
      }],
    });
    expect(await searchAccommodationsForKuzmich({})).toContain('цена по запросу');
  });
});

describe('карточка и спрос', () => {
  const ui = read('app/accommodations/[id]/_AccommodationDetailClient.tsx');

  it('кнопка «Позвонить» — tel: из проверенной формы, нажатие считается', () => {
    expect(ui).toMatch(/href=\{`tel:\$\{data\.contactPhone\}`\}/);
    expect(ui).toMatch(/funnelBeacon\('stay_phone_call', data\.id\)/);
    expect(ui).toMatch(/formatContactPhone\(data\.contactPhone\)/);
  });

  it('без своих номеров и с телефоном — ни списка номеров, ни фразы про оператора платформы', () => {
    expect(ui).toMatch(/const viaOwner = Boolean\(data\.externalBookingUrl\) \|\| \(Boolean\(data\.contactPhone\) && data\.rooms\.length === 0\)/);
    expect(ui).toMatch(/\{viaOwner \? null : data\.rooms\.length === 0 \?/);
  });

  it('загрузчик отдаёт номер только в проверенной форме', () => {
    const src = read('lib/stay/accommodation-detail.ts');
    expect(src).toMatch(/contactPhone: normalizeContactPhone\(accommodation\.contact_phone\)/);
  });

  it('звонок — шаг спроса на жильё, в NSM не входит; перепись его считает', () => {
    expect(FUNNEL_STEPS).toContain('stay_phone_call');
    expect(EXECUTION_STEPS).not.toContain('stay_phone_call' as never);
    const census = read('app/api/cron/stay-demand-census/route.ts');
    expect(census).toMatch(/step = 'stay_phone_call'/);
    expect(census).toMatch(/phone_call_clicks: phone\.value/);
  });
});
