/**
 * Прокат на сайте на паузе — слово владельца 23.10: «пока прячем прокат лагуны
 * до понедельника но оставляем его для mcp и A2A» (lib/rental/site-pause).
 *
 * Сторож держит обе стороны паузы на каждой поверхности сайта: пока она идёт,
 * прокатчика нет на витрине (и витрина говорит, когда он вернётся, а не
 * «прокатчиков нет»), в планере, в sitemap, ссылки на прокат со страницы его
 * трансфера и дверей «Прокат» на главной; страница прокатчика открывается, но
 * не индексируется. После срока всё возвращается само. Судится рендером и
 * вызовом с подменённым загрузчиком; часы — подложенные. Сторона агентов
 * (MCP, A2A) и чат Кузьмича — в `rental-site-pause-agents.test.ts`.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const loaders = vi.hoisted(() => ({
  companies: vi.fn(),
  bySlug: vi.fn(),
  hasRental: vi.fn(),
  pool: vi.fn(),
  db: vi.fn(),
  carrier: vi.fn(),
}));
vi.mock('@/lib/rental/rental', async (orig) => ({
  ...(await orig<typeof import('@/lib/rental/rental')>()),
  loadRentalCompanies: () => loaders.companies(),
  loadRentalCompanyBySlug: (slug: string) => loaders.bySlug(slug),
  partnerHasRentalOffers: (id: string) => loaders.hasRental(id),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => loaders.pool(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => loaders.db(...a) }));
vi.mock('@/lib/transfers/charter', async (orig) => ({
  ...(await orig<typeof import('@/lib/transfers/charter')>()),
  loadCarrierBySlug: (slug: string) => loaders.carrier(slug),
}));
vi.mock('@/components/layout/Header', () => ({ Header: () => null }));
vi.mock('@/components/shared/BottomNav', () => ({ default: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

import {
  RENTAL_SITE_PAUSE, rentalSitePauseActive, rentalHiddenOnSite, rentalOnSite,
} from '@/lib/rental/site-pause';
import CarRentalRoute from '@/app/car-rental/(list)/page';
import { generateMetadata } from '@/app/car-rental/[slug]/page';
import { findCarRentalOffers } from '@/lib/planner/trip-extras-data';
import { carRentalPausedAnswer } from '@/lib/planner/trip-extras';
import { collectSitemapEntriesWithStatus } from '@/lib/seo/sitemap-entries';
import { loadCarrierPage } from '@/lib/transfers/carrier-page';
import { DeskTours } from '@/components/homepage/desk/DeskTours';
import HomeV8Client from '@/app/_home/_HomeV8Client';
import type { HomeV8Data } from '@/app/_home/data';
import type { RentalCompany, RentalCompanyProfile } from '@/lib/rental/rental-format';
import type { CarrierProfile } from '@/lib/transfers/charter-format';

/** Пятница 23.10, полдень по Камчатке — пауза идёт. */
const DURING = new Date('2026-10-23T00:00:00Z');
/** Понедельник 26.10, 00:00 по Камчатке и позже — паузы нет. */
const AFTER = new Date('2026-10-25T12:00:00Z');

const company = (slug: string, name: string): RentalCompany => ({
  partnerId: `p-${slug}`, slug, name, shortDescription: null, logo: null, photos: [], phone: null, telegramHref: null,
  offers: [{
    id: `o-${slug}`, title: 'Suzuki Jimny', bodyKind: 'suv', seats: 4, transmission: 'automatic', drive: '4wd', engineHp: null,
    priceRubPerDay: 7000, priceIsFrom: false, depositRub: null, driver: 'self', conditions: null, sourceUrl: null, pricesSeenOn: null, photo: null,
  }],
});
const LAGUNA = company('laguna-prokat', 'Лагуна Прокат');
const BAY = company('bay-rental', 'Бухта Прокат');

const txt = (el: Element | null) => (el?.textContent ?? '').replace(/ /g, ' ');

function at(moment: Date): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(moment);
}

beforeEach(() => {
  for (const f of Object.values(loaders)) f.mockReset();
  loaders.pool.mockResolvedValue({ rows: [] });
  loaders.db.mockResolvedValue({ rows: [] });
});
afterEach(() => { vi.useRealTimers(); });

