/**
 * Страница прокатчика /car-rental/[slug] (витрина проката, решение владельца
 * 23.10; схема 1317) — по образцу страницы перевозчика (§14). Судится
 * рендером на фикстуре БЕЗ фото — у первого прокатчика снимков нет, и это
 * главный путь:
 *
 *   · блоки по порядку: о прокатчике → машины и цены → условия проката →
 *     прокатчик → Кузьмич; справа — заявка на машину с якорем;
 *   · только записанное: «число мест не записано» при null, «цена «от»» там,
 *     где так написал прокатчик, условия есть / «не записаны», и всегда —
 *     чего платформа не знает (минимальный срок, возраст, стаж, что входит);
 *   · «Проверенный прокатчик» — только по отметке; реквизиты — из legal_info
 *     или «не записаны»; ссылка на перевозчика — только если партнёр возит и с
 *     водителем;
 *   · форма: согласие называет прокат автомобилей, кнопка неактивна с
 *     причиной, в запрос уходит СОСТОЯНИЕ галочки и выбранная машина; `?car=`
 *     предзаполняет только дословную строку прайса;
 *   · разметка AutoRental с ценой за сутки; /operators/<slug> партнёра
 *     категории cars переадресует сюда; сайтмап знает /car-rental и страницу.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { dbQuery, poolQuery } = vi.hoisted(() => ({ dbQuery: vi.fn(), poolQuery: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));

import { RentalCompanyPage, RENTAL_REQUEST_ANCHOR } from '@/components/rental/RentalCompanyPage';
import type { RentalPageData } from '@/lib/rental/rental-page';
import { type RentalCompanyProfile, type RentalOffer } from '@/lib/rental/rental-format';
import { rentalInstrument, rentalJsonLd } from '@/lib/rental/rental-view';
import { PD_CONSENT_RENTAL_TEXT } from '@/lib/legal/pd-consent';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const offer = (over: Partial<RentalOffer> = {}): RentalOffer => ({
  id: 'o-1', title: 'Toyota Land Cruiser Prado', bodyKind: 'suv', seats: 5, transmission: 'automatic', drive: '4wd',
  engineHp: 163, priceRubPerDay: 7000, priceIsFrom: false, depositRub: 30000, driver: 'optional',
  conditions: 'Пробег без ограничений по асфальту', sourceUrl: 'https://example.test/price', pricesSeenOn: '2026-10-23', photo: null, ...over,
});

const COMPANY: RentalCompanyProfile = {
  partnerId: 'p-1', slug: 'laguna', name: 'Лагуна Прокат',
  shortDescription: 'Внедорожники и микроавтобусы без водителя', logo: null,
  description: 'Прокат автомобилей в Петропавловске-Камчатском.',
  photos: [], phone: '+79001234567', telegramHref: 'https://t.me/laguna',
  offers: [
    offer(),
    offer({ id: 'o-2', title: 'ГАЗ Соболь', bodyKind: 'minibus', seats: null, transmission: 'manual', drive: null, engineHp: null, priceRubPerDay: 25000, priceIsFrom: true, depositRub: null, driver: 'self', conditions: null }),
  ],
  verified: true,
  legal: { name: 'ИП Лагунова Анна Петровна', inn: '410100000011', ogrn: null },
  terms: { items: ['Залог возвращается при возврате машины без повреждений', 'Выдача в городе'], sourceUrl: null, seenOn: '2026-10-23' },
  alsoCarrier: true,
};

const DATA: RentalPageData = { company: COMPANY };
const headings = (c: HTMLElement) => [...c.querySelectorAll('h2')].map((h) => h.textContent?.trim());
/** Текст без неразрывных пробелов: formatRub ставит NBSP между разрядами и перед ₽, сравнение — по смыслу. */
const txt = (el: HTMLElement | null | undefined) => (el?.textContent ?? '').replace(/\u00a0/g, ' ');

beforeEach(() => {
  fetchMock.mockReset();
  dbQuery.mockReset();
  poolQuery.mockReset();
});

