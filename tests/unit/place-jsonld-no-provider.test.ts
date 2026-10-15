// @vitest-environment node
/**
 * Разметка места и маршрута не объявляет Ведар поставщиком или продавцом
 * (15.10, §0 «честность»).
 *
 * JSON-LD каждой карточки места нёс `provider: TravelAgency «Ведар»` — для
 * поисковика это «Долину гейзеров предоставляет турагентство Ведар». Место
 * никто не предоставляет, и Ведар — не его оператор. Там же `touristType`
 * получал тип места («Вулкан»), а это поле — аудитория. У маршрута — тот же
 * provider, `seller: Ведар` у цены «от» (маршрут продают операторы туров, не
 * Ведар) и точка «Камчатского края» 52.93 / 160.78 — в Тихом океане.
 *
 * Место — вызовом страницы с подставной базой (что уходит в разметку);
 * маршрут — запретом по исходнику: страница собирает разметку из десятка
 * чтений, а утверждение, которого быть не должно, видно в тексте.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement, ReactNode } from 'react';

const ARK = '0f2c8a9e-2222-4c4c-9d9d-000000001510';
vi.mock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), cache: <T,>(fn: T) => fn }));
vi.mock('@/lib/database', () => ({
  query: async (sql: string) => {
    if (sql.includes('SELECT ark_id::text AS ark_id, slug FROM places')) return { rows: [{ ark_id: ARK, slug: 'dolina-gejzerov' }] };
    if (sql.includes('lsp.altitude_m, lsp.difficulty_level')) {
      return { rows: [{ name: 'Долина гейзеров', description: 'Справка.', essence: null, location_type: 'geyser', lat: '54.437', lng: '160.14', photo_url: null, images: [], ark_id: ARK, has_real_photo: false, altitude_m: 450, difficulty_level: null }] };
    }
    return { rows: [] };
  },
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('@/app/places/[id]/_PlaceDetailClient', () => ({ default: () => null }));
vi.mock('@/components/places/PlaceSOS', () => ({ default: () => null }));
vi.mock('@/lib/places/aliases', () => ({ resolveMergedTarget: vi.fn(async () => null) }));
vi.mock('@/lib/places/place-detail', () => ({ loadPlaceDetail: vi.fn(async () => ({ status: 404, body: {} })) }));

/** Все data, переданные компонентам разметки, — обходом дерева элементов. */
function jsonLdData(node: ReactNode): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (n: ReactNode) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    const el = n as ReactElement<{ data?: unknown; children?: ReactNode }>;
    if (el.props?.data && typeof el.props.data === 'object') out.push(el.props.data as Record<string, unknown>);
    walk(el.props?.children);
  };
  walk(node);
  return out;
}

describe('разметка карточки места', () => {
  it('TouristAttraction — без поставщика и без типа места вместо аудитории', async () => {
    const { default: PlaceDetailPage } = await import('@/app/places/[id]/page');
    const page = await PlaceDetailPage({ params: Promise.resolve({ id: 'dolina-gejzerov' }) });
    const attraction = jsonLdData(page).find((d) => d['@type'] === 'TouristAttraction');
    expect(attraction, 'разметка места собрана').toBeDefined();
    expect(attraction!.name).toBe('Долина гейзеров');
    expect(attraction).not.toHaveProperty('provider');
    expect(attraction).not.toHaveProperty('touristType');
    expect(JSON.stringify(attraction)).not.toContain('TravelAgency');
  });
});

describe('разметка карточки маршрута', () => {
  const src = readFileSync(join(process.cwd(), 'app/routes/[id]/page.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('Ведар не объявлен ни поставщиком, ни продавцом', () => {
    expect(src).not.toMatch(/'@type':\s*'TravelAgency'/);
  });

  it('у «Камчатского края» нет точки в океане', () => {
    expect(src).not.toMatch(/160\.7837/);
  });
});
