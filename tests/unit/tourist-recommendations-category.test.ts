/**
 * tests/unit/tourist-recommendations-category.test.ts
 *
 * GET /api/tourist/recommendations — необязательный ?category= (PR6,
 * «Режим похода»). Контракт: без category — кэш проверяется как раньше;
 * с валидным category — кэш обходится (не читается и не перезаписывается),
 * getRecommendations вызывается с этим category; невалидное значение
 * (не из белого списка) трактуется как отсутствие фильтра.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const getRecommendationsMock = vi.fn();
const getCachedRecommendationsMock = vi.fn();
const saveRecommendationsCacheMock = vi.fn();
vi.mock('@/lib/search/tour-recommend', () => ({
  getRecommendations: (...args: unknown[]) => getRecommendationsMock(...args),
  getCachedRecommendations: (...args: unknown[]) => getCachedRecommendationsMock(...args),
  saveRecommendationsCache: (...args: unknown[]) => saveRecommendationsCacheMock(...args),
}));

vi.mock('@/lib/auth/middleware', () => ({
  requireRole: vi.fn().mockResolvedValue({ userId: 'user-1', role: 'tourist' }),
}));

import { GET } from '@/app/api/tourist/recommendations/route';

function getReq(query: string): NextRequest {
  const url = `http://localhost/api/tourist/recommendations${query}`;
  const req = new Request(url);
  // route.ts reads request.nextUrl.searchParams — a NextRequest-only property
  // not present on plain Request, so it's polyfilled for the test.
  (req as unknown as { nextUrl: URL }).nextUrl = new URL(url);
  return req as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCachedRecommendationsMock.mockResolvedValue(null);
  getRecommendationsMock.mockResolvedValue([]);
});

describe('GET /api/tourist/recommendations — category (PR6)', () => {
  it('без category → кэш проверяется, getRecommendations вызван с undefined', async () => {
    await GET(getReq('?limit=3'));
    expect(getCachedRecommendationsMock).toHaveBeenCalledWith('user-1');
    expect(getRecommendationsMock).toHaveBeenCalledWith('user-1', 3, undefined);
    expect(saveRecommendationsCacheMock).toHaveBeenCalled();
  });

  it('валидный category=bears → кэш обходится (не читается, не сохраняется)', async () => {
    const res = await GET(getReq('?limit=3&category=bears'));
    const json = await res.json();

    expect(getCachedRecommendationsMock).not.toHaveBeenCalled();
    expect(getRecommendationsMock).toHaveBeenCalledWith('user-1', 3, 'bears');
    expect(saveRecommendationsCacheMock).not.toHaveBeenCalled();
    expect(json.meta.category).toBe('bears');
  });

  it('невалидный category (не из белого списка) → трактуется как отсутствие фильтра', async () => {
    await GET(getReq('?limit=3&category=not-a-real-category'));
    expect(getCachedRecommendationsMock).toHaveBeenCalledWith('user-1');
    expect(getRecommendationsMock).toHaveBeenCalledWith('user-1', 3, undefined);
  });
});