describe('страница прокатчика: блоки и порядок (без фото)', () => {
  it('сверху вниз по стандарту; герой без снимка; заявка — отдельной колонкой с якорем', () => {
    const { container } = render(<RentalCompanyPage data={DATA} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Лагуна Прокат');
    expect(container.querySelector('img')).toBeNull();
    expect(headings(container)).toEqual([
      'О прокатчике', 'Машины и цены', 'Условия проката', 'Прокатчик', 'Машина с водителем', 'Спросить Кузьмича', 'Заявка на машину',
    ]);
    expect(container.querySelector(`#${RENTAL_REQUEST_ANCHOR} form`)).not.toBeNull();
    expect(screen.getByRole('link', { name: /Заявка на машину/ }).getAttribute('href')).toBe(`#${RENTAL_REQUEST_ANCHOR}`);
    expect(container.textContent).toContain('Прокатчик · машины без водителя');
    expect(screen.getByRole('link', { name: 'Аренда автомобилей' }).getAttribute('href')).toBe('/car-rental');
    expect(container.textContent).not.toMatch(/за место|за человека|Проверенный оператор|Проверенный перевозчик/);
  });

  it('полоса фактов — только записанное: машин, цена от, залог от, водитель', () => {
    render(<RentalCompanyPage data={DATA} />);
    const strip = screen.getByLabelText('Факты о прокатчике');
    expect(txt(strip)).toContain('от 7 000 ₽ в сутки');
    expect(txt(strip)).toContain('от 30 000 ₽');
    expect(strip.textContent).toContain('без водителя или по желанию');
    // Кузова разные — ячейки «Кузов» нет; залог не записан ни у кого — ячейки «Залог» нет.
    expect(strip.textContent).not.toContain('Кузов');
    const bare = rentalInstrument({ offers: [offer({ depositRub: null, driver: 'self' })] });
    expect(bare.map((c) => c.k)).toEqual(['Машин', 'Кузов', 'Цена', 'Водитель']);
    expect(bare.find((c) => c.k === 'Водитель')?.v).toBe('без водителя');
    expect(rentalInstrument({ offers: [] })).toEqual([]);
  });
});

describe('машины и цены: только записанное', () => {
  it('все слова машины; «число мест не записано» при null; «цена «от»» там, где так написал прокатчик; условия строки', () => {
    render(<RentalCompanyPage data={DATA} />);
    const price = screen.getByRole('heading', { name: 'Машины и цены' }).parentElement as HTMLElement;
    const text = txt(price);
    expect(text).toContain('Toyota Land Cruiser Prado');
    expect(text).toContain('внедорожник · 5 мест · автомат · 4WD · 163 л.с.');
    expect(text).toContain('7 000 ₽/сутки');
    expect(text).toContain('залог 30 000 ₽');
    expect(text).toContain('Пробег без ограничений по асфальту');
    expect(text).toContain('ГАЗ Соболь');
    expect(text).toContain('микроавтобус · число мест не записано · механика');
    expect(text).toContain('от 25 000 ₽/сутки');
    expect(text).toContain('Цена «от» — точную назовёт прокатчик.');
    expect((text.match(/Цена «от» — точную назовёт прокатчик\./g) ?? []).length).toBe(1);
    expect(text).toContain('Цена — за сутки за машину целиком и не зависит от числа пассажиров.');
    expect(within(price).getByRole('link', { name: 'Заказать машину: ГАЗ Соболь' }).getAttribute('href'))
      .toBe('/car-rental/laguna?car=%D0%93%D0%90%D0%97%20%D0%A1%D0%BE%D0%B1%D0%BE%D0%BB%D1%8C#rental-request');
  });
});

describe('честные исходы', () => {
  it('условия есть — пунктами с датой сверки; нет — «не записаны»; чего платформа не знает — всегда', () => {
    const { unmount } = render(<RentalCompanyPage data={DATA} />);
    const terms = screen.getByRole('heading', { name: 'Условия проката' }).parentElement as HTMLElement;
    expect(within(terms).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Залог возвращается при возврате машины без повреждений', 'Выдача в городе',
    ]);
    expect(terms.textContent).toContain('сверено 2026-10-23');
    expect(terms.textContent).toContain('Минимальный срок аренды, возраст и стаж водителя, что входит в цену и страховка на платформе не записаны — уточняется у прокатчика');
    unmount();
    render(<RentalCompanyPage data={{ company: { ...COMPANY, terms: null } }} />);
    const bare = screen.getByRole('heading', { name: 'Условия проката' }).parentElement as HTMLElement;
    expect(bare.textContent).toContain('Условия проката на платформе не записаны — уточняются у прокатчика.');
    expect(bare.textContent).toContain('Минимальный срок аренды, возраст и стаж водителя');
  });

  it('описание не записано — сказано так, а не пусто', () => {
    render(<RentalCompanyPage data={{ company: { ...COMPANY, description: null } }} />);
    const about = screen.getByRole('heading', { name: 'О прокатчике' }).parentElement as HTMLElement;
    expect(about.textContent).toContain('Описание прокатчика на платформе не записано.');
  });
});

