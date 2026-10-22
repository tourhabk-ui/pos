/** Лимит регистрации не жжёт попытки на ошибках формы и говорит, сколько ждать. */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/database', () => ({ pool: { connect: vi.fn(), query: vi.fn() } }));
vi.mock('@/lib/auth/session-record', () => ({ recordUserSession: vi.fn(), SESSION_TTL_DAYS: 30 }));

import { POST } from '@/app/api/auth/register/route';

const req = (body: unknown) =>
  new NextRequest('http://x/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.7' },
    body: JSON.stringify(body),
  });

describe('лимит регистрации', () => {
  it('20 ошибок валидации подряд — все 400, ни одной 429', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await POST(req({ email: 'flo+x@vedarai.ru', password: 'abc123', name: 'Т', pd_consent: true }));
      expect(res.status).toBe(400);
    }
  });
  it('битый JSON — 400, не 500', async () => {
    const r = new NextRequest('http://x/api/auth/register', { method: 'POST', body: '{' });
    expect((await POST(r)).status).toBe(400);
  });
});