describe('срок и предмет паузы', () => {
  it('пауза — до понедельника 26.10, 00:00 по Камчатке (UTC+12), и прячет только «Лагуну»', () => {
    const kamchatka = new Date(Date.parse(RENTAL_SITE_PAUSE.until) + 12 * 3600_000);
    expect(kamchatka.getUTCDay()).toBe(1);
    expect(kamchatka.toISOString().slice(0, 16)).toBe('2026-10-26T00:00');
    expect(RENTAL_SITE_PAUSE.slugs).toEqual(['laguna-prokat']);
    expect(RENTAL_SITE_PAUSE.returnsOn).toBe('в понедельник, 26 октября');
  });

  it('до срока спрятана, с первой секунды понедельника — нет; чужой прокатчик не спрятан никогда', () => {
    expect(rentalSitePauseActive(DURING)).toBe(true);
    expect(rentalHiddenOnSite('laguna-prokat', DURING)).toBe(true);
    expect(rentalHiddenOnSite('laguna-prokat', new Date(AFTER.getTime() - 1))).toBe(true);
    expect(rentalSitePauseActive(AFTER)).toBe(false);
    expect(rentalHiddenOnSite('laguna-prokat', AFTER)).toBe(false);
    expect(rentalHiddenOnSite('bay-rental', DURING)).toBe(false);
    expect(rentalOnSite([LAGUNA, BAY], DURING)).toEqual({ shown: [BAY], hidden: 1 });
    expect(rentalOnSite([LAGUNA, BAY], AFTER)).toEqual({ shown: [LAGUNA, BAY], hidden: 0 });
  });
});

describe('витрина /car-rental', () => {
  it('в паузу «Лагуны» нет, другой прокатчик на месте', async () => {
    at(DURING);
    loaders.companies.mockResolvedValue([LAGUNA, BAY]);
    const { container } = render(await CarRentalRoute());
    expect(txt(container)).toContain('Бухта Прокат');
    expect(txt(container)).not.toContain('Лагуна Прокат');
    expect(container.querySelector('a[href^="/car-rental/laguna-prokat"]')).toBeNull();
  });

  it('спрятан единственный — «вернётся в понедельник», а не «прокатчиков нет»', async () => {
    at(DURING);
    loaders.companies.mockResolvedValue([LAGUNA]);
    const { container } = render(await CarRentalRoute());
    expect(txt(container)).toContain('Прокат вернётся на витрину в понедельник, 26 октября.');
    expect(txt(container)).not.toContain('Прокатчиков с прайсом пока нет');
    expect(txt(container)).not.toContain('Лагуна Прокат');
  });

  it('после срока «Лагуна» снова на витрине', async () => {
    at(AFTER);
    loaders.companies.mockResolvedValue([LAGUNA]);
    const { container } = render(await CarRentalRoute());
    expect(txt(container)).toContain('Лагуна Прокат');
    expect(container.querySelector('a[href^="/car-rental/laguna-prokat"]')).not.toBeNull();
  });
});

describe('страница прокатчика: открывается по ссылке из MCP и A2A, но не индексируется', () => {
  const profile = (c: RentalCompany): RentalCompanyProfile => ({
    ...c, description: null, verified: false, legal: null, terms: null, alsoCarrier: true,
  });

  it('в паузу — noindex; после — без запрета; чужой прокатчик — без запрета', async () => {
    loaders.bySlug.mockImplementation(async (slug: string) => (slug === 'laguna-prokat' ? profile(LAGUNA) : profile(BAY)));
    at(DURING);
    const paused = await generateMetadata({ params: Promise.resolve({ slug: 'laguna-prokat' }) });
    expect(paused.robots).toEqual({ index: false, follow: false });
    expect(paused.title).toBeTruthy();
    expect((await generateMetadata({ params: Promise.resolve({ slug: 'bay-rental' }) })).robots).toBeUndefined();
    at(AFTER);
    expect((await generateMetadata({ params: Promise.resolve({ slug: 'laguna-prokat' }) })).robots).toBeUndefined();
  });
});

