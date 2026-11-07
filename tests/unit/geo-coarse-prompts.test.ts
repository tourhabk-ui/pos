/**
 * Точка человека в промпте зарубежной модели — до километра (ревью
 * безопасности 07.11, PR #3104, находки 1 и 2): геопозиция — персональные
 * данные (152-ФЗ, docs/LEGAL.md). Контекст Кузьмича отдавал её до 11 м с
 * точностью GPS и расстояния до мест в метрах, по которым точка
 * восстанавливается. Вызовом, с моками базы и подбора; чат-спасатель — в
 * tests/unit/rescue-chat-fallback.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));

vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));
vi.mock('@/lib/ai/embeddings', () => ({ semanticSearch: vi.fn(async () => []) }));
vi.mock('@/lib/ai/booking-intent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/booking-intent')>()),
  findRelevantTours: vi.fn(async () => []),
}));

import { buildGeoContext, buildRAGContext } from '@/lib/ai/rag-context';
import { approxDistanceText, coarseCoordsInText, coarseDegrees, coarseLocation, coarsePointText, distanceKm, COARSE_COORDS_NOTE } from '@/lib/geo/kamchatka';

/** Человек у подножия Авачинского: точка до сантиметра, GPS ±7 м. */
const HERE = { lat: 53.2391234, lng: 158.7712345, accuracy: 7, timestamp: 0 };
/**
 * Места в 300 м и в 5,5 км от него. Дальнее выбрано так, что от точной точки
 * выходит «около 5 км», а от огрублённой — «около 6 км»: по тексту видно, от
 * какой точки считали.
 */
const NEAR = { title: 'Верблюд', category: 'mountain', lat: 53.2418, lng: 158.7735, description: null };
const FAR = { title: 'Авачинский вулкан', category: 'volcano', lat: 53.255, lng: 158.849, description: 'Домашний вулкан' };

/** Точная точка или её следы: пять знаков, метры, точность GPS. */
const PRECISE = /53\.239|158\.771|\d+\s?м\b|±\s?\d/;

beforeEach(() => {
  vi.clearAllMocks();
  poolQuery.mockImplementation(async (sql: string) => {
    if (/ts_rank/.test(sql)) return { rows: [FAR] };
    if (/FROM agent_route_knowledge/.test(sql)) return { rows: [NEAR, FAR] };
    return { rows: [] };
  });
});

describe('правило огрубления — одно', () => {
  it('сотые градуса, текст и расстояние без ложной точности', () => {
    expect(coarseDegrees(53.2391234)).toBe(53.24);
    expect(coarsePointText(53.2391234, 158.7712345)).toBe('53.24, 158.77 (около 1 км)');
    expect(coarseLocation(HERE)).toEqual({ lat: 53.24, lng: 158.77, accuracy: 1000, timestamp: 0 });
    expect(approxDistanceText(0.3)).toBe('ближе 2 км');
    expect(approxDistanceText(12.4)).toBe('около 12 км');
  });
});

describe('координаты в тексте человека — до километра (ревью PR #3127)', () => {
  const N = ` ${COARSE_COORDS_NOTE}`;
  it('десятичные градусы через точку и запятую, со знаком и без пробела', () => {
    expect(coarseCoordsInText('я на 53.23912, 158.77123')).toBe(`я на 53.24, 158.77${N}`);
    expect(coarseCoordsInText('53.23912,158.77123')).toBe(`53.24,158.77${N}`);
    expect(coarseCoordsInText('N53,239123 E158,771234')).toBe(`N53.24 E158.77${N}`);
    expect(coarseCoordsInText('-170.12345')).toBe(`-170.12${N}`);
    expect(coarseCoordsInText('53.239°')).toBe(`53.24°${N}`);
  });

  it('градусы-минуты-секунды и дробные минуты — до минут', () => {
    expect(coarseCoordsInText(`53°14'20.8" с.ш. 158°46'16" в.д.`)).toBe(`53°14′ с.ш. 158°46′ в.д.${N}`);
    expect(coarseCoordsInText('53° 14.347′, 158° 46.27′')).toBe(`53°14′, 158°46′${N}`);
  });

  it('цены, даты, расстояния и уже огрублённое не трогает', () => {
    for (const t of ['тур 150,000 ₽', 'с 10.07.2026 по 17.07.2026', 'идти 1.5 км, высота 2741 м',
      'бюджет 150 000 - 200 000', 'точка 53.24, 158.77', 'версия 10.123.4', 'заряд 15.000 мАч',
      // Хвост длинного числа — не градус: «100.123» в адресе, «153.2391» в «1153.2391».
      'сервер 192.168.100.123', 'отметка 1153.2391']) {
      expect(coarseCoordsInText(t), t).toBe(t);
    }
  });
});

describe('контекст Кузьмича: точка человека — до километра', () => {
  it('местоположение: координаты до сотых, без точности GPS и метров до мест', async () => {
    const geo = await buildGeoContext(HERE);
    expect(geo).toContain('Координаты: 53.24, 158.77 (около 1 км)');
    expect(geo).toContain('Верблюд');
    expect(geo).toContain('ближе 2 км');
    expect(geo).not.toMatch(PRECISE);
    // Ближайшие места ищутся от огрублённой точки: точная в базу тоже не нужна.
    const nearbyCall = poolQuery.mock.calls.find(([sql]) => /FROM agent_route_knowledge/.test(String(sql)));
    expect(nearbyCall?.[1]).toEqual([53.24, 158.77]);
  });

  it('маршруты «от тебя» — километрами от огрублённой точки', async () => {
    expect(approxDistanceText(distanceKm(HERE, FAR))).toBe('около 5 км');
    const ctx = await buildRAGContext('как подняться на Авачинский вулкан', 'tourist', HERE);
    expect(ctx).toContain('Авачинский вулкан [volcano] — Домашний вулкан (около 6 км от тебя)');
    expect(ctx).not.toMatch(PRECISE);
  });

  it('кэш делит контекст только внутри той же огрублённой точки', async () => {
    const q = 'как подняться на Авачинский вулкан из кэша';
    await buildRAGContext(q, 'tourist', HERE);
    const calls = poolQuery.mock.calls.length;
    // В той же клетке в километр — из кэша.
    await buildRAGContext(q, 'tourist', { ...HERE, lat: 53.2412 });
    expect(poolQuery.mock.calls.length).toBe(calls);
    // В 2,7 км, в той же десятой градуса — свой контекст, а не расстояния от чужой точки.
    await buildRAGContext(q, 'tourist', { ...HERE, lat: 53.2151 });
    expect(poolQuery.mock.calls.length).toBeGreaterThan(calls);
  });
});
