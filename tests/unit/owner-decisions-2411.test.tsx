/**
 * Решения владельца 24.11 на экранах и в форме администратора:
 *   «До апреля 2027 комиссии нет.»
 *   «Самозанятые могут быть стороной оферты.»
 *
 * Регистрацию партнёра и чек-лист судят tests/unit/partners-register.test.ts
 * и tests/unit/partner-readiness.test.tsx. Здесь — справка оператора рендером
 * и дверь, которой партнёра заводит администратор, вызовом.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { NextRequest } from 'next/server';

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({
  pool: { connect: async () => ({ query: db.query, release: () => undefined }) },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAdmin: vi.fn(async () => ({ userId: 'c9000000-0000-4000-8000-0000000002ad', role: 'admin' })),
}));
vi.mock('@/lib/auth/password', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/password')>()),
  hashPassword: vi.fn(async () => '$hash$'),
}));

import OperatorHelpClient from '@/app/hub/operator/help/_OperatorHelpClient';
import { POST as createPartner } from '@/app/api/admin/operators/create/route';
import { OWNER_DECISIONS } from '@/lib/legal/offer';
import { PLATFORM_ACCEPTS_PAYMENTS } from '@/lib/payments/accepting';

afterEach(cleanup);

describe('справка оператора', () => {
  it('о комиссии сказано словами владельца: до апреля 2027 года её нет', () => {
    // Сторож проверяет режим, в котором живёт прод: приём оплаты выключен.
    expect(PLATFORM_ACCEPTS_PAYMENTS).toBe(false);
    render(<OperatorHelpClient />);
    expect(screen.getByText('До апреля 2027 года комиссии нет.')).toBeTruthy();
    expect(screen.getByText('Ведар сейчас платежи не принимает и комиссию не берёт')).toBeTruthy();
    // Ставки и «первого месяца» в справке нет.
    expect(document.body.textContent).not.toMatch(/комисси[яию]\s+\d+\s*%|\d+\s*%\s+комисси|первый месяц/i);
    expect(OWNER_DECISIONS.noCommission).toBe('До апреля 2027 года комиссии нет.');
  });
});

describe('администратор заводит партнёра', () => {
  const BODY = {
    name: 'Тест Тестов', categories: ['guide'], contactName: 'Тест', phone: '+70000000000',
    email: 'self-employed@example.test', description: '',
  };
  const create = async (body: unknown) => {
    const res = await createPartner(new NextRequest('http://localhost/api/admin/operators/create', {
      method: 'POST', body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as { success?: boolean; error?: string } };
  };
  beforeEach(() => {
    db.query.mockReset();
    // База отвечает отказом сразу после разбора тела: до неё доходит только то,
    // что схема приняла. Так «форма принята» отличима от «форма отвергнута».
    db.query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw Object.assign(new Error('проверка дошла до базы'), { code: '57P01' });
    });
  });

  it('самозанятый — допустимая правовая форма: до базы дело доходит', async () => {
    const res = await create({ ...BODY, businessType: 'self_employed' });
    expect(res.status).not.toBe(400);
    expect(db.query.mock.calls.map((c) => c[0])).toContain('BEGIN');
  });

  it('прежние формы приняты, незнакомая отвергнута до базы', async () => {
    for (const businessType of ['individual', 'ip', 'ooo', 'other']) {
      db.query.mockClear();
      expect((await create({ ...BODY, businessType })).status, businessType).not.toBe(400);
      expect(db.query.mock.calls.map((c) => c[0]), businessType).toContain('BEGIN');
    }
    db.query.mockClear();
    expect((await create({ ...BODY, businessType: 'кооператив' })).status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});
