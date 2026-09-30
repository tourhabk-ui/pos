/**
 * ЧПУ туров (решение владельца 30.09, аудит SEO 29.09).
 *
 * Канон карточки — /catalog/tours/{slug}; число открывает её и уводит 308 на
 * адрес, мусорный сегмент — 404 (прежний parseInt('12abc') открывал тур 12).
 * Сторож держит связку целиком: разбор сегмента, редирект, canonical, и все
 * производители канонических ссылок (sitemap, llms.txt, IndexNow, MCP,
 * JSON-LD рыбалки, витрина, место, оператор) строят адрес одной функцией.
 * Адреса раздаёт миграция 1114 — у неё уникальный индекс и триггер на вставку.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { parseTourParam, tourPath } from '@/lib/tours/tour-url';
import { loadTourCard } from '@/lib/tours/tour-detail-query';

const read = (p: string) => readFileSync(p, 'utf-8');

describe('разбор сегмента адреса', () => {
  it('число целиком, адрес латиницей, прочее — null', () => {
    expect(parseTourParam('27')).toEqual({ kind: 'id', id: 27 });
    expect(parseTourParam('splav-po-reke-bystraya')).toEqual({ kind: 'slug', slug: 'splav-po-reke-bystraya' });
    expect(parseTourParam('12abc')).toEqual({ kind: 'slug', slug: '12abc' });
    expect(parseTourParam('Сплав')).toBeNull();
    expect(parseTourParam('a--b')).toBeNull();
    expect(parseTourParam("27' OR 1=1")).toBeNull();
  });

  it('путь — адрес, если он есть, иначе число', () => {
    expect(tourPath({ id: 27, slug: 'splav' })).toBe('/catalog/tours/splav');
    expect(tourPath({ id: 27, slug: null })).toBe('/catalog/tours/27');
    expect(tourPath({ id: '27', slug: '  ' })).toBe('/catalog/tours/27');
  });
});

describe('карточка по адресу', () => {
  beforeEach(() => query.mockReset());

  it('адрес → id → карточка; отмечено, что пришли не по числу', async () => {
    query.mockImplementation(async (sql: string) =>
      /WHERE slug = \$1/.test(sql) ? { rows: [{ id: 27 }] } : { rows: [{ id: 27, slug: 'splav', title: 'Сплав', operator_contacts: null }] });
    const r = await loadTourCard('splav');
    expect(r?.tour.id).toBe(27);
    expect(r?.byId).toBe(false);
  });

  it('мусорный сегмент — 404 без похода в базу', async () => {
    expect(await loadTourCard('Сплав по реке')).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it('«12abc» больше не открывает тур 12: это адрес, которого нет', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await loadTourCard('12abc')).toBeNull();
    expect(query.mock.calls.every((c) => !/WHERE ot\.id = \$1/.test(String(c[0])) || c[1]?.[0] !== 12)).toBe(true);
  });
});

describe('страницы карточки', () => {
  for (const f of ['app/catalog/tours/[id]/page.tsx', 'app/marketplace/tours/[id]/page.tsx']) {
    it(`${f}: адрес, 308 с числа, canonical на адрес`, () => {
      const src = read(f);
      expect(src).toMatch(/loadTourCard\(id\)/);
      expect(src).toMatch(/if \(loaded\.byId && tour\.slug\) permanentRedirect\(tourPath\(tour\)\)/);
      expect(src).not.toMatch(/parseInt\(id\)/);
      expect(src).not.toMatch(/\/catalog\/tours\/\$\{tour\.id\}/);
      expect((src.match(/\$\{SITE\}\$\{tourPath\(tour\)\}/g) ?? []).length).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('производители канонических ссылок строят адрес одной функцией', () => {
  const PRODUCERS = [
    'lib/seo/sitemap-entries.ts',
    'app/llms.txt/route.ts',
    'lib/seo/indexnow.ts',
    'lib/mcp/handoff-targets.ts',
    'lib/kuzmich/tour-availability-tool.ts',
    'app/hub/fishing/page.tsx',
    'app/hub/fishing/_FishingPageClient.tsx',
    'components/marketplace/MarketplaceClient.tsx',
    'components/places/PlaceTours.tsx',
    'app/operators/[slug]/page.tsx',
    // Внутренние ссылки (30.09): главная, Кузьмич, ИИ-чат, планер, поиск,
    // рыба, рекомендации, посты канала и пуши — адрес, а не два 308 подряд.
    'app/plans/[slug]/page.tsx',
    'app/trip/[token]/_TripShareClient.tsx',
    'app/_home/_HomeV8Client.tsx',
    'components/homepage/FeaturedTour.tsx',
    'components/homepage/TourGrid.tsx',
    'components/homepage/KuzmichBriefing.tsx',
    'app/ai-assistant/_AIAssistantClient.tsx',
    'app/kuzmich/_KuzmichClient.tsx',
    'components/kuzmich/KuzmichWidget.tsx',
    'lib/ai/rag-context.ts',
    'app/planner/_PlannerClient.tsx',
    'app/api/search/route.ts',
    'components/search/ToursForQuery.tsx',
    'app/fish/[id]/page.tsx',
    'components/tourist/RecommendationCard.tsx',
    'lib/agents/sdk/tourist-tools.ts',
    'lib/planner/compose.ts',
    'lib/notifications/tour-channel-post.ts',
    'lib/kuzmich/engagement.ts',
  ];
  for (const f of PRODUCERS) {
    it(f, () => {
      const src = read(f);
      expect(src).toMatch(/tourPath\(/);
      // Число допустимо только внутри tourPath и как запас IndexNow.
      const bare = [...src.matchAll(/\/catalog\/tours\/\$\{([^}]+)\}/g)].map((m) => m[1]);
      expect(bare.filter((b) => f !== 'lib/seo/indexnow.ts' || b !== 'tourId')).toEqual([]);
    });
  }
});

describe('внутренние ссылки не ведут через /marketplace', () => {
  // /marketplace/tours/{id} → 308 /catalog/tours/{id} → 308 /catalog/tours/{адрес}:
  // два редиректа на каждый клик и обход. Канон — /catalog (next.config).
  it('ни одного /marketplace/tours/${…} в app, components, lib', () => {
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execSync(
      "grep -rnE 'marketplace/tours/\\$\\{' app components lib hooks --include=*.ts --include=*.tsx || true",
      { encoding: 'utf-8' },
    ).trim();
    expect(out).toBe('');
  });

  it('источники ссылок выбирают адрес тура', () => {
    for (const f of [
      'lib/tours/top-tour-by-activity.ts', 'app/_home/data.ts', 'lib/ai/booking-intent.ts',
      'app/api/planner/tours-for-day/route.ts', 'app/fish/[id]/page.tsx', 'lib/search/tour-recommend.ts',
      'lib/agents/sdk/tourist-tools.ts', 'lib/planner/compose.ts', 'lib/notifications/tour-channel-post.ts',
      'lib/kuzmich/engagement.ts',
    ]) {
      expect(read(f), f).toMatch(/\b(?:ot|t)\.slug\b|\bslug,/);
    }
  });
});

describe('адреса раздаются и не расходятся', () => {
  it('миграция 1114: раздача, уникальность, триггер на вставку, без чисто цифровых', () => {
    const sql = read('migrations/1114_tour_slugs.sql');
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS operator_tours_slug_unique\s+ON operator_tours \(slug\)/);
    expect(sql).toMatch(/BEFORE INSERT ON operator_tours/);
    expect(sql).toMatch(/~ '\^\[0-9\]\+\$'/);
  });

  it('короткая форма /tours/{адрес} уводит на карточку', () => {
    expect(read('next.config.js')).toMatch(/source: '\/tours\/:slug',\s+destination: '\/catalog\/tours\/:slug',\s+permanent: true/);
  });

  it('воронка трафика узнаёт тур и по адресу', () => {
    const src = read('app/api/admin/analytics/traffic/route.ts');
    expect(src).toMatch(/OR t\.slug\s+= substring\(pv\.path/);
  });
});
