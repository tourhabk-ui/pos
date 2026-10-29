/**
 * Витрина /catalog — сторож пакета П5 аудита 24.09.
 *
 * Каждый блок здесь — возврат конкретной находки, подтверждённой замером:
 *   - страница была шире экрана (герой с -mx-* внутри .ds-page без полей):
 *     fixed-шапка с SOS уезжала вверх, кнопка заявки — за нижний край (#8/#12);
 *   - первый экран занимали сводка «—» и мёртвые плитки, тура не было (#7/#9);
 *   - карточка продавала «Забронировать» и «● Сезон» у туров без дат и с
 *     кончившимся сезоном — has_availability приходил и отбрасывался (#46/#51);
 *   - классы `bg-[var(--x)]/N` не генерируются Tailwind 3.4, и подложка
 *     стекла была прозрачной (#53/#58);
 *   - избранное у гостя молча откатывалось (§4.0, #50/#59);
 *   - таб «Туры» объявлял подсветку для /catalog, а страница таб-бар не
 *     рендерила — объявление без потребителя (§10.09, #56/#62/#98).
 *
 * 13.10 (карт-бланш владельца на сторожей по регулярке): карточка, герой,
 * чипы, доступность и избранное проверяются РЕНДЕРОМ витрины с данными, а
 * не литералами исходника — прежние регулярки ловили рефакторинг, а не
 * дефект (подпись оператора трижды за день). Регулярка по исходнику осталась
 * только для запретов (классы, которых Tailwind не соберёт, пустой catch,
 * старый адрес /marketplace) и для SQL источника данных.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { catalogAvailability, isInSeason, tourDays, AVAILABILITY_LABEL } from '@/lib/tours/catalog-availability';
import {
  summarizeCatalogRows, queryMarketplaceTours, queryCatalogSummary, MarketplaceToursQuerySchema,
} from '@/lib/search/tour-search';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { wishlistFailureText } from '@/lib/wishlist/contract';
import { activityLabel } from '@/lib/tours/labels';
import { activityIcon } from '@/lib/tours/activity-icons';
import { OFFER_ORDER_NOTE, SORT_CHOICE_NOTE_RU, orderOffers } from '@/lib/tours/offer-order';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog',
}));
const poolQuery = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
// Гость: избранное с сервера не грузится (аудит 01.10), сердце отвечает 401.
vi.mock('@/lib/auth/session-state', () => ({ sessionState: () => Promise.resolve(false) }));

import MarketplaceClient from '@/components/marketplace/MarketplaceClient';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CLIENT = read('components/marketplace/MarketplaceClient.tsx');
const SEARCH = read('lib/search/tour-search.ts');
const FOOTER = read('components/marketplace/CatalogFooter.tsx');

/** Код без комментариев: в комментариях история нарушений описана — и должна. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('три исхода дат на карточке (§4.0)', () => {
  const base = { season_start: '2026-06-15T00:00:00.000Z', season_end: '2026-10-15T00:00:00.000Z', duration_type: 'single_day', multi_day_count: null, duration_hours: 10 };
  const now = new Date('2026-09-24T12:00:00Z');

  it('есть открытая дата — «Есть даты», как бы ни стоял сезон', () => {
    expect(catalogAvailability({ ...base, has_availability: true, season_end: '2026-08-15T00:00:00.000Z' }, now)).toBe('dates');
  });
  it('дат нет, сезон ещё идёт — «Даты по запросу»', () => {
    expect(catalogAvailability({ ...base, has_availability: false }, now)).toBe('on_request');
  });
  it('дат нет, сезон кончился — «Сезон завершён, даты по запросу» (тур 5, сезон до 15.08)', () => {
    expect(catalogAvailability({ ...base, has_availability: false, season_end: '2026-08-15T00:00:00.000Z' }, now)).toBe('season_over');
  });
  it('длительность учитывается: недельный тур не влезает в сезон, кончающийся 30.09 (тур 10)', () => {
    const week = { ...base, duration_type: 'multi_day', multi_day_count: 7, duration_hours: 168, season_end: '2026-09-30T00:00:00.000Z' };
    expect(tourDays(week)).toBe(7);
    // Оба пути длительности: многодневный по числу дней и по часам.
    expect(tourDays({ duration_type: 'multi_day', multi_day_count: 5, duration_hours: null })).toBe(5);
    expect(tourDays({ duration_type: null, multi_day_count: null, duration_hours: 72 })).toBe(3);
    expect(tourDays({ duration_type: 'single_day', multi_day_count: null, duration_hours: 10 })).toBe(1);
    expect(catalogAvailability({ ...week, has_availability: false }, now)).toBe('season_over');
    // Двухдневный тур с сезоном до 15.10 — ещё по запросу (тур 7).
    const weekend = { ...base, duration_type: 'multi_day', multi_day_count: 2, duration_hours: 48 };
    expect(catalogAvailability({ ...weekend, has_availability: false }, now)).toBe('on_request');
  });
  it('поле не пришло — «не знаю» не выдаётся за «Есть даты»', () => {
    expect(catalogAvailability({ ...base, has_availability: undefined }, now)).toBe('on_request');
    expect(catalogAvailability({ ...base, has_availability: null, season_end: null }, now)).toBe('on_request');
  });
  it('подписи — ровно три, и будущий сезон не сочиняется', () => {
    expect(AVAILABILITY_LABEL).toEqual({
      dates: 'Есть даты',
      on_request: 'Даты по запросу',
      season_over: 'Сезон завершён, даты по запросу',
    });
  });
  it('сезон идёт — включая последний день сезона целиком', () => {
    expect(isInSeason(base, now)).toBe(true);
    expect(isInSeason({ ...base, season_start: '2026-10-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isInSeason({ ...base, season_end: '2026-09-24T00:00:00.000Z' }, new Date('2026-09-24T20:00:00Z'))).toBe(true);
    expect(isInSeason({ ...base, season_end: null }, now)).toBe(false);
  });
});

// ─── Рендер витрины ─────────────────────────────────────────────────────────

type Tour = NonNullable<React.ComponentProps<typeof MarketplaceClient>['initialTours']>[number];
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const tour = (over: Partial<Tour>): Tour => ({
  id: 1, slug: 'a', title: 'Тур', description: 'Полное описание тура', short_description: null,
  base_price: 25000, price_old: null, price_unit: 'per_person', activity_type: 'fishing', location_type: 'river',
  location_name: 'Река Быстрая', tour_image: null, operator_name: 'Камчатская рыбалка', operator_id: 'p1',
  operator_verified: null, operator_slug: 'fishingkam', operator_public: true, bookings_count: 0,
  duration_hours: 10, duration_type: 'single_day', multi_day_count: null, difficulty: 'easy', included: null,
  season_start: iso(-30), season_end: iso(60), has_availability: false,
  ...over,
});
const TOURS: Tour[] = [
  tour({ id: 1, slug: 'a', title: 'Тур с датами', has_availability: true, operator_verified: true, short_description: 'Коротко о туре', included: ['Трансфер', 'Обед', 'Снасти', 'Страховка'] }),
  tour({ id: 2, slug: 'b', title: 'Тур по запросу', operator_name: 'Местечко Камчатка', operator_slug: 'mestechko', operator_public: false }),
  tour({ id: 3, slug: 'c', title: 'Тур вне сезона', season_start: iso(-120), season_end: iso(-10) }),
  tour({ id: 4, slug: 'd', title: 'Тур без поля дат', has_availability: undefined }),
];
/** Ключ фильтров по умолчанию — тот же, что собирает RSC-страница: на маунте fetch не нужен. */
const KEY = JSON.stringify({ search: '', activityFilter: '', sort: 'recommended', difficulty: '', priceRange: '', durationType: '' });
const SUMMARY = { total: 37, minPrice: 7000, byActivity: [{ activity_type: 'fishing', count: 7 }, { activity_type: 'jeep_safari', count: 8 }] };

