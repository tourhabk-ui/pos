/**
 * Логотип партнёра на витринах перевозчика и прокатчика (решение владельца
 * 23.10: «и логотип лагуны»). Судится рендером, вызовом и данными, не текстом
 * исходника:
 *
 *   · герой страниц /transfers/[slug] и /car-rental/[slug] показывает логотип
 *     с подписью «Логотип: <имя>»; кружок блока «Перевозчик»/«Прокатчик»
 *     берёт логотип раньше снимка; нет логотипа — ни картинки, ни пустого
 *     места: снимок или буква, как было (§4.0);
 *   · карточки в списках /transfers и /car-rental — тот же логотип рядом с
 *     именем, одной вёрсткой (PartnerLogo);
 *   · разметка Organization/AutoRental несёт logo полным адресом только когда
 *     он есть;
 *   · загрузчики читают partners.logo_image: путь → logo, пусто и NULL → null;
 *   · миграция 1320 кладёт логотип «Лагуны Прокат» только в пустое поле, и
 *     файл, который она называет, лежит в public/, это PNG не крупнее 512 px и
 *     легче 100 КБ (без вариантов WebP: оптимизатор режет только тяжелее 50).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { dbQuery, poolQuery } = vi.hoisted(() => ({ dbQuery: vi.fn(), poolQuery: vi.fn() }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => dbQuery(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => poolQuery(...a) } }));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/layout/Footer', () => ({ Footer: () => null }));

import { RentalCompanyPage } from '@/components/rental/RentalCompanyPage';
import { RentalCompanyCard } from '@/components/rental/RentalCompanyCard';
import { CarrierPage } from '@/components/transfers/CarrierPage';
import { CharterCard } from '@/components/transfers/CharterCard';
import { PartnerLogo } from '@/components/shared/PartnerLogo';
import type { RentalCompanyProfile } from '@/lib/rental/rental-format';
import type { CarrierProfile } from '@/lib/transfers/charter-format';
import type { CarrierPageData } from '@/lib/transfers/carrier-page';
import { rentalJsonLd } from '@/lib/rental/rental-view';
import { carrierJsonLd } from '@/lib/transfers/carrier-view';
import { loadRentalCompanyBySlug } from '@/lib/rental/rental';
import { loadCarrierBySlug } from '@/lib/transfers/charter';

vi.stubGlobal('fetch', vi.fn());

const LOGO = '/images/laguna-prokat/laguna-logo.png';
const PHOTO = { url: '/images/laguna-prokat/laguna-fleet-tank300.jpg', credit: 'Лагуна Прокат' };

const COMPANY: RentalCompanyProfile = {
  partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  shortDescription: 'Внедорожники и микроавтобусы без водителя', logo: LOGO,
  description: null, photos: [], phone: null, telegramHref: null,
  offers: [{
    id: 'o-1', title: 'Tank-300', bodyKind: 'suv', seats: 5, transmission: 'automatic', drive: '4wd', engineHp: null,
    priceRubPerDay: 12000, priceIsFrom: false, depositRub: null, driver: 'self', conditions: null, sourceUrl: null,
    pricesSeenOn: null, photo: null,
  }],
  verified: false, legal: null, terms: null, alsoCarrier: false,
};

const CARRIER: CarrierProfile = {
  partnerId: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат',
  shortDescription: 'Микроавтобус и вахтовка с водителем', logo: LOGO,
  description: null, verified: false,
  vehicles: [{ kind: 'minibus', title: 'Ford Transit', seats: 17 }],
  destinations: [], extraDay: null, seatClasses: [],
  rates: [{ unit: 'day', vehicleKind: 'minibus', priceRub: 25000, note: null, conditions: null, validYear: null }],
  photos: [], clips: [], legal: null, video: null, license: null, passengerInsurance: null,
  phone: null, telegramHref: null, whatsappHref: null,
};

const carrierData = (carrier: CarrierProfile): CarrierPageData => ({
  carrier,
  safety: { state: 'ok', byPlace: {} },
  reviews: { state: 'ok', items: [], count: 0, average: null },
  rental: { state: 'ok', has: false },
});

/** next/image в jsdom отдаёт /_next/image?url=…: судим по раскодированному адресу. */
const srcs = (root: HTMLElement) => [...root.querySelectorAll('img')].map((img) => decodeURIComponent(img.getAttribute('src') ?? ''));
const logoImgs = (root: HTMLElement) => srcs(root).filter((s) => s.includes('laguna-logo.png'));