describe('прокатчик: отметка, исполнитель, связь, перевозчик', () => {
  it('«Проверенный прокатчик» только по отметке; исполнитель из legal_info; телефон и Telegram', () => {
    const { container, unmount } = render(<RentalCompanyPage data={DATA} />);
    const who = screen.getByRole('heading', { name: 'Прокатчик' }).parentElement as HTMLElement;
    expect(who.textContent).toContain('Проверенный прокатчик');
    expect(who.textContent).toContain('Исполнитель: ИП Лагунова Анна Петровна, ИНН 410100000011');
    expect(container.querySelector('a[href="tel:+79001234567"]')).not.toBeNull();
    expect(within(who).getByRole('link', { name: /Telegram/ }).getAttribute('href')).toBe('https://t.me/laguna');
    unmount();
    render(<RentalCompanyPage data={{ company: { ...COMPANY, verified: false, legal: null, phone: null, telegramHref: null } }} />);
    const plain = screen.getByRole('heading', { name: 'Прокатчик' }).parentElement as HTMLElement;
    expect(plain.textContent).not.toContain('Проверенный прокатчик');
    expect(plain.textContent).toContain('Исполнитель: реквизиты на платформе не записаны');
    expect(plain.textContent).toContain('Контакты прокатчика не записаны');
  });

  it('ссылка на страницу перевозчика — только если партнёр возит и целой машиной с водителем', () => {
    const { unmount } = render(<RentalCompanyPage data={DATA} />);
    expect(screen.getByRole('link', { name: /прайс на странице перевозчика/ }).getAttribute('href')).toBe('/transfers/laguna');
    unmount();
    const { container } = render(<RentalCompanyPage data={{ company: { ...COMPANY, alsoCarrier: false } }} />);
    expect(container.querySelector('a[href="/transfers/laguna"]')).toBeNull();
    expect(headings(container)).not.toContain('Машина с водителем');
  });
});

describe('форма заявки на прокат', () => {
  const fill = (form: HTMLElement) => {
    fireEvent.change(within(form).getByLabelText('Начало'), { target: { value: '2027-07-10' } });
    fireEvent.change(within(form).getByLabelText('Возврат'), { target: { value: '2027-07-12' } });
    fireEvent.change(within(form).getByLabelText('Имя и фамилия'), { target: { value: 'Анна Петрова' } });
    fireEvent.change(within(form).getByLabelText('Телефон'), { target: { value: '+7 900 123-45-67' } });
  };

  it('согласие называет прокат автомобилей; кнопка неактивна с причиной; в запрос — состояние галочки и выбранная машина', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { days: 3, price: { rub_per_day: 25000, is_from: true } } }),
    });
    render(<RentalCompanyPage data={DATA} />);
    const form = document.getElementById(RENTAL_REQUEST_ANCHOR) as HTMLElement;
    expect(form.textContent).toContain(PD_CONSENT_RENTAL_TEXT);
    expect(form.textContent).not.toContain('передачу перевозчику');

    const submit = within(form).getByRole('button', { name: /Отправить заявку на машину/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(form.textContent).toContain('Чтобы отправить, осталось: дата начала, дата возврата, имя, телефон, согласие на обработку данных.');
    fill(form);
    fireEvent.change(within(form).getByLabelText('Машина'), { target: { value: 'ГАЗ Соболь' } });
    expect(form.textContent).toContain('Чтобы отправить, осталось: согласие на обработку данных.');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(form).getByRole('checkbox'));
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/car-rental-requests');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toMatchObject({
      company: 'laguna', car: 'ГАЗ Соболь', date_from: '2027-07-10', date_to: '2027-07-12',
      name: 'Анна Петрова', pd_consent: true,
    });
    // Ответ человеку — без обещаний, которых система не держит; цена «от» названа как «от».
    expect(await within(form).findByText(/Машина этим ещё не закреплена/)).toBeTruthy();
    expect(txt(form)).toContain('от 25 000 ₽ за сутки за машину');
    expect(form.textContent).toContain('Точную цену назовёт прокатчик');
    expect(form.textContent).toContain('дней: 3');
  });

  it('`?car=` предзаполняет машину только дословной строкой прайса', () => {
    const { unmount } = render(<RentalCompanyPage data={DATA} orderCar="ГАЗ Соболь" />);
    expect((within(document.getElementById(RENTAL_REQUEST_ANCHOR) as HTMLElement).getByLabelText('Машина') as HTMLSelectElement).value).toBe('ГАЗ Соболь');
    unmount();
    render(<RentalCompanyPage data={DATA} orderCar="газ соболь" />);
    expect((within(document.getElementById(RENTAL_REQUEST_ANCHOR) as HTMLElement).getByLabelText('Машина') as HTMLSelectElement).value).toBe('Toyota Land Cruiser Prado');
  });

  it('отказ сервера — его словами у поля, форма остаётся', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ success: false, error: 'Дата начала аренды уже прошла', field: 'date_from' }) });
    render(<RentalCompanyPage data={DATA} />);
    const form = document.getElementById(RENTAL_REQUEST_ANCHOR) as HTMLElement;
    fill(form);
    fireEvent.click(within(form).getByRole('checkbox'));
    fireEvent.click(within(form).getByRole('button', { name: /Отправить заявку на машину/ }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(form.textContent).toContain('Дата начала аренды уже прошла');
    expect(within(form).getByLabelText('Начало').getAttribute('aria-invalid')).toBe('true');
    expect(within(form).getByRole('button', { name: /Отправить заявку на машину/ })).toBeTruthy();
  });
});

