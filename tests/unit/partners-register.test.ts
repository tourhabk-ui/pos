// @vitest-environment node
// (jose подписывает JWT через WebCrypto, которого нет в jsdom)
/**
 * tests/unit/partners-register.test.ts
 *
 * POST /api/partners/register (юр. форма 152-ФЗ) перестал быть сиротой:
 * - создаёт users-аккаунт и partners с user_id в одной транзакции;
 * - пароль — через единый lib/auth/password, не самодельный SHA-256;
 * - дубль email в users → 409; дубль ИНН в partners → 409;
 * - выдаёт JWT-cookie; статус профиля — pending (модерация).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

const clientQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: {
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => clientQueryMock(...args),
      release: () => undefined,
    }),
  },
}));

const auditQueryMock = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => auditQueryMock(...args),
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: () => ({ check: () => true }),
  getClientIp: () => '10.0.0.1',
}));

const hashPasswordMock = vi.fn().mockResolvedValue('$platform-hash$');
vi.mock('@/lib/auth/password', () => ({
  hashPassword: (...args: unknown[]) => hashPasswordMock(...args),
}));

process.env.JWT_SECRET = 'test-secret-partners-register';

import { POST } from '@/app/api/partners/register/route';

const VALID_BODY = {
  businessType: 'ip',
  companyName: 'ООО «Камчатка Гир»',
  inn: '4101123456',
  legalAddress: 'г. Петропавловск-Камчатский, ул. Ленина, 1',
  contactPerson: 'Иван Петров',
  email: 'partner@x.ru',
  phone: '+79990001122',
  bankName: 'Сбербанк',
  bik: '044525225',
  correspondentAccount: '30101810400000000225',
  checkingAccount: '40702810900000012345',
  roles: ['gear', 'stay'],
  agreePersonalData: true,
  agreeUserAgreement: true,
  agreeOffer: true,
  agreeCommission: true,
  password: 'secret-password',
  confirmPassword: 'secret-password',
};

function registerReq(body: Record<string, unknown>): NextRequest {
  return new Request('http://localhost/api/partners/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function mockDb(opts: { userExists?: boolean; partnerExists?: boolean } = {}) {
  clientQueryMock.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
    if (sql.includes('SELECT id FROM users')) {
      return Promise.resolve({ rows: opts.userExists ? [{ id: 'u-old' }] : [] });
    }
    if (sql.includes('SELECT id FROM partners')) {
      return Promise.resolve({ rows: opts.partnerExists ? [{ id: 'p-old' }] : [] });
    }
    if (sql.includes('INSERT INTO users')) {
      return Promise.resolve({ rows: [{ id: 'user-1', email: 'partner@x.ru', name: 'Иван Петров', role: 'gear' }] });
    }
    if (sql.includes('INSERT INTO partners')) {
      return Promise.resolve({ rows: [{ id: 'partner-1' }] });
    }
    throw new Error('unexpected SQL: ' + sql);
  });
}

beforeEach(() => {
  clientQueryMock.mockReset();
  auditQueryMock.mockClear();
  hashPasswordMock.mockClear();
  mockDb();
});

describe('POST /api/partners/register', () => {
  it('создаёт users и partners с user_id в транзакции, кладёт JWT в cookie', async () => {
    const res = await POST(registerReq(VALID_BODY));
    expect(res.status).toBe(201);

    // Пароль — единым методом платформы
    expect(hashPasswordMock).toHaveBeenCalledWith('secret-password');

    // users: главная роль — первая из выбранных
    const userInsert = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'))!;
    expect((userInsert[1] as unknown[])[3]).toBe('gear');

    // partners: привязка user_id + статус модерации pending
    const partnerInsert = clientQueryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO partners'))!;
    expect((partnerInsert[1] as unknown[])[0]).toBe('user-1');
    expect(String(partnerInsert[0])).toContain(`'pending'`);
    expect(String(partnerInsert[0])).not.toContain('password_hash');

    // Транзакция и cookie
    const sqlCalls = clientQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(sqlCalls).toContain('BEGIN');
    expect(sqlCalls).toContain('COMMIT');
    expect(res.headers.get('set-cookie')).toContain('auth_token=');

    const body = await res.json() as { data: { partnerId: string; userId: string; status: string } };
    expect(body.data.userId).toBe('user-1');
    expect(body.data.status).toBe('pending');
  });

  it('дубль email в users → 409, без INSERT', async () => {
    mockDb({ userExists: true });

    const res = await POST(registerReq(VALID_BODY));
    expect(res.status).toBe(409);

    const inserts = clientQueryMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT'));
    expect(inserts).toHaveLength(0);
  });

  it('дубль ИНН/email в partners → 409', async () => {
    mockDb({ partnerExists: true });

    const res = await POST(registerReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('без обязательного согласия → 400', async () => {
    const res = await POST(registerReq({ ...VALID_BODY, agreeOffer: false }));
    expect(res.status).toBe(400);
  });

  it('несовпадающие пароли → 400', async () => {
    const res = await POST(registerReq({ ...VALID_BODY, confirmPassword: 'other' }));
    expect(res.status).toBe(400);
  });
});