beforeEach(() => {
  dbQuery.mockReset();
  poolQuery.mockReset();
});

describe('логотип партнёра: страница прокатчика', () => {
  it('с логотипом — в герое с подписью и в кружке блока «Прокатчик», раньше снимка', () => {
    const { container } = render(<RentalCompanyPage data={{ company: { ...COMPANY, photos: [PHOTO] } }} />);
    expect(screen.getByAltText('Логотип: Лагуна Прокат')).toBeTruthy();
    // Герой и кружок — два показа; снимок в кружке логотипом вытеснен.
    expect(logoImgs(container)).toHaveLength(2);
    const who = container.querySelector('[aria-labelledby="rental-who"]') as HTMLElement;
    expect(logoImgs(who)).toHaveLength(1);
    expect(srcs(who).some((s) => s.includes('laguna-fleet-tank300'))).toBe(false);
  });

  it('без логотипа — ни картинки, ни пустого места: снимок в кружке, а без снимка — буква', () => {
    const withPhoto = render(<RentalCompanyPage data={{ company: { ...COMPANY, logo: null, photos: [PHOTO] } }} />);
    expect(screen.queryByAltText(/^Логотип:/)).toBeNull();
    expect(logoImgs(withPhoto.container)).toHaveLength(0);
    const who = withPhoto.container.querySelector('[aria-labelledby="rental-who"]') as HTMLElement;
    expect(srcs(who).some((s) => s.includes('laguna-fleet-tank300'))).toBe(true);
    withPhoto.unmount();

    const bare = render(<RentalCompanyPage data={{ company: { ...COMPANY, logo: null } }} />);
    const whoBare = bare.container.querySelector('[aria-labelledby="rental-who"]') as HTMLElement;
    expect(whoBare.querySelectorAll('img')).toHaveLength(0);
    expect(whoBare.textContent).toContain('Л');
  });
});

describe('логотип партнёра: страница перевозчика', () => {
  it('с логотипом — в герое с подписью и в кружке блока «Перевозчик»', () => {
    const { container } = render(<CarrierPage data={carrierData({ ...CARRIER, photos: [PHOTO] })} />);
    expect(screen.getByAltText('Логотип: Лагуна Прокат')).toBeTruthy();
    expect(logoImgs(container)).toHaveLength(2);
    const who = container.querySelector('[aria-labelledby="carrier-who"]') as HTMLElement;
    expect(logoImgs(who)).toHaveLength(1);
  });

  it('без логотипа — снимок в кружке, как было', () => {
    const { container } = render(<CarrierPage data={carrierData({ ...CARRIER, logo: null, photos: [PHOTO] })} />);
    expect(screen.queryByAltText(/^Логотип:/)).toBeNull();
    expect(logoImgs(container)).toHaveLength(0);
    const who = container.querySelector('[aria-labelledby="carrier-who"]') as HTMLElement;
    expect(srcs(who).some((s) => s.includes('laguna-fleet-tank300'))).toBe(true);
  });
});

describe('логотип партнёра: карточки в списках', () => {
  it('карточка прокатчика и карточка перевозчика показывают логотип рядом с именем', () => {
    const rental = render(<RentalCompanyCard company={COMPANY} />);
    expect(rental.getByAltText('Логотип: Лагуна Прокат')).toBeTruthy();
    expect(rental.getByRole('heading', { level: 3 }).textContent).toBe('Лагуна Прокат');
    rental.unmount();

    const carrier = render(<CharterCard carrier={CARRIER} />);
    expect(carrier.getByAltText('Логотип: Лагуна Прокат')).toBeTruthy();
    expect(carrier.getByRole('heading', { level: 3 }).textContent).toBe('Лагуна Прокат');
  });

  it('без логотипа карточки не рисуют ни картинки, ни пустого круга', () => {
    const rental = render(<RentalCompanyCard company={{ ...COMPANY, logo: null }} />);
    expect(rental.container.querySelectorAll('img')).toHaveLength(0);
    rental.unmount();
    const carrier = render(<CharterCard carrier={{ ...CARRIER, logo: null }} />);
    expect(carrier.container.querySelectorAll('img')).toHaveLength(0);
  });

  it('PartnerLogo без пути не рисует ничего', () => {
    const { container } = render(<PartnerLogo src={null} name="Кто-то" size="card" />);
    expect(container.innerHTML).toBe('');
  });
});

