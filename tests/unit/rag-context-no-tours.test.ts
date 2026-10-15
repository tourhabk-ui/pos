/**
 * `buildRAGContext(..., { tours: false })` — маршруты и места платформы без её
 * туров. Нужен чату виджета на сайте партнёра: туры там — только партнёра
 * (lib/embed/widget-chat), а подбор по всей платформе ставил туры конкурентов
 * на его витрину (аудит 15.10, WID-safety). Вызовом, с моками базы и подбора.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery, findRelevantTours } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  findRelevantTours: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: vi.fn(async () => []) }));
vi.mock('@/lib/ai/booking-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/booking-intent')>()),
  findRelevantTours,
}));

import { buildRAGContext } from '@/lib/ai/rag-context';

const ROUTE = { title: 'Авачинский вулкан', description: 'Домашний вулкан', category: 'volcano', lat: 53.25, lng: 158.83 };
const TOUR = {
  id: 7, slug: 'chuzhoy-tur', title: 'Тур чужого оператора', description: null, base_price: 15000,
  price_unit: 'person', multi_day_count: null, duration_hours: 8, activity_type: 'volcano',
  location_type: null, location: null, tour_image: null, operator_name: 'Конкурент',
  operator_slug: null, operator_public: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  poolQuery.mockImplementation(async (sql: string) => (/ts_rank/.test(sql) ? { rows: [ROUTE] } : { rows: [] }));
  findRelevantTours.mockResolvedValue([TOUR]);
});

describe('контекст без туров платформы', () => {
  it('tours: false — подбор туров не зовётся, маршруты остаются', async () => {
    const ctx = await buildRAGContext('хочу тур на вулкан Авачинский без туров', 'tourist', undefined, { tours: false });
    expect(findRelevantTours).not.toHaveBeenCalled();
    expect(ctx).toContain('Авачинский вулкан');
    expect(ctx).not.toContain('Тур чужого оператора');
  });

  it('по умолчанию — как прежде: туры платформы в контексте', async () => {
    const ctx = await buildRAGContext('хочу тур на вулкан Авачинский с турами', 'tourist');
    expect(findRelevantTours).toHaveBeenCalled();
    expect(ctx).toContain('Тур чужого оператора');
  });

  it('кэш различает ответ с турами и без: один вопрос, два контекста', async () => {
    const q = 'хочу тур на вулкан Авачинский один вопрос';
    const withTours = await buildRAGContext(q, 'tourist');
    const without = await buildRAGContext(q, 'tourist', undefined, { tours: false });
    expect(withTours).toContain('Тур чужого оператора');
    expect(without).not.toContain('Тур чужого оператора');
  });
});
