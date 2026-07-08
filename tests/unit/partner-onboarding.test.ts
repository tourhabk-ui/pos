/**
 * tests/unit/partner-onboarding.test.ts
 *
 * Онбординг партнёров gear/stay:
 * - PATCH /api/partners/profile: только партнёрские роли, merge contact
 *   (jsonb) без затирания, complete_onboarding ставит onboarding_completed;
 * - GET /api/partners/profile: отсутствующий профиль создаётся
 *   автоматически (ensurePartnerForRole) — закрывает legacy-аккаунты stay;
 * - POST /api/stay/accommodations (owner-create): чужая роль → 403,
 *   Zod-отказ, создание с is_verified=false и partner_id владельца.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const requireAuthMock = vi.fn();
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

const ensurePartnerMock = vi.fn();
vi.mock('@/lib/auth/partner-profile', () => ({
  ensurePartnerForRole: (...args: unknown[]) => ensurePartnerMock(...args),
}));

const getStayPartnerIdMock = vi.fn();
vi.mock('@/lib/auth/stay-helpers', () => ({
  getStayPartnerId: (...args: unknown[]) => getStayPartnerIdMock(...args),
  verifyAccommodationOwnership: vi.fn(),
  requireAccommodationAccess: vi.fn(),
}));

import { GET as getProfile, PATCH as patchProfile } from '@/app/api/partners/profile/route';
import { POST as postAccommodation } from '@/app/api/stay/accommodations/route';

const PARTNER_ROW = {
  id: 'partner-1',
  name: 'Прокат',
  category: 'gear',
  description: null,
  short_description: null,
  contact: { email: 'x@x.ru', phone: '+79000000000' },
  profile_status: 'none',
  onboarding_completed: false,
  is_verified: false,
};

function jsonReq(url: string, method: string, body?: unknown): NextRequest {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }) as unknown as NextRequest;
}

beforeEach(() => {
  queryMock.mockReset();
  requireAuthMock.mockReset();
  ensurePartnerMock.mockReset();
  getStayPartnerIdMock.mockReset();
  requireAuthMock.mockResolvedValue({ userId: 'user-1', email: 'x@x.ru', role: 'gear' });
});

describe('GET /api/partners/profile', () => {
  it('непартнёрская роль → 403', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'tourist' });
    const res = await getProfile(jsonReq('http://localhost/api/partners/profile', 'GET'));
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('отсутствующий профиль создаётся автоматически', async () => {
    let created = false;
    queryMock.mockImplementation(() =>
      Promise.resolve({ rows: created ? [PARTNER_ROW] : [] })
    );
    ensurePartnerMock.mockImplementation(() => {
      created = true;
      return Promise.resolve('partner-1');
    });

    const res = await getProfile(jsonReq('http://localhost/api/partners/profile', 'GET'));
    expect(res.status).toBe(200);
    expect(ensurePartnerMock).toHaveBeenCalledWith('user-1', 'gear');
    const body = await res.json();
    expect(body.data.partner.id).toBe('partner-1');
  });
});

describe('PATCH /api/partners/profile', () => {
  it('merge contact: телефон обновлён, email из contact сохранён', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, name')) return Promise.resolve({ rows: [PARTNER_ROW] });
      if (sql.includes('UPDATE partners')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchProfile(jsonReq('http://localhost/api/partners/profile', 'PATCH', {
      phone: '+79111111111',
    }));
    expect(res.status).toBe(200);

    const update = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE partners'))!;
    const contactParam = (update[1] as unknown[]).find(
      p => typeof p === 'string' && p.includes('email')
    ) as string;
    const contact = JSON.parse(contactParam);
    expect(contact.email).toBe('x@x.ru');
    expect(contact.phone).toBe('+79111111111');
  });

  it('complete_onboarding ставит onboarding_completed', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, name')) return Promise.resolve({ rows: [PARTNER_ROW] });
      if (sql.includes('UPDATE partners')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchProfile(jsonReq('http://localhost/api/partners/profile', 'PATCH', {
      complete_onboarding: true,
    }));
    expect(res.status).toBe(200);

    const update = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE partners'))!;
    expect(String(update[0])).toContain('onboarding_completed');
  });

  it('непартнёрская роль → 403 без записи', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'user' });
    const res = await patchProfile(jsonReq('http://localhost/api/partners/profile', 'PATCH', { phone: '1' }));
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('оператор → 403 (у него свой API с другой колонкой contacts)', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'operator' });
    const res = await patchProfile(jsonReq('http://localhost/api/partners/profile', 'PATCH', { phone: '1' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('hub/operator/profile');
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('пустая строка очищает ключ contact, а не копится', async () => {
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, name')) return Promise.resolve({ rows: [PARTNER_ROW] });
      if (sql.includes('UPDATE partners')) return Promise.resolve({ rows: [] });
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await patchProfile(jsonReq('http://localhost/api/partners/profile', 'PATCH', {
      phone: '',
    }));
    expect(res.status).toBe(200);

    const update = queryMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE partners'))!;
    const contactParam = (update[1] as unknown[]).find(
      p => typeof p === 'string' && p.includes('email')
    ) as string;
    const contact = JSON.parse(contactParam);
    expect(contact.email).toBe('x@x.ru');
    expect('phone' in contact).toBe(false);
  });
});

describe('POST /api/stay/accommodations — owner-create', () => {
  const VALID_BODY = {
    name: 'Гостевой дом',
    type: 'guesthouse',
    description: 'Уютный дом у термальных источников',
    address: 'Паратунка, ул. Термальная, 1',
    coordinates: { lat: 52.96, lng: 158.25 },
    totalRooms: 3,
    pricePerNightFrom: 5000,
  };

  it('роль gear → 403', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'gear' });
    const res = await postAccommodation(jsonReq('http://localhost/api/stay/accommodations', 'POST', VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('создание: partner_id владельца, is_verified=false', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'stay' });
    getStayPartnerIdMock.mockResolvedValue('partner-stay-1');
    queryMock.mockResolvedValue({ rows: [{ id: 'acc-1' }] });

    const res = await postAccommodation(jsonReq('http://localhost/api/stay/accommodations', 'POST', VALID_BODY));
    expect(res.status).toBe(201);

    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO accommodations');
    expect(String(sql)).toContain('true, false'); // is_active, is_verified
    expect(params).toContain('partner-stay-1');
  });

  it('без stay-профиля профиль создаётся через ensurePartnerForRole', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'stay' });
    getStayPartnerIdMock.mockResolvedValue(null);
    ensurePartnerMock.mockResolvedValue('partner-new');
    queryMock.mockResolvedValue({ rows: [{ id: 'acc-2' }] });

    const res = await postAccommodation(jsonReq('http://localhost/api/stay/accommodations', 'POST', VALID_BODY));
    expect(res.status).toBe(201);
    expect(ensurePartnerMock).toHaveBeenCalledWith('user-1', 'stay');
  });

  it('Zod-отказ: короткое название → 400, INSERT не выполняется', async () => {
    requireAuthMock.mockResolvedValue({ userId: 'user-1', role: 'stay' });
    const res = await postAccommodation(jsonReq('http://localhost/api/stay/accommodations', 'POST', {
      ...VALID_BODY, name: 'ab',
    }));
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
