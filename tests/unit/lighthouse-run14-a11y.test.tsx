// @vitest-environment jsdom
/**
 * Доступность /map и /catalog по Lighthouse, прогон 14 (14.10).
 *
 * Найдено расшифровкой «не пройдено» (scripts/site-audit.py) и повторено
 * локально axe-core в Chromium:
 *  - /catalog, heading-order: названия туров — h3 сразу после h1 героя;
 *  - /catalog, target-size: ссылка на оператора высотой 16 px лежит на ссылке
 *    всей карточки — 37 карточек, 37 узлов;
 *  - /map, color-contrast: «Действующих тревог нет» на тонком стекле поверх
 *    светлой карты — 3,5:1; счётчик активного чипа — белый 70% на --accent;
 *  - /map, target-size: атрибуция MapLibre целиком под кнопкой «моё место» —
 *    подписи OSM на экране не было вовсе.
 *
 * jsdom не считает раскладку, поэтому размер цели держит класс, а контраст —
 * значения из globals.css; сами числа сняты в браузере (PR).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/image', () => ({
  default: (p: { src: string; alt: string }) => React.createElement('img', { src: p.src, alt: p.alt }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/catalog',
}));
vi.mock('@/lib/auth/session-state', () => ({ sessionState: () => Promise.resolve(false) }));

import MarketplaceClient from '@/components/marketplace/MarketplaceClient';
import { MapThreatChip } from '@/components/map/MapThreatChip';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// ─── /catalog ───────────────────────────────────────────────────────────────

type Tour = NonNullable<React.ComponentProps<typeof MarketplaceClient>['initialTours']>[number];
const DAY = 86_400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const tour = (over: Partial<Tour>): Tour => ({
  id: 1, slug: 'a', title: 'Тур', description: 'Полное описание тура', short_description: null,
  base_price: 25000, price_old: null, price_unit: 'per_person', activity_type: 'fishing', location_type: 'river',
  location_name: 'Река Быстрая', tour_image: null, operator_name: 'Шатун', operator_id: 'p1',
  operator_verified: null, operator_slug: 'shatun', operator_public: true, bookings_count: 0,
  duration_hours: 10, duration_type: 'single_day', multi_day_count: null, difficulty: 'easy', included: null,
  season_start: iso(-30), season_end: iso(60), has_availability: true,
  ...over,
});
const KEY = JSON.stringify({ search: '', activityFilter: '', sort: 'recommended', difficulty: '', priceRange: '', durationType: '' });
const SUMMARY = { total: 2, minPrice: 25000, byActivity: [{ activity_type: 'fishing', count: 2 }] };

function storefront() {
  const tours = [tour({ id: 1, slug: 'a', title: 'Рыбалка на Быстрой' }), tour({ id: 2, slug: 'b', title: 'Вулкан Горелый' })];
  return render(<MarketplaceClient initialTours={tours} initialTotal={tours.length} initialKey={KEY} summary={SUMMARY} />);
}

describe('/catalog: заголовки и цели', () => {
  it('уровни заголовков идут по порядку: h1 героя → h2 списка → h3 карточек', () => {
    const { container } = storefront();
    const levels = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]));
    expect(levels[0]).toBe(1);
    expect(levels).toContain(3);
    // Как heading-order у axe: уровень растёт не больше чем на один шаг.
    levels.forEach((lvl, i) => {
      if (i > 0) expect(lvl - levels[i - 1], `скачок h${levels[i - 1]} → h${lvl}`).toBeLessThanOrEqual(1);
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Список туров' })).toBeInTheDocument();
  });

  it('ссылка на оператора в карточке — цель не ниже 24 px, строка не растёт', () => {
    storefront();
    const links = screen.getAllByTitle('Страница оператора «Шатун»');
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.tagName).toBe('A');
      // Строка text-xs — 16 px; py-1 добавляет 8 px цели, -my-1 их же
      // возвращает раскладке.
      expect(a.className.split(/\s+/)).toEqual(expect.arrayContaining(['py-1', '-my-1', 'pointer-events-auto']));
    }
  });
});

// ─── /map ───────────────────────────────────────────────────────────────────

const CSS = read('app/globals.css');

/** rgba(...) из правила `.<cls> {` — фон или переменная. */
function rgba(cls: string, prop: string): [number, number, number, number] {
  const at = CSS.indexOf(`.${cls} {`);
  expect(at, cls).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(at, CSS.indexOf('}', at));
  const m = body.match(new RegExp(`${prop}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`));
  expect(m, `${cls} ${prop}`).not.toBeNull();
  return [Number(m![1]), Number(m![2]), Number(m![3]), Number(m![4])];
}
const over = (fg: [number, number, number, number], bg: number[]) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3]));
function lum(rgb: number[]): number {
  const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Контраст строки стекла над самым светлым, что бывает под ним, — белым. */
function glassContrast(cls: string): number {
  const bg = over(rgba(cls, 'background'), [255, 255, 255]);
  return contrast(over(rgba(cls, '--glass-fg'), bg), bg);
}

describe('/map: плашка обстановки читается над светлой картой', () => {
  it('тонкое стекло не держит AA под текстом — поэтому плотное', () => {
    expect(glassContrast('fx-glass')).toBeLessThan(4.5);
    expect(glassContrast('fx-glass-dense')).toBeGreaterThanOrEqual(4.5);
  });

  it('плашка рисуется на плотном стекле', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      success: true, data: { level: 'calm', unavailable: false, alerts: [] },
    })));
    render(<MapThreatChip />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/safety#radar');
    const classes = link.className.split(/\s+/);
    expect(classes).toContain('fx-glass-dense');
    expect(classes).not.toContain('fx-glass');
  });
});

describe('/map: подпись карты видна', () => {
  const PAGE = read('app/map/_MapPageClient.tsx');

  it('своя карта не ставит контрол в угол кнопки «моё место», строка — на экране', () => {
    // Тег карты, а не `<VedarMapPlaceHit` в типах состояния.
    const at = PAGE.search(/<VedarMap\s/);
    expect(at).toBeGreaterThan(0);
    const props = PAGE.slice(at, PAGE.indexOf('/>', at));
    expect(props).toContain('attributionOutside');
    expect(PAGE).toContain('{VEDAR_ATTRIBUTION}');
  });

  it('строка берётся без кода карты: импорт из VedarMap затянул бы карту в первый чанк', () => {
    expect(PAGE).not.toMatch(/import \{[^}]*\bVEDAR_ATTRIBUTION\b[^}]*\} from '@\/components\/shared\/VedarMap'/);
  });
});

describe('/map: чипы фильтров', () => {
  const PAGE = read('app/map/_MapPageClient.tsx');

  it('счётчик без своей прозрачности и своего цвета — цветом чипа', () => {
    // Открывающий тег каждого счётчика: от `<span` до самого числа.
    const COUNT = "{loading ? '…' : cnt}";
    const tags: string[] = [];
    for (let i = PAGE.indexOf(COUNT); i >= 0; i = PAGE.indexOf(COUNT, i + 1)) {
      tags.push(PAGE.slice(PAGE.lastIndexOf('<span', i), i));
    }
    expect(tags.length, 'счётчики чипов не найдены — сторож смотрит не туда').toBeGreaterThanOrEqual(2);
    for (const tag of tags) {
      expect(tag).not.toMatch(/opacity-\d+|text-white|text-\[var\(/);
    }
  });
});