describe('разметка для поисковиков', () => {
  it('AutoRental и предложения — строки прайса с ценой за сутки, «от» — minPrice; наличия и сроков нет', () => {
    const ld = rentalJsonLd(COMPANY, 'https://vedarai.ru');
    expect(ld).toMatchObject({
      '@type': 'AutoRental', url: 'https://vedarai.ru/car-rental/laguna',
      legalName: 'ИП Лагунова Анна Петровна', taxID: '410100000011',
    });
    const offers = ld.makesOffer as Array<Record<string, unknown>>;
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ '@type': 'Offer', priceSpecification: { price: 7000, unitCode: 'DAY', priceCurrency: 'RUB' } });
    expect(offers[1]).toMatchObject({ priceSpecification: { minPrice: 25000, unitCode: 'DAY' } });
    expect(JSON.stringify(ld)).not.toMatch(/availability|InStock|validThrough/);
    expect(rentalJsonLd({ ...COMPANY, offers: [], legal: null }, 'https://vedarai.ru')).not.toHaveProperty('makesOffer');
  });
});

describe('адрес: один, старый переадресует, сайтмап знает', () => {
  const PROFILE = {
    id: 'p-1', slug: 'laguna', name: 'Лагуна Прокат', category: 'cars', description: null, short_description: null,
    hero_image: null, logo_image: null, gallery: [], services: null, features: null, faq: null, season_info: null,
    reviews_data: null, contacts: null, location: null, legal_info: null, contact: null, rating: null,
    review_count: null, is_verified: true, registry_status: 'unknown', registry_number: null,
    registry_checked_at: null, created_at: '2026-10-23',
  };

  it('/operators/<slug> партнёра категории cars — постоянная переадресация на /car-rental/<slug>', async () => {
    dbQuery.mockResolvedValue({ rows: [PROFILE] });
    const { default: OperatorProfilePage } = await import('@/app/operators/[slug]/page');
    let thrown: unknown = null;
    try {
      await OperatorProfilePage({ params: Promise.resolve({ slug: 'laguna' }) });
    } catch (e) { thrown = e; }
    const digest = String((thrown as { digest?: unknown } | null)?.digest ?? '');
    expect(digest).toContain('/car-rental/laguna');
    expect(digest).toContain('308');
  });

  it('сайтмап знает /car-rental и страницу прокатчика — по тому же условию, что у страницы', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQuery.mockImplementation((sql: string) => Promise.resolve({
      rows: /car_rental_offers/.test(String(sql)) ? [{ slug: 'laguna', updated_at: new Date('2026-10-23') }] : [],
    }));
    const { entries } = await collectSitemapEntriesWithStatus();
    expect(entries.some((e) => e.url === 'https://vedarai.ru/car-rental')).toBe(true);
    expect(entries.some((e) => e.url === 'https://vedarai.ru/car-rental/laguna')).toBe(true);
    expect(entries.some((e) => e.url === 'https://vedarai.ru/operators/laguna')).toBe(false);
    const sql = String(poolQuery.mock.calls.find((c) => /car_rental_offers/.test(String(c[0])))?.[0]);
    expect(sql).toContain('is_public = TRUE');
    expect(sql).toContain('slug IS NOT NULL');
    expect(sql).not.toContain("category = 'cars'");
  });
});
