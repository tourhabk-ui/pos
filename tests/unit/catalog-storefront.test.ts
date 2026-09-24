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
 * Поведенческие части (свёртка сводки, три исхода дат) проверяются вызовом,
 * а не текстом: у них есть логика, которую можно сломать, не тронув строки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { catalogAvailability, isInSeason, tourDays, AVAILABILITY_LABEL } from '@/lib/tours/catalog-availability';
import { summarizeCatalogRows } from '@/lib/search/tour-search';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CLIENT = read('components/marketplace/MarketplaceClient.tsx');
const SEARCH = read('lib/search/tour-search.ts');
const FOOTER = read('components/marketplace/CatalogFooter.tsx');
const CARD = CLIENT.slice(CLIENT.indexOf('function TourCard('), CLIENT.indexOf('/* ─── Planner Banner'));

/** Код без комментариев: в комментариях история нарушений описана — и должна. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

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
    expect(CLIENT).not.toMatch(/Сезон 20\d\d/);
  });
  it('сезон идёт — включая последний день сезона целиком', () => {
    expect(isInSeason(base, now)).toBe(true);
    expect(isInSeason({ ...base, season_start: '2026-10-01T00:00:00.000Z' }, now)).toBe(false);
    expect(isInSeason({ ...base, season_end: '2026-09-24T00:00:00.000Z' }, new Date('2026-09-24T20:00:00Z'))).toBe(true);
    expect(isInSeason({ ...base, season_end: null }, now)).toBe(false);
  });
});

describe('карточка говорит только то, что знает', () => {
  it('тип Tour несёт has_availability, карточка считает исход из него', () => {
    const type = CLIENT.slice(CLIENT.indexOf('interface Tour {'), CLIENT.indexOf('/* ─── Constants'));
    expect(type).toMatch(/has_availability\?: boolean \| null/);
    expect(CARD).toMatch(/const availability = catalogAvailability\(tour\)/);
    expect(CARD).toMatch(/\{AVAILABILITY_LABEL\[availability\]\}/);
  });
  it('«● Сезон» — только вместе с датами', () => {
    expect(CARD).toMatch(/const showSeason = availability === 'dates' && isInSeason\(tour\)/);
    expect(CARD).toMatch(/\{showSeason && \(/);
  });
  it('без дат кнопка честно называется «Оставить заявку»', () => {
    expect(CARD).toMatch(/availability === 'dates' \? 'Забронировать' : 'Оставить заявку'/);
  });
  it('«проверен» — только при partners.is_verified === true, и поле отдаёт поиск', () => {
    expect(CARD).toMatch(/tour\.operator_verified === true && \(/);
    expect(SEARCH).toMatch(/p\.is_verified as operator_verified/);
    expect(SEARCH).toMatch(/operator_verified: boolean \| null/);
  });
  it('состав (included) и оператор выводятся, описание — в две строки', () => {
    expect(CARD).toMatch(/\(tour\.included \?\? \[\]\)[\s\S]*?\.slice\(0, 3\)/);
    expect(CARD).toMatch(/\{tour\.operator_name\}/);
    expect(CARD).toMatch(/line-clamp-2 mb-1\.5">\s*\{tour\.short_description \?\? tour\.description\}/);
  });
  it('ссылки — сразу на канонический /catalog/tours/{id}, без 308 через /marketplace (#129)', () => {
    expect(CARD).toMatch(/const href = `\/catalog\/tours\/\$\{tour\.id\}`/);
    expect(CARD).toMatch(/href=\{`\$\{href\}#booking`\}/);
    expect(code(CLIENT)).not.toMatch(/\/marketplace\/tours\//);
  });
  it('корзины на карточке нет (решение владельца 24.09, развилка 6)', () => {
    expect(CLIENT).not.toMatch(/useCart/);
    expect(CLIENT).not.toMatch(/ShoppingCart/);
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
});

describe('страница не шире экрана и тур — на первом экране', () => {
  const hero = CLIENT.slice(CLIENT.indexOf('function HeroSection('), CLIENT.indexOf('/* ─── Tour Card'));
  it('герой на всю ширину без отрицательных полей', () => {
    expect(hero).not.toMatch(/-mx-\d/);
  });
  it('контент — в локальной обёртке с полями, общий .ds-page не трогается', () => {
    expect(CLIENT).toMatch(/<div className="px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">/);
  });
  it('главная кнопка героя — «Смотреть туры» к #tours, якорь не прячется под шапку', () => {
    expect(hero).toMatch(/<a href="#tours" className="ds-btn ds-btn-primary/);
    expect(hero.indexOf('href="#tours"')).toBeLessThan(hero.indexOf('href="/planner"'));
    expect(CLIENT).toMatch(/id="tours" className="scroll-mt-20"/);
  });
  it('факт героя — из серверной сводки, не константа', () => {
    expect(hero).toMatch(/summary\.total/);
    expect(hero).toMatch(/summary\.minPrice/);
  });
  it('баннер планировщика — после третьей карточки, а не над выдачей', () => {
    expect(CLIENT).toMatch(/showBanner=\{i === Math\.min\(2, tours\.length - 1\)\}/);
    const tours = CLIENT.indexOf('<div id="tours"');
    expect(CLIENT.indexOf('<PlannerBanner />')).toBeGreaterThan(tours);
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
  it('листинг и сводка считают «живой тур» одним условием', () => {
    expect(SEARCH).toMatch(/const conditions: string\[\] = \[\.\.\.LIVE_TOUR_CONDITIONS\]/);
    expect(SEARCH).toMatch(/WHERE \$\{LIVE_TOUR_CONDITIONS\.join\(' AND '\)\}/);
  });
  it('чипы строятся из сводки, подписи — из lib/tours/labels', () => {
    expect(CLIENT).toMatch(/summary\?\.byActivity \?\? \[\]/);
    expect(CLIENT).toMatch(/\{activityLabel\(c\.value, true\)\} · \{c\.count\}/);
  });
});

describe('доступность и цели нажатия', () => {
  it('поиск, очистка, сортировка и фильтры подписаны; фильтры — aria-expanded', () => {
    expect(CLIENT).toMatch(/aria-label="Поиск тура по названию"/);
    expect(CLIENT).toMatch(/aria-label="Очистить поиск"/);
    expect(CLIENT).toMatch(/aria-label="Сортировка"/);
    expect(CLIENT).toMatch(/aria-expanded=\{showFilters\}/);
    expect(CLIENT).toMatch(/aria-controls="catalog-filters"/);
    // Подпись «Фильтры» видна всегда, не только на sm+ (#134).
    expect(CLIENT).not.toMatch(/<span className="hidden sm:inline">Фильтры<\/span>/);
  });
  it('чипы и варианты фильтров — aria-pressed и ≥44px; сердце 44px', () => {
    expect(CLIENT).toMatch(/const CHIP_BASE = 'min-h-\[44px\]/);
    expect((CLIENT.match(/aria-pressed=/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(CARD).toMatch(/w-11 h-11 rounded-full/);
  });
});

describe('избранное у гостя — голос, а не молчаливый откат (§4.0)', () => {
  it('401 — тост «Войдите…» со входом и запись в лог; иной отказ — ошибка в лог', () => {
    const fn = CLIENT.slice(CLIENT.indexOf('const reportWishlistFailure'), CLIENT.indexOf('const handleToggleLike'));
    expect(fn).toMatch(/status === 401/);
    expect(fn).toMatch(/setNotice\(\{ text: 'Войдите, чтобы сохранить/);
    expect(fn).toMatch(/\/auth\/login\?from=/);
    expect(fn).toMatch(/console\.warn\(/);
    expect(fn).toMatch(/console\.error\(/);
    const toggle = CLIENT.slice(CLIENT.indexOf('const handleToggleLike'), CLIENT.indexOf('const resetFilters'));
    expect((toggle.match(/reportWishlistFailure\(status/g) ?? []).length).toBe(2);
  });
  it('тост — role="status", над таб-баром', () => {
    expect(CLIENT).toMatch(/role="status"/);
    expect(CLIENT).toMatch(/bottom: 'calc\(var\(--bottom-nav-h, 0px\) \+ 84px\)'/);
  });
  it('в клиенте каталога нет пустых catch', () => {
    expect(CLIENT).not.toMatch(/\.catch\(\(\) => \{\}\)/);
  });
});

describe('каркас страниц каталога', () => {
  for (const [page, active] of [['app/catalog/page.tsx', '/catalog'], ['app/marketplace/page.tsx', '/marketplace']] as const) {
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
      const file = join('app', p, 'page.tsx');
      expect(existsSync(join(ROOT, file)), file).toBe(true);
      expect(read(file), file).toMatch(new RegExp(`<BottomNav activePath="${p}"`));
    }
  });
});
