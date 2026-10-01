/**
 * Гость не получает 401 там, где его ни о чём не спрашивали (аудит 01.10).
 *
 * У гостя главная и каталог отдавали в консоль красные ответы подряд:
 * /api/auth/me — общий AuthContext на каждой странице, /api/trips/active,
 * /api/referral/my-code, /api/tourist/wishlist. Гость — не ошибка; его данные
 * спрашиваются только после ответа «вошёл» из /api/auth/state (200 с флагом),
 * одним запросом на экран — lib/auth/session-state.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const code = (p: string) =>
  readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('данные пользователя — только после «вошёл»', () => {
  it('AuthContext спрашивает /api/auth/me по cookie только при true', () => {
    const src = code('contexts/AuthContext.tsx');
    const at = src.indexOf('const loadUserFromCookie');
    const body = src.slice(at, at + 400);
    expect(body).toMatch(/if \(\(await sessionState\(\)\) !== true\) return;\s*const response = await fetch\('\/api\/auth\/me'\)/);
  });

  it('вход и выход сбрасывают сохранённый ответ', () => {
    const src = code('contexts/AuthContext.tsx');
    expect(src.match(/resetSessionState\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  const GATED: Array<[string, string]> = [
    ['app/_home/_HomeV8Client.tsx', '/api/trips/active'],
    ['hooks/useMyReferralCode.ts', '/api/referral/my-code'],
    ['components/marketplace/MarketplaceClient.tsx', '/api/tourist/wishlist?type=tour'],
    ['app/marketplace/tours/[id]/_TourDetailClient.tsx', '/api/tourist/wishlist?type=tour'],
    ['app/accommodations/_AccommodationsClient.tsx', '/api/tourist/wishlist?type=accommodation'],
  ];
  for (const [file, url] of GATED) {
    it(`${file}: ${url} — только при authed === true`, () => {
      const src = code(file);
      const esc = url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      expect(src).toMatch(new RegExp(`authed === true\\s*\\?\\s*fetch\\('${esc}'`));
    });
  }
});

describe('sessionState: один запрос, три исхода', () => {
  const fetchMock = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const ok = (authenticated: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: { authenticated } }) });

  it('гость — false, вошедший — true, повтор в пределах минуты — без запроса', async () => {
    const { sessionState, resetSessionState } = await import('@/lib/auth/session-state');
    fetchMock.mockImplementationOnce(() => ok(false));
    expect(await sessionState()).toBe(false);
    expect(await sessionState()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/state');

    resetSessionState();
    fetchMock.mockImplementationOnce(() => ok(true));
    expect(await sessionState()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('не смогли спросить — null, а не «гость»', async () => {
    const { sessionState } = await import('@/lib/auth/session-state');
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    expect(await sessionState()).toBeNull();
  });

  it('«не смогли спросить» не запоминается — следующий вопрос уходит заново', async () => {
    const { sessionState } = await import('@/lib/auth/session-state');
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    expect(await sessionState()).toBeNull();
    fetchMock.mockImplementationOnce(() => ok(true));
    expect(await sessionState()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('500 или битый ответ — null', async () => {
    const { sessionState, resetSessionState } = await import('@/lib/auth/session-state');
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    expect(await sessionState()).toBeNull();
    resetSessionState();
    fetchMock.mockImplementationOnce(() => ok('yes'));
    expect(await sessionState()).toBeNull();
  });
});
