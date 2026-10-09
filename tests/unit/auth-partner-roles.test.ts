/**
 * verifyAuth узнаёт владельца жилья и прокат (решение владельца 09.10, #2325).
 *
 * До этого роли 'stay' и 'gear' были в базе, но не в BASE_ROLES: verifyAuth
 * отвечал «не вошёл» любому их токену. Роуты, которые зовут verifyAuth, —
 * SOS, регистрация выхода, обновление токена, второй фактор — видели
 * анонима. Здесь держится и обратное: незнакомая роль по-прежнему аноним, а
 * распознанная роль не становится чужой (rolesMatch — точное совпадение).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const verifyToken = vi.fn();
const isSessionActive = vi.fn();
vi.mock('@/lib/auth/jwt', () => ({
  extractToken: (h: string | null) => (h?.startsWith('Bearer ') ? h.slice(7) : null),
  verifyToken: (...a: unknown[]) => verifyToken(...a),
  isSessionActive: (...a: unknown[]) => isSessionActive(...a),
}));
vi.mock('@/lib/database', () => ({ query: vi.fn() }));

const { verifyAuth, authorizeRole } = await import('@/lib/auth');

const req = () => new NextRequest('http://localhost/api/safety/sos', { headers: { authorization: 'Bearer t' } });

beforeEach(() => {
  verifyToken.mockReset();
  isSessionActive.mockReset().mockResolvedValue(true);
});

describe('владелец жилья и прокат — вошедшие, а не анонимы', () => {
  for (const role of ['stay', 'gear'] as const) {
    it(`токен роли ${role} распознаётся`, async () => {
      verifyToken.mockResolvedValue({ userId: 'u-1', role, email: 'host@example.com' });
      expect(await verifyAuth(req())).toEqual({
        userId: 'u-1', role, email: 'host@example.com', isAuthenticated: true,
      });
      expect(await authorizeRole(req(), role)).toBe(true);
    });
  }

  it('распознанная роль не становится чужой', async () => {
    verifyToken.mockResolvedValue({ userId: 'u-1', role: 'stay', email: null });
    expect(await authorizeRole(req(), ['operator', 'admin', 'tourist'])).toBe(false);
  });

  it('незнакомая роль — по-прежнему аноним', async () => {
    verifyToken.mockResolvedValue({ userId: 'u-1', role: 'superuser', email: null });
    expect(await verifyAuth(req())).toMatchObject({ isAuthenticated: false, userId: null, role: null });
  });

  it('отозванная сессия — аноним при любой роли', async () => {
    verifyToken.mockResolvedValue({ userId: 'u-1', role: 'gear', email: null });
    isSessionActive.mockResolvedValue(false);
    expect(await verifyAuth(req())).toMatchObject({ isAuthenticated: false });
  });
});