describe('планер «Машина напрокат»', () => {
  it('в паузу — «вернётся», а не «нет»; рядом с другим прокатчиком — только он; после — снова', async () => {
    at(DURING);
    loaders.companies.mockResolvedValue([LAGUNA]);
    const paused = await findCarRentalOffers();
    expect(paused).toEqual({ state: 'paused', returnsOn: 'в понедельник, 26 октября' });
    expect(carRentalPausedAnswer('в понедельник, 26 октября').message).toBe('Прокат автомобилей вернётся на сайт в понедельник, 26 октября');

    loaders.companies.mockResolvedValue([LAGUNA, BAY]);
    const both = await findCarRentalOffers();
    expect(both.state === 'ok' && both.items.map((i) => i.slug)).toEqual(['bay-rental']);

    at(AFTER);
    loaders.companies.mockResolvedValue([LAGUNA]);
    const back = await findCarRentalOffers();
    expect(back.state === 'ok' && back.items.map((i) => i.slug)).toEqual(['laguna-prokat']);
  });

  it('пустой прайс без паузы — по-прежнему «нет», отказ — «не смогли»', async () => {
    at(DURING);
    loaders.companies.mockResolvedValue([]);
    expect(await findCarRentalOffers()).toEqual({ state: 'empty' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    loaders.companies.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    expect(await findCarRentalOffers()).toEqual({ state: 'unavailable' });
    err.mockRestore();
  });
});

describe('sitemap', () => {
  it('в паузу страницы «Лагуны» нет, другой прокатчик есть; после — снова есть', async () => {
    loaders.pool.mockImplementation(async (sql: unknown) => ({
      rows: /car_rental_offers/.test(String(sql))
        ? [{ slug: 'laguna-prokat', updated_at: new Date('2026-10-23') }, { slug: 'bay-rental', updated_at: new Date('2026-10-23') }]
        : [],
    }));
    at(DURING);
    let urls = (await collectSitemapEntriesWithStatus()).entries.map((e) => e.url);
    expect(urls.some((u) => u.endsWith('/car-rental/laguna-prokat'))).toBe(false);
    expect(urls.some((u) => u.endsWith('/car-rental/bay-rental'))).toBe(true);
    at(AFTER);
    urls = (await collectSitemapEntriesWithStatus()).entries.map((e) => e.url);
    expect(urls.some((u) => u.endsWith('/car-rental/laguna-prokat'))).toBe(true);
  });
});

describe('страница трансфера «Лагуны»: ссылка на её прокат', () => {
  const CARRIER = { partnerId: 'p-laguna-prokat', slug: 'laguna-prokat', name: 'Лагуна Прокат', destinations: [] } as unknown as CarrierProfile;

  it('в паузу ссылки нет и база о прокате не спрашивается; после — есть', async () => {
    loaders.carrier.mockResolvedValue(CARRIER);
    loaders.hasRental.mockResolvedValue(true);
    at(DURING);
    expect((await loadCarrierPage('laguna-prokat'))?.rental).toEqual({ state: 'ok', has: false });
    expect(loaders.hasRental).not.toHaveBeenCalled();
    at(AFTER);
    expect((await loadCarrierPage('laguna-prokat'))?.rental).toEqual({ state: 'ok', has: true });
    expect(loaders.hasRental).toHaveBeenCalledWith('p-laguna-prokat');
  });
});

describe('двери «Прокат» на главной', () => {
  it('десктоп (главная зовёт DeskTours без признака — он спрашивает паузу сам): в паузу ссылки нет, после — есть', () => {
    at(DURING);
    const off = render(<DeskTours plates={[]} total={null} />);
    expect(off.container.querySelector('a[href="/car-rental"]')).toBeNull();
    expect(off.container.querySelector('a[href="/accommodations"]')).not.toBeNull();
    off.unmount();
    at(AFTER);
    const on = render(<DeskTours plates={[]} total={null} />);
    expect(on.container.querySelector('a[href="/car-rental"]')).not.toBeNull();
  });

  it('телефон: в ряду инструментов три двери без «Проката», когда rentalDoor=false; без поля — четыре', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const data: HomeV8Data = {
      safety: { activeCount: 0, maxSeverity: 0, alerts: [], volcanoes: [], updatedAt: null },
      seismic: { events: [], source: 'none', updatedAt: null, checkedAt: null },
      radar: { hazards: [], center: { lat: 53.04, lng: 158.65, label: 'Петропавловск-Камчатский' } },
      zones: { open: 0, total: 0, updatedAt: null },
      plates: [], transfer: null, stay: null, explore: [], feed: [], stats: [], elements: [],
    };
    const doors = (c: HTMLElement) => [...c.querySelectorAll('nav[aria-label="Инструменты поездки"] > a')].map((a) => a.getAttribute('href'));
    const off = render(<HomeV8Client data={{ ...data, rentalDoor: false }} />);
    expect(doors(off.container)).toEqual(['/planner', '/safety#radar', '/catalog', '/transfers', '/accommodations']);
    off.unmount();
    const on = render(<HomeV8Client data={data} />);
    expect(doors(on.container)).toEqual(['/planner', '/safety#radar', '/catalog', '/transfers', '/accommodations', '/car-rental']);
    vi.unstubAllGlobals();
  });
});
