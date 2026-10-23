/**
 * Стандарт карточки трансфера (решение владельца 13.10, «да делай»;
 * CLAUDE.md §14): страница перевозчика /transfers/[slug] по образцу карточки
 * тура (§11). Судится рендером — тем, что видит человек:
 *
 *   · блоки по порядку: о перевозчике → прайс под заказ → что входит в цену →
 *     безопасность по направлениям → перевозчик → отзывы → Кузьмич; справа —
 *     заявка на машину. Поездок с местами нет: машину заказывают целиком
 *     (владелец 13.10: «бронируют целую машину а не место в ней»);
 *   · только записанное: направление, связанное с местом, — ссылка на его
 *     карточку, не связанное — словами; «что входит в цену» — «уточняется у
 *     перевозчика»; не смогли проверить — так и сказано;
 *   · подпись «Проверенный перевозчик» — только по отметке, «оператор» на
 *     странице перевозчика не появляется (владелец 13.10: «проверен мной»);
 *   · отзывы — только от тех, кто ехал, с доказательством под каждым
 *     (слово владельца 13.10 «логично»; подробно — carrier-reviews.test);
 *   · форма: согласие называет перевозчика, в запрос уходит СОСТОЯНИЕ галочки;
 *   · старый адрес /operators/<slug> перевозчика переадресует сюда, сайтмап
 *     знает новую страницу.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { dbQuery, poolQuery } = vi.hoisted(() => ({ dbQuery: vi.fn(), poolQuery: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));

import { CarrierPage, CHARTER_REQUEST_ANCHOR } from '@/components/transfers/CarrierPage';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';
import { formatRub, type CarrierProfile } from '@/lib/transfers/charter-format';
import { carrierInstrument, carrierJsonLd, minCharterPrice } from '@/lib/transfers/carrier-view';
import { hazardLabel } from '@/lib/safety/hazard-labels';
import { PD_CONSENT_CARRIER_TEXT } from '@/lib/legal/pd-consent';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const line = (to: string, priceRub: number, place: { id: string; href: string; name: string } | null, note: string | null = null) => ({
  from: 'Петропавловск-Камчатский', to, priceRub, note, conditions: 'при расчёте наличными', validYear: 2026, place,
});

const CARRIER: CarrierProfile = {
  partnerId: 'p-1', slug: 'shatun', name: 'Шатун',
  shortDescription: 'Вахтовки на базе КамАЗ на 26 мест под заказ', logo: null,
  description: 'Перевозчик: две вахтовки на базе КамАЗ, по 26 посадочных мест.',
  verified: true,
  vehicles: [
    { kind: 'vahtovka', title: 'КамАЗ-1', seats: 26 },
    { kind: 'vahtovka', title: 'КамАЗ-2', seats: 26 },
  ],
  destinations: [
    line('Вулкан Горелый', 75000, { id: 'pl-gor', href: '/places/vulkan-gorelyj', name: 'Вулкан Горелый' }),
    line('Толбачик (Мёртвый лес)', 360000, { id: 'pl-tol', href: '/places/vulkan-tolbachik', name: 'Вулкан Толбачик' }),
    line('Курильское озеро', 450000, null, 'плюс переправы'),
  ],
  extraDay: { priceRub: 30000, note: 'при эксплуатации транспорта на местности', conditions: 'при расчёте наличными', validYear: 2026 }, rates: [], seatClasses: [],
  photos: [
    { url: '/images/shatun/shatun-01.jpg', credit: null },
    { url: '/images/shatun/shatun-16.jpg', credit: 'Сладченко Виктор Леонидович' },
  ],
  clips: [],
  legal: { name: 'ИП Миронова Нина Васильевна', inn: '250302356113', ogrn: null },
  video: null,
  phone: '+79294560102', telegramHref: 'https://t.me/+79294560102', whatsappHref: 'https://wa.me/79294560102',
};

const DATA: CarrierPageData = {
  carrier: CARRIER,
  safety: { state: 'ok', byPlace: { 'pl-gor': ['volcanic_gas', 'weather'] } },
  reviews: { state: 'ok', items: [], count: 0, average: null },
  rental: { state: 'ok', has: false },
};

const headings = (c: HTMLElement) => [...c.querySelectorAll('h2')].map((h) => h.textContent?.trim());

beforeEach(() => {
  fetchMock.mockReset();
  dbQuery.mockReset();
  poolQuery.mockReset();
});

describe('страница перевозчика: блоки и порядок', () => {
  it('сверху вниз по стандарту; заявка — отдельной колонкой с якорем', () => {
    const { container } = render(<CarrierPage data={DATA} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Шатун');
    expect(headings(container)).toEqual([
      'О перевозчике', 'Прайс под заказ', 'Что входит в цену',
      'Безопасность по направлениям', 'Перевозчик', 'Отзывы', 'Спросить Кузьмича', 'Заявка на машину',
    ]);
    expect(container.querySelector(`#${CHARTER_REQUEST_ANCHOR} form`)).not.toBeNull();
    // Кнопка героя ведёт к форме.
    expect(screen.getByRole('link', { name: /Заявка на машину/ }).getAttribute('href')).toBe(`#${CHARTER_REQUEST_ANCHOR}`);
  });

  it('полоса фактов — только записанное', () => {
    render(<CarrierPage data={DATA} />);
    const strip = screen.getByLabelText('Факты о перевозчике');
    expect(strip.textContent).toContain('Вахтовка');
    expect(strip.textContent).toContain('до 26 в машине');
    expect(strip.textContent).toContain('Петропавловск-Камчатский');
    expect(strip.textContent).toContain('за машину');
    expect(carrierInstrument({ vehicles: [], destinations: [], rates: [], seatClasses: [] })).toEqual([]);
  });
});

describe('прайс: направления ведут на места, цена — за машину', () => {
  it('связанное направление — ссылка на карточку места, несвязанное — словами', () => {
    render(<CarrierPage data={DATA} />);
    const price = screen.getByRole('heading', { name: 'Прайс под заказ' }).parentElement as HTMLElement;
    expect(within(price).getByRole('link', { name: 'Вулкан Горелый' }).getAttribute('href')).toBe('/places/vulkan-gorelyj');
    // Слова перевозчика остаются подписью, место называется рядом.
    expect(within(price).getByRole('link', { name: 'Толбачик (Мёртвый лес)' }).getAttribute('href')).toBe('/places/vulkan-tolbachik');
    expect(price.textContent).toContain('место: Вулкан Толбачик');
    expect(within(price).queryByRole('link', { name: 'Курильское озеро' })).toBeNull();
    expect(price.textContent).toContain('Курильское озеро');
    expect(price.textContent).toContain('Цена — за машину целиком, не за место');
    expect(price.textContent).not.toMatch(/₽ за место/);
  });

  it('«от» — самая низкая строка прайса; без прайса — ничего', () => {
    expect(minCharterPrice(CARRIER)).toBe(75000);
    expect(minCharterPrice({ destinations: [] })).toBeNull();
  });
});

describe('честные исходы', () => {
  it('мест в поездках на странице нет: ни поездок с датами, ни «Запросить места»; цена — за машину целиком', () => {
    const { container } = render(<CarrierPage data={DATA} />);
    expect(container.textContent).not.toMatch(/Запросить места|Поездки с датами|мест свободно/);
    expect(container.textContent).toContain('Цена — за машину целиком, не за место.');
  });

  it('что входит в цену — не записано и сказано так', () => {
    render(<CarrierPage data={DATA} />);
    const inc = screen.getByRole('heading', { name: 'Что входит в цену' }).parentElement as HTMLElement;
    expect(inc.textContent).toMatch(/уточняется\s+у перевозчика/);
  });

  it('безопасность: опасности места словами единого справочника; нет профиля — «не записаны», не «безопасно»', () => {
    render(<CarrierPage data={DATA} />);
    const safety = screen.getByRole('heading', { name: 'Безопасность по направлениям' }).parentElement as HTMLElement;
    expect(safety.textContent).toContain(hazardLabel('volcanic_gas'));
    expect(safety.textContent).toContain('Вулкан Толбачик');
    expect(safety.textContent).toContain('Опасности места не записаны');
    expect(safety.textContent).toContain('112');
  });

  it('опасности не прочитались — сбой назван, а не «опасностей нет»', () => {
    render(<CarrierPage data={{ ...DATA, safety: { state: 'failed' } }} />);
    expect(screen.getByText(/Не смогли проверить опасности мест/)).toBeTruthy();
  });
});

describe('перевозчик: отметка, исполнитель, связь', () => {
  it('«Проверенный перевозчик» по отметке; «оператор» на странице перевозчика не появляется', () => {
    const { container, unmount } = render(<CarrierPage data={DATA} />);
    expect(container.textContent).toContain('Проверенный перевозчик');
    expect(container.textContent).not.toContain('Проверенный оператор');
    expect(container.textContent).toContain('Исполнитель: ИП Миронова Нина Васильевна, ИНН 250302356113');
    expect(container.querySelector('a[href="tel:+79294560102"]')).not.toBeNull();
    unmount();
    const plain = render(<CarrierPage data={{ ...DATA, carrier: { ...CARRIER, verified: false } }} />);
    expect(plain.container.textContent).not.toContain('Проверенный перевозчик');
  });

  it('вывеска — имя перевозчика, ИП — исполнителем, как на карточке тура; нет реквизитов — «не записаны»', () => {
    const { unmount } = render(<CarrierPage data={DATA} />);
    const who = screen.getByRole('heading', { name: 'Перевозчик' }).parentElement as HTMLElement;
    expect(within(who).getByText('Шатун')).toBeTruthy();
    expect(who.textContent).toContain('Исполнитель: ИП Миронова Нина Васильевна, ИНН 250302356113');
    expect(who.textContent).toContain('2 × вахтовка, 26 мест');
    unmount();
    render(<CarrierPage data={{ ...DATA, carrier: { ...CARRIER, legal: null } }} />);
    const bare = screen.getByRole('heading', { name: 'Перевозчик' }).parentElement as HTMLElement;
    expect(bare.textContent).toContain('Исполнитель: реквизиты перевозчика не записаны на платформе');
  });

  it('отзывы — после перевозчика: пусто — кто и как может оставить, а не тишина', () => {
    render(<CarrierPage data={DATA} />);
    const block = screen.getByRole('heading', { name: 'Отзывы' }).closest('section') as HTMLElement;
    expect(block.id).toBe('reviews');
    expect(block.textContent).toContain('Отзыв оставляет только тот, кто ехал');
    expect(block.textContent).toContain('менеджер Ведара присылает заказчику ссылку на отзыв');
  });
});

describe('форма заявки на машину', () => {
  it('согласие называет перевозчика; без галочки не уходит; в запрос — состояние галочки и выбранное направление', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { price_line: { to: 'Вулкан Горелый', price_rub: 75000, note: null } } }),
    });
    render(<CarrierPage data={DATA} />);
    const form = document.getElementById(CHARTER_REQUEST_ANCHOR) as HTMLElement;
    expect(form.textContent).toContain(PD_CONSENT_CARRIER_TEXT);

    fireEvent.change(within(form).getByLabelText('Куда'), { target: { value: 'Вулкан Горелый' } });
    fireEvent.change(within(form).getByLabelText('Выезд'), { target: { value: '2027-07-10' } });
    fireEvent.change(within(form).getByLabelText('Сколько человек'), { target: { value: '8' } });
    fireEvent.change(within(form).getByLabelText('Имя и фамилия'), { target: { value: 'Анна Петрова' } });
    fireEvent.change(within(form).getByLabelText('Телефон'), { target: { value: '+7 900 123-45-67' } });

    const submit = within(form).getByRole('button', { name: /Отправить заявку на машину/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('checkbox'));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/charter-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      carrier: 'shatun', destination: 'Вулкан Горелый', date_from: '2027-07-10', passengers: 8,
      name: 'Анна Петрова', pd_consent: true,
    });
    // Ответ человеку — без обещаний, которых система не держит.
    expect(await within(form).findByText(/Машина этим ещё не закреплена/)).toBeTruthy();
    expect(form.textContent).toContain(`${formatRub(75000)} за машину`);
  });

  it('своё направление — не из прайса — уходит словами человека', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { price_line: null } }) });
    render(<CarrierPage data={DATA} />);
    const form = document.getElementById(CHARTER_REQUEST_ANCHOR) as HTMLElement;
    fireEvent.change(within(form).getByLabelText('Куда'), { target: { value: '__other__' } });
    fireEvent.change(within(form).getByLabelText('Своё направление'), { target: { value: 'Мутновский' } });
    fireEvent.change(within(form).getByLabelText('Выезд'), { target: { value: '2027-07-10' } });
    fireEvent.change(within(form).getByLabelText('Сколько человек'), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Имя и фамилия'), { target: { value: 'Анна Петрова' } });
    fireEvent.change(within(form).getByLabelText('Телефон'), { target: { value: '+79001234567' } });
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.click(within(form).getByRole('button', { name: /Отправить заявку на машину/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body).destination).toBe('Мутновский');
    expect(await within(form).findByText(/нет в прайсе — цену назовёт перевозчик/)).toBeTruthy();
  });

  it('отказ сервера — его словами, форма остаётся', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ success: false, error: 'Дата выезда уже прошла', field: 'date_from' }) });
    render(<CarrierPage data={DATA} />);
    const form = document.getElementById(CHARTER_REQUEST_ANCHOR) as HTMLElement;
    fireEvent.change(within(form).getByLabelText('Выезд'), { target: { value: '2027-07-10' } });
    fireEvent.change(within(form).getByLabelText('Сколько человек'), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Имя и фамилия'), { target: { value: 'Анна Петрова' } });
    fireEvent.change(within(form).getByLabelText('Телефон'), { target: { value: '+79001234567' } });
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.click(within(form).getByRole('button', { name: /Отправить заявку на машину/ }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(form.textContent).toContain('Дата выезда уже прошла');
    expect(within(form).getByLabelText('Выезд').getAttribute('aria-invalid')).toBe('true');
  });
});

describe('разметка для поисковиков', () => {
  it('организация и предложения — строки прайса с ценой за машину; наличия и сроков нет', () => {
    const ld = carrierJsonLd(CARRIER, 'https://vedarai.ru');
    expect(ld).toMatchObject({
      '@type': 'Organization', url: 'https://vedarai.ru/transfers/shatun',
      legalName: 'ИП Миронова Нина Васильевна', taxID: '250302356113',
    });
    const offers = ld.makesOffer as Array<Record<string, unknown>>;
    expect(offers).toHaveLength(3);
    expect(offers[0]).toMatchObject({ '@type': 'Offer', price: 75000, priceCurrency: 'RUB' });
    expect(JSON.stringify(ld)).not.toMatch(/availability|InStock|validThrough/);
    expect(carrierJsonLd({ ...CARRIER, destinations: [], legal: null }, 'https://vedarai.ru')).not.toHaveProperty('makesOffer');
  });
});

describe('адрес: один, старый переадресует', () => {
  const PROFILE = {
    id: 'p-1', slug: 'shatun', name: 'Шатун', category: 'transfer', description: null, short_description: null,
    hero_image: null, logo_image: null, gallery: [], services: null, features: null, faq: null, season_info: null,
    reviews_data: null, contacts: null, location: null, legal_info: null, contact: null, rating: null,
    review_count: null, is_verified: true, registry_status: 'unknown', registry_number: null,
    registry_checked_at: null, created_at: '2026-10-09',
  };

  it('/operators/<slug> перевозчика — постоянная переадресация на /transfers/<slug>', async () => {
    dbQuery.mockResolvedValue({ rows: [PROFILE] });
    const { default: OperatorProfilePage } = await import('@/app/operators/[slug]/page');
    let thrown: unknown = null;
    try {
      await OperatorProfilePage({ params: Promise.resolve({ slug: 'shatun' }) });
    } catch (e) { thrown = e; }
    const digest = String((thrown as { digest?: unknown } | null)?.digest ?? '');
    expect(digest).toContain('/transfers/shatun');
    expect(digest).toContain('308');
  });

  it('туроператор остаётся на своей странице', async () => {
    dbQuery.mockResolvedValue({ rows: [{ ...PROFILE, category: 'operator' }] });
    const { default: OperatorProfilePage } = await import('@/app/operators/[slug]/page');
    await expect(OperatorProfilePage({ params: Promise.resolve({ slug: 'shatun' }) })).resolves.toBeTruthy();
  });

  it('сайтмап знает страницу перевозчика — по тому же условию, что у страницы', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockImplementation((sql: string) => Promise.resolve({
      rows: /category = 'transfer'/.test(String(sql)) ? [{ slug: 'shatun', updated_at: new Date('2026-10-13') }] : [],
    }));
    const { entries } = await collectSitemapEntriesWithStatus();
    expect(entries.some((e) => e.url === 'https://vedarai.ru/transfers/shatun')).toBe(true);
    expect(entries.some((e) => e.url === 'https://vedarai.ru/operators/shatun')).toBe(false);
    const sql = String(poolQuery.mock.calls.find((c) => /category = 'transfer'/.test(String(c[0])))?.[0]);
    expect(sql).toContain('is_public = TRUE');
    expect(sql).toContain('slug IS NOT NULL');
  });
});