function storefront(tours: Tour[] = TOURS) {
  return render(<MarketplaceClient initialTours={tours} initialTotal={tours.length} initialKey={KEY} summary={SUMMARY} />);
}
/** Класс значка вида из единого словаря (lucide-fish и т.п.) — им ряд и сверяется. */
function iconToken(type: string): string {
  const { container, unmount } = render(React.createElement(activityIcon(type)));
  const token = [...(container.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-')) ?? '';
  unmount();
  return token;
}
/** Карточка — родитель ссылки-слоя, у которой доступное имя = название тура. */
const card = (title: string) => screen.getByRole('link', { name: title }).parentElement as HTMLElement;
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

describe('карточка говорит только то, что знает (рендер)', () => {
  it('три исхода дат словами; «Сезон» — только вместе с датами; будущий сезон не сочиняется', () => {
    storefront();
    expect(within(card('Тур с датами')).getByText('Есть даты')).toBeInTheDocument();
    expect(within(card('Тур с датами')).getByText('Сезон')).toBeInTheDocument();
    expect(within(card('Тур по запросу')).getByText('Даты по запросу')).toBeInTheDocument();
    expect(within(card('Тур по запросу')).queryByText('Сезон')).toBeNull();
    expect(within(card('Тур вне сезона')).getByText('Сезон завершён, даты по запросу')).toBeInTheDocument();
    expect(within(card('Тур вне сезона')).queryByText('Сезон')).toBeNull();
    // Поле не пришло — «не знаю», а не «Есть даты».
    expect(within(card('Тур без поля дат')).getByText('Даты по запросу')).toBeInTheDocument();
    expect(screen.queryByText(/Сезон 20\d\d/)).toBeNull();
  });

  it('кнопка честная: с датами — «Отправить заявку», без — «Оставить заявку»; обе — на #booking канонического адреса', () => {
    const { container } = storefront();
    expect(within(card('Тур с датами')).getByRole('link', { name: /Отправить заявку/ }).getAttribute('href')).toBe('/catalog/tours/a#booking');
    expect(within(card('Тур по запросу')).getByRole('link', { name: /Оставить заявку/ }).getAttribute('href')).toBe('/catalog/tours/b#booking');
    expect(within(card('Тур по запросу')).queryByRole('link', { name: /Отправить заявку/ })).toBeNull();
    // Слой навигации по всей карточке — тоже на канонический адрес (#129: /marketplace уходил 308 и терял #booking).
    expect(screen.getByRole('link', { name: 'Тур с датами' }).getAttribute('href')).toBe('/catalog/tours/a');
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.filter((h) => h.includes('/marketplace/tours/'))).toEqual([]);
  });

  it('«проверен» — только при partners.is_verified === true; имя оператора — ссылка только у открытой карточки', () => {
    const { container } = storefront();
    const a = card('Тур с датами');
    expect(a).toHaveTextContent('проверен');
    expect(within(a).getByRole('link', { name: 'Камчатская рыбалка' }).getAttribute('href')).toBe('/operators/fishingkam');
    const b = card('Тур по запросу');
    expect(b).not.toHaveTextContent('проверен');
    expect(b).toHaveTextContent('Местечко Камчатка');
    expect(within(b).queryByRole('link', { name: 'Местечко Камчатка' })).toBeNull();
    // Ссылка оператора лежит поверх слоя-ссылки на тур, а не внутри него.
    expect(container.querySelectorAll('a a')).toHaveLength(0);
  });

  it('описание — краткое, если есть, иначе полное; состав — не больше трёх позиций', () => {
    storefront();
    const a = card('Тур с датами');
    expect(a).toHaveTextContent('Коротко о туре');
    expect(a).not.toHaveTextContent('Полное описание тура');
    expect(card('Тур по запросу')).toHaveTextContent('Полное описание тура');
    const included = within(a).getByRole('list', { name: 'Входит в цену' });
    expect(within(included).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Трансфер', 'Обед', 'Снасти']);
    expect(within(card('Тур по запросу')).queryByRole('list', { name: 'Входит в цену' })).toBeNull();
  });

  it('сердце — кнопка с целью 44px поверх слоя, не нажата у гостя; корзины на карточке нет', () => {
    storefront();
    const heart = within(card('Тур с датами')).getByRole('button', { name: 'В избранное' });
    expect(heart.className).toMatch(/\bw-11 h-11\b/);
    expect(heart.getAttribute('aria-pressed')).toBe('false');
    // Решение владельца 24.09, развилка 6.
    expect(CLIENT).not.toMatch(/useCart/);
    expect(CLIENT).not.toMatch(/ShoppingCart/);
  });

  it('источник данных отдаёт is_verified, slug и is_public рядом с именем оператора', () => {
    expect(SEARCH).toMatch(/p\.is_verified as operator_verified/);
    expect(SEARCH).toMatch(/operator_verified: boolean \| null/);
    expect(SEARCH).toMatch(/p\.slug as operator_slug/);
    expect(SEARCH).toMatch(/p\.is_public as operator_public/);
  });
});

describe('Tailwind-классы, которые не генерируются, в каталог не возвращаются', () => {
  it('нет форм `*-[var(--x)]/N` — только color-mix', () => {
    for (const [name, src] of [['MarketplaceClient', CLIENT], ['CatalogFooter', FOOTER]] as const) {
      expect(src, name).not.toMatch(/\[var\(--[a-z0-9-]+\)\]\/\d+/);
    }
    expect(CLIENT).toMatch(/color-mix\(in srgb, var\(\$\{token\}\) \$\{pct\}%, transparent\)/);
  });
  it('нет несуществующего токена --bg-page и нестандартного шага bg-black/22', () => {
    expect(code(CLIENT)).not.toMatch(/--bg-page/);
    expect(code(CLIENT)).not.toMatch(/bg-black\/22/);
  });
  it('герой — без отрицательных полей (страница была шире экрана, #8/#12)', () => {
    const hero = CLIENT.slice(CLIENT.indexOf('function HeroSection('), CLIENT.indexOf('/* ─── Tour Card'));
    expect(hero).not.toMatch(/-mx-\d/);
  });
});

describe('тур — на первом экране (рендер)', () => {
  it('герой: h1 — запрос «Туры на Камчатку», факт из сводки, «Смотреть туры» ведёт к #tours и стоит раньше планера', () => {
    const { container } = storefront();
    expect(screen.getByRole('heading', { level: 1, name: 'Туры на Камчатку' })).toBeInTheDocument();
    expect(container).toHaveTextContent(/37 туров от 7\s?000 ₽/);
    const see = screen.getByRole('link', { name: /Смотреть туры/ });
    expect(see.getAttribute('href')).toBe('#tours');
    expect(see.className).toMatch(/\bds-btn-primary\b/);
    const planner = screen.getByRole('link', { name: /Кузьмичом/ });
    expect(planner.getAttribute('href')).toBe('/planner');
    expect(see.compareDocumentPosition(planner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Якорь не прячется под липкую шапку; контент — в обёртке с полями, общий .ds-page не трогается.
    const tours = container.querySelector('#tours') as HTMLElement;
    expect(tours.className).toMatch(/\bscroll-mt-20\b/);
    expect(tours.parentElement?.className).toMatch(/px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto/);
  });

  it('без сводки факта в герое нет, а не «0 туров»', () => {
    render(<MarketplaceClient initialTours={TOURS} initialTotal={4} initialKey={KEY} summary={null} />);
    const hero = screen.getByRole('region', { name: 'Туры на Камчатку' });
    expect(within(hero).queryByText(/\d+ тур/)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Направления' })).toBeNull();
  });

  it('баннер планировщика — после третьей карточки (или последней), а не над выдачей', () => {
    const five = [1, 2, 3, 4, 5].map((i) => tour({ id: i, slug: `t${i}`, title: `Тур ${i}` }));
    storefront(five);
    const banner = screen.getByText('Не знаете, что выбрать?').closest('a') as HTMLElement;
    expect(banner.getAttribute('href')).toBe('/planner');
    const grid = banner.parentElement as HTMLElement;
    expect([...grid.children].indexOf(banner)).toBe(3);
    cleanup();
    storefront(five.slice(0, 2));
    const short = screen.getByText('Не знаете, что выбрать?').closest('a') as HTMLElement;
    expect([...(short.parentElement as HTMLElement).children].indexOf(short)).toBe(2);
  });
});

describe('сводка витрины: направления только с турами', () => {
  it('свёртка GROUP BY: итог, цена «от», пустые и безымянные не попадают в чипы', () => {
    const s = summarizeCatalogRows([
      { activity_type: 'fishing', n: 7, min_price: '25000.00' },
      { activity_type: 'rafting', n: 1, min_price: '13000.00' },
      { activity_type: null, n: 2, min_price: '9000' },
      { activity_type: 'trekking', n: 0, min_price: null },
    ]);
    expect(s.total).toBe(10);
    expect(s.minPrice).toBe(9000);
    expect(s.byActivity).toEqual([
      { activity_type: 'fishing', count: 7 },
      { activity_type: 'rafting', count: 1 },
    ]);
  });
  it('туров нет — цены «от» нет (null, не 0)', () => {
    expect(summarizeCatalogRows([])).toEqual({ total: 0, minPrice: null, byActivity: [] });
  });
  it('листинг и сводка считают «живой тур» одним условием — шлюзом витрины', async () => {
    // Поведением, а не литералом: в SQL, который листинг и сводка реально
    // отправляют, стоит publicTourSql('ot'). До 15.10 тут сравнивалась строка
    // `[...LIVE_TOUR_CONDITIONS]` — второго канона того же правила, снятого
    // находкой аудита P1-04.
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: [{ total: 0 }], rowCount: 0 });
    await queryMarketplaceTours(MarketplaceToursQuerySchema.parse({}));
    await queryCatalogSummary();
    const sent = poolQuery.mock.calls.map((c) => String(c[0]));
    // Листинг — один запрос (число «из M» — длина отфильтрованного списка,
    // правило 1в, 29.10), сводка — второй.
    expect(sent).toHaveLength(2);
    for (const sql of sent) expect(sql).toContain(publicTourSql('ot'));
  });
  it('чипы — из сводки: вид значком из единого словаря и числом, название — в доступном имени; aria-pressed и цель 44px', () => {
    // Владелец 16.10: «заменим надписи на иконки будет интересней» — ряд словами
    // обрезался посреди слова («Вертолё…»).
    const fish = iconToken('fishing');
    const car = iconToken('jeep_safari');
    storefront();
    const group = screen.getByRole('group', { name: 'Направления' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map((b) => b.textContent)).toEqual(['Все · 37', '7', '8']);
    expect(chips[1]!.querySelector('svg')?.classList.contains(fish)).toBe(true);
    expect(chips[2]!.querySelector('svg')?.classList.contains(car)).toBe(true);
    expect(chips.slice(1).map((b) => b.getAttribute('aria-label'))).toEqual([
      `${activityLabel('fishing', true)} — 7 туров`,
      `${activityLabel('jeep_safari', true)} — 8 туров`,
    ]);
    expect(chips.slice(1).map((b) => b.getAttribute('title'))).toEqual([
      activityLabel('fishing', true),
      activityLabel('jeep_safari', true),
    ]);
    expect(chips.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    for (const b of chips) expect(b.className).toMatch(/min-h-\[44px\]/);
  });
  it('выбранный вид — значок и слово: видно, что выбрано (вход по ?activity_type=)', async () => {
    window.history.replaceState({}, '', '/catalog?activity_type=fishing');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ tours: [], total: 0 }) } as unknown as Response);
    try {
      storefront();
      await flush();
      const chips = within(screen.getByRole('group', { name: 'Направления' })).getAllByRole('button');
      expect(chips.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
      expect(chips[1]!.textContent).toBe(`${activityLabel('fishing', true)} · 7`);
      expect(chips[1]!.querySelector('svg')?.classList.contains(iconToken('fishing'))).toBe(true);
      expect(chips[2]!.textContent).toBe('8');
    } finally {
      window.history.replaceState({}, '', '/catalog');
    }
  });
  it('где значок сам не скажет — слово: общий значок вида и два одинаковых значка в ряду', () => {
    render(
      <MarketplaceClient
        initialTours={TOURS}
        initialTotal={TOURS.length}
        initialKey={KEY}
        summary={{
          total: 6,
          minPrice: 7000,
          byActivity: [
            { activity_type: 'horseback', count: 1 },
            { activity_type: 'rafting', count: 2 },
            { activity_type: 'surf', count: 1 },
            { activity_type: 'helicopter', count: 2 },
          ],
        }}
      />,
    );
    const chips = within(screen.getByRole('group', { name: 'Направления' })).getAllByRole('button');
    expect(chips.map((b) => b.textContent)).toEqual([
      'Все · 6',
      `${activityLabel('horseback', true)} · 1`,
      `${activityLabel('rafting', true)} · 2`,
      `${activityLabel('surf', true)} · 1`,
      '2',
    ]);
    // Общий билет и две одинаковые волны значком не рисуются; вертолёт — свой и один.
    for (const b of chips.slice(1, 4)) expect(b.querySelector('svg')).toBeNull();
    expect(chips[4]!.querySelector('svg')?.classList.contains(iconToken('helicopter'))).toBe(true);
  });
});

describe('доступность и цели нажатия (рендер)', () => {
  it('поиск, очистка, сортировка и фильтры подписаны; панель фильтров раскрывается с aria-expanded', () => {
    const { container } = storefront();
    const search = screen.getByLabelText('Поиск тура по названию');
    expect(screen.queryByRole('button', { name: 'Очистить поиск' })).toBeNull();
    fireEvent.change(search, { target: { value: 'сплав' } });
    expect(screen.getByRole('button', { name: 'Очистить поиск' })).toBeInTheDocument();
    expect(screen.getByLabelText('Сортировка')).toBeInTheDocument();

    const filters = screen.getByRole('button', { name: /Фильтры/ });
    expect(filters.getAttribute('aria-expanded')).toBe('false');
    expect(filters.getAttribute('aria-controls')).toBe('catalog-filters');
    // Подпись «Фильтры» видна всегда, не только на sm+ (#134).
    const label = [...filters.querySelectorAll('span')].find((s) => s.textContent === 'Фильтры');
    expect(label?.className ?? '').not.toMatch(/\bhidden\b/);
    expect(container.querySelector('#catalog-filters')).toBeNull();
    fireEvent.click(filters);
    expect(filters.getAttribute('aria-expanded')).toBe('true');
    const panel = container.querySelector('#catalog-filters') as HTMLElement;
    expect(panel).not.toBeNull();
    // Варианты фильтров — переключатели с aria-pressed и целью 44px.
    const options = within(panel).getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed'));
    expect(options.length).toBeGreaterThanOrEqual(4);
    for (const b of options) expect(b.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('избранное у гостя — голос, а не молчаливый откат (§4.0, рендер)', () => {
  it('401 — тост «Войдите…» со входом, предупреждение в лог, сердце откатывается', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    storefront();
    const heart = within(card('Тур с датами')).getByRole('button', { name: 'В избранное' });
    await act(async () => { fireEvent.click(heart); });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith('/api/tourist/wishlist', expect.objectContaining({ method: 'POST' }));
    const toast = screen.getByRole('status');
    expect(toast).toHaveTextContent('Войдите, чтобы сохранить тур в избранное');
    expect(within(toast).getByRole('link', { name: 'Войти' }).getAttribute('href')).toMatch(/^\/auth\/login\?from=%2Fcatalog/);
    // Над таб-баром и плавающей кнопкой заявки.
    expect(toast.style.bottom).toBe('calc(var(--bottom-nav-h, 0px) + 84px)');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(within(card('Тур с датами')).getByRole('button', { name: 'В избранное' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('иной отказ — ошибка в лог и слова отказа, не тишина', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    storefront();
    await act(async () => { fireEvent.click(within(card('Тур по запросу')).getByRole('button', { name: 'В избранное' })); });
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent(wishlistFailureText(500));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('в клиенте каталога нет пустых catch', () => {
    expect(CLIENT).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

describe('каркас страниц каталога', () => {
  for (const [page, active] of [['app/catalog/(list)/page.tsx', '/catalog']] as const) {
    it(`${page}: таб-бар с «Туры», футер, отказ SSR в лог`, () => {
      const src = read(page);
      expect(src).toContain(`<BottomNav activePath="${active}" />`);
      expect(src).toContain('<CatalogFooter />');
      expect(src).toMatch(/console\.error\('\[[^']+\] SSR: запрос '/);
      expect(code(src)).not.toMatch(/catch\s*\{/);
    });
  }
  it('футер: общий <Footer> на md+, на телефоне — реквизиты из единого источника', () => {
    expect(FOOTER).toMatch(/<div className="hidden md:block">\s*<Footer \/>/);
    expect(FOOTER).toMatch(/REQUISITES\.shortName/);
    expect(FOOTER).toMatch(/REQUISITES\.inn/);
    expect(FOOTER).not.toMatch(/4101147649/);
    expect(FOOTER).toMatch(/var\(--bottom-nav-h, 0px\)/);
  });
  it('каждый путь, на котором таб «Туры» объявляет подсветку, рендерит BottomNav (§10.09)', () => {
    const nav = read('components/shared/BottomNav.tsx');
    const m = nav.match(/label: 'Туры',[^\n]*activeOn: \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const paths = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map(x => x[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      // Список может лежать в группе маршрутов (list) — адрес тот же (Н2 аудита SEO 29.09).
      const direct = join('app', p, 'page.tsx');
      const grouped = join('app', p, '(list)', 'page.tsx');
      const file = existsSync(join(ROOT, direct)) ? direct : grouped;
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(read(file), file).toMatch(new RegExp(`<BottomNav activePath="${p}"`));
    }
  });
});

// ─── Правило 1в (слово владельца 29.10) ─────────────────────────────────────

describe('порядок каталога — правило 1в, названное на странице', () => {
  type Row = { id: number; base_price: number | null; nearest_free_date: string | null; title: string };
  const rows: Row[] = [
    { id: 11, base_price: 9000, nearest_free_date: null, title: 'Без даты А' },
    { id: 12, base_price: 30000, nearest_free_date: '2026-11-20', title: 'Дата позже' },
    { id: 13, base_price: 9000, nearest_free_date: null, title: 'Без даты Б' },
    { id: 14, base_price: 50000, nearest_free_date: '2026-11-03', title: 'Дата раньше' },
    { id: 15, base_price: null, nearest_free_date: null, title: 'Цена не записана' },
    ...Array.from({ length: 20 }, (_, i) => ({ id: 100 + i, base_price: 9000, nearest_free_date: null, title: `Ничья ${i}` })),
  ];
  const DAY_UTC = new Date('2026-10-29T03:00:00Z'); // 29.10 по Камчатке
  const rule = (list: Row[]) => orderOffers(list.map((r) => ({ ...r, nearestFreeDate: r.nearest_free_date }))).map((r) => r.id);
  async function listing(params: Record<string, unknown>) {
    poolQuery.mockReset();
    poolQuery.mockResolvedValue({ rows: rows.map((r) => ({ ...r })), rowCount: rows.length });
    return queryMarketplaceTours(MarketplaceToursQuerySchema.parse(params));
  }

  it('по умолчанию — ровно orderOffers: сначала даты по ближайшей, остальные жребием дня; в SQL нет ORDER BY и LIMIT', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_UTC);
    try {
      const r = await listing({ limit: 100 });
      expect(r.tours.map((t) => t.id)).toEqual(rule(rows));
      expect(r.tours.slice(0, 2).map((t) => t.id)).toEqual([14, 12]);
      expect(r.total).toBe(rows.length);
      expect(r.day).toBe('2026-10-29');
      expect(r.tours.find((t) => t.id === 14)?.has_availability).toBe(true);
      expect(r.tours.find((t) => t.id === 11)?.has_availability).toBe(false);
      const sql = String(poolQuery.mock.calls[0]![0]);
      expect(sql).not.toMatch(/ORDER BY ot\.|created_at|LIMIT \$/);
    } finally { vi.useRealTimers(); }
  });

  it('страница режется после порядка: offset/limit — кусок того же списка, total — все прошедшие фильтры', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_UTC);
    try {
      const full = rule(rows);
      const page2 = await listing({ limit: 5, offset: 5 });
      expect(page2.tours.map((t) => t.id)).toEqual(full.slice(5, 10));
      expect(page2.total).toBe(rows.length);
    } finally { vi.useRealTimers(); }
  });

  it('«Новые» (?sort=recent) — тот же порядок, что по умолчанию: новизна в порядок не входит', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_UTC);
    try {
      expect(MarketplaceToursQuerySchema.parse({ sort: 'recent' }).sort).toBe('recommended');
      const recent = await listing({ sort: 'recent', limit: 100 });
      expect(recent.tours.map((t) => t.id)).toEqual(rule(rows));
    } finally { vi.useRealTimers(); }
  });

  it('цену включает турист: равные цены — правилом, а не по названию; цена не записана — в конце', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_UTC);
    try {
      const asc = (await listing({ sort: 'price_asc', limit: 100 })).tours;
      const cheap = rows.filter((r) => r.base_price === 9000);
      expect(asc.slice(0, cheap.length).map((t) => t.id)).toEqual(rule(cheap));
      expect(asc[asc.length - 1]!.id).toBe(15);
      const desc = (await listing({ sort: 'price_desc', limit: 100 })).tours;
      expect(desc.slice(0, 2).map((t) => t.id)).toEqual([14, 12]);
      expect(desc[desc.length - 1]!.id).toBe(15);
    } finally { vi.useRealTimers(); }
  });

  it('жребий дня воспроизводим и меняется с датой Камчатки, а не с запросом', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(DAY_UTC);
      const a = (await listing({ limit: 100 })).tours.map((t) => t.id);
      const b = (await listing({ limit: 100 })).tours.map((t) => t.id);
      expect(b).toEqual(a);
      vi.setSystemTime(new Date('2026-10-30T03:00:00Z'));
      const next = (await listing({ limit: 100 })).tours.map((t) => t.id);
      expect(next.slice(0, 2)).toEqual([14, 12]);
      expect(next).not.toEqual(a);
    } finally { vi.useRealTimers(); }
  });
});

describe('витрина называет правило и показывает, сколько из скольких (рендер)', () => {
  const many = Array.from({ length: 50 }, (_, i) => tour({ id: i + 1, slug: `t${i + 1}`, title: `Тур ${i + 1}` }));

  it('подпись правила кончается «Место в списке не продаётся.», под ней — что цену включает сам турист', () => {
    storefront();
    const note = screen.getByText(OFFER_ORDER_NOTE.ru);
    expect(note.textContent).toMatch(/Место в списке не продаётся\.$/);
    const sortNote = screen.getByText(SORT_CHOICE_NOTE_RU);
    expect(note.compareDocumentPosition(sortNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('сортировка: «Сначала со свободными местами» и цена; «Рекомендуемые» и «Новые» нет', () => {
    storefront();
    const select = screen.getByLabelText('Сортировка') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual(['Сначала со свободными местами', 'Цена: дешевле', 'Цена: дороже']);
    expect(select.value).toBe('recommended');
  });

  it('старый адрес ?sort=recent открывает порядок по правилу, а не пустой выбор', async () => {
    window.history.replaceState({}, '', '/catalog?sort=recent');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tours: TOURS, total: 4 }), { status: 200 }),
    );
    try {
      storefront();
      await flush();
      expect((screen.getByLabelText('Сортировка') as HTMLSelectElement).value).toBe('recommended');
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.some((u) => u.includes('sort=recent'))).toBe(false);
    } finally { window.history.replaceState({}, '', '/catalog'); }
  });

  it('«Показано 50 из 75» и «Показать ещё» дозапрашивает с offset=50 и дописывает список', async () => {
    const more = Array.from({ length: 25 }, (_, i) => tour({ id: 51 + i, slug: `m${i}`, title: `Ещё тур ${i + 1}` }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tours: more, total: 75 }), { status: 200 }),
    );
    render(<MarketplaceClient initialTours={many} initialTotal={75} initialKey={KEY} summary={SUMMARY} />);
    expect(screen.getByText(/Показано 50 из 75 туров/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Показать ещё/ });
    expect(btn.className).toMatch(/min-h-\[44px\]/);
    fireEvent.click(btn);
    await flush();
    const url = String(fetchSpy.mock.calls.at(-1)![0]);
    expect(url).toMatch(/^\/api\/hub\/marketplace\/tours\?/);
    expect(new URL(url, 'https://x').searchParams.get('offset')).toBe('50');
    expect(screen.getByText(/Показано 75 из 75 туров/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ещё тур 25' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Показать ещё/ })).toBeNull();
  });

  it('отказ «Показать ещё» — слова у кнопки, показанное остаётся', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<MarketplaceClient initialTours={many} initialTotal={75} initialKey={KEY} summary={SUMMARY} />);
    fireEvent.click(screen.getByRole('button', { name: /Показать ещё/ }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Следующие туры не загрузились');
    expect(screen.getByText(/Показано 50 из 75 туров/)).toBeInTheDocument();
  });

  it('все показаны — кнопки нет', () => {
    storefront();
    expect(screen.getByText(/Показано 4 из 4 туров/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Показать ещё/ })).toBeNull();
  });
});