describe('логотип партнёра: разметка для поисковиков', () => {
  it('logo — полным адресом, и только когда он есть', () => {
    expect(rentalJsonLd(COMPANY, 'https://vedarai.ru').logo).toBe('https://vedarai.ru/images/laguna-prokat/laguna-logo.png');
    expect('logo' in rentalJsonLd({ ...COMPANY, logo: null }, 'https://vedarai.ru')).toBe(false);
    expect(carrierJsonLd(CARRIER, 'https://vedarai.ru').logo).toBe('https://vedarai.ru/images/laguna-prokat/laguna-logo.png');
    expect('logo' in carrierJsonLd({ ...CARRIER, logo: null }, 'https://vedarai.ru')).toBe(false);
  });
});

describe('логотип партнёра: загрузчики читают partners.logo_image', () => {
  const partnerRow = (logo_image: string | null) => ({
    id: 'p-1', slug: 'laguna-prokat', name: 'Лагуна Прокат', short_description: null, logo_image,
    hero_image: null, gallery: null, gallery_credits: {}, contacts: null, video_url: null, video_poster_url: null,
    video_clips: null, legal_info: null, fleet_seat_classes: null, is_verified: false, description: null,
    terms_items: null, terms_source_url: null, terms_seen_on: null, also_carrier: false,
  });
  const answer = (logo_image: string | null) => (sql: unknown) => Promise.resolve(
    typeof sql === 'string' && sql.includes('FROM partners') ? { rows: [partnerRow(logo_image)] } : { rows: [] },
  );

  it('прокатчик: путь → logo; пустая строка и NULL → null', async () => {
    dbQuery.mockImplementation(answer(LOGO));
    expect((await loadRentalCompanyBySlug('laguna-prokat'))?.logo).toBe(LOGO);
    dbQuery.mockImplementation(answer(''));
    expect((await loadRentalCompanyBySlug('laguna-prokat'))?.logo).toBeNull();
    dbQuery.mockImplementation(answer(null));
    expect((await loadRentalCompanyBySlug('laguna-prokat'))?.logo).toBeNull();
    // Колонка в SELECT: без неё строка пришла бы без поля, и экран молча остался бы без логотипа.
    const partnerSql = dbQuery.mock.calls.map((c) => String(c[0])).find((s) => s.includes('FROM partners')) ?? '';
    expect(partnerSql).toContain('p.logo_image');
  });

  it('перевозчик: то же', async () => {
    dbQuery.mockImplementation(answer(LOGO));
    expect((await loadCarrierBySlug('laguna-prokat'))?.logo).toBe(LOGO);
    dbQuery.mockImplementation(answer(''));
    expect((await loadCarrierBySlug('laguna-prokat'))?.logo).toBeNull();
    const partnerSql = dbQuery.mock.calls.map((c) => String(c[0])).find((s) => s.includes('FROM partners')) ?? '';
    expect(partnerSql).toContain('p.logo_image');
  });
});

describe('миграция 1320: логотип «Лагуны Прокат»', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '1320_laguna_prokat_logo.sql'), 'utf8');

  it('ставит логотип только партнёру laguna-prokat и только в пустое поле', () => {
    const update = sql.slice(sql.indexOf('UPDATE partners'), sql.indexOf(';', sql.indexOf('UPDATE partners')));
    expect(update).toContain(`logo_image = '${LOGO}'`);
    expect(update).toContain("slug = 'laguna-prokat'");
    expect(update).toMatch(/logo_image IS NULL OR logo_image = ''/);
    // Источник назван, видео честно нет (§4.0): шапка говорит об этом словами.
    expect(sql).toMatch(/лагунапрокат\.рф/);
    expect(sql).toMatch(/[Вв]идео/);
  });

  it('файл, который она называет, лежит в public/: PNG не крупнее 512 px и легче 100 КБ', () => {
    const path = join(process.cwd(), 'public', LOGO);
    const size = statSync(path).size;
    expect(size).toBeLessThan(100 * 1024);
    const buf = readFileSync(path);
    expect(buf.subarray(1, 4).toString('ascii')).toBe('PNG');
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    expect(width).toBeLessThanOrEqual(512);
    expect(height).toBeLessThanOrEqual(512);
    expect(width).toBe(height);
  });
});
