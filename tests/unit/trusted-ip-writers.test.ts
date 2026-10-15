/**
 * Записанный адрес — доверенным порядком (P3-02 аудита 15.10).
 *
 * Роуты читали адрес руками, X-Forwarded-For ПЕРВЫМ, раньше x-real-ip.
 * Третий из них — запись согласия `/api/agreements/accept` — удалён 15.10
 * (P2-16: его таблиц нет на проде, экрана-вызывающего не было). Остались:
 *   - журнал подборки (`/api/p/[code]/event`) — первый элемент XFF;
 *   - клики партнёрских ссылок (`/api/analytics/affiliate-clicks`) — вся
 *     цепочка, а колонка `ip_addr varchar(45)`, и длинная цепочка роняла
 *     INSERT в 500.
 * Первый элемент XFF пишет сам клиент; x-real-ip ставит прокси. Порядок —
 * `getTrustedClientIp` из lib/rate-limit.ts.
 *
 * Сторож — вызов каждого роута и параметр, ушедший в INSERT.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));
vi.mock('@/lib/auth/middleware', () => ({
  requireAuth: async () => ({ userId: 'user-1', email: 'u@example.ru', role: 'tourist' }),
}));

import { POST as selectionEvent } from '@/app/api/p/[code]/event/route';
import { POST as affiliateClick } from '@/app/api/analytics/affiliate-clicks/route';

const PROXY_IP = '203.0.113.5';          // то, что поставил бы прокси
const CLIENT_CHAIN = '198.51.100.9, 10.0.0.1';  // то, что пишет клиент

function post(url: string, headers: Record<string, string>, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** Параметр под номером idx из первого запроса, содержащего fragment. */
function paramOf(fragment: string, idx: number): unknown {
  const call = queryMock.mock.calls.find(([sql]) => String(sql).includes(fragment));
  expect(call, `запрос «${fragment}» не выполнен`).toBeDefined();
  return (call![1] as unknown[])[idx];
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation((sql: string) => {
    if (sql.includes('FROM tour_selections')) return Promise.resolve({ rows: [{ id: 'sel-1' }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('/api/p/[code]/event: адрес в журнале подборки', () => {
  const url = 'http://localhost/api/p/abc123/event';
  const ctx = () => ({ params: Promise.resolve({ code: 'abc123' }) });

  it('x-real-ip приоритетнее X-Forwarded-For', async () => {
    const res = await selectionEvent(post(url, { 'x-real-ip': PROXY_IP, 'x-forwarded-for': CLIENT_CHAIN }, { event_type: 'open' }), ctx());
    expect(res.status).toBe(204);
    expect(paramOf('INSERT INTO tour_selection_events', 3)).toBe(PROXY_IP);
  });

  it('адреса нет вовсе — null, как и прежде', async () => {
    await selectionEvent(post(url, {}, { event_type: 'open' }), ctx());
    expect(paramOf('INSERT INTO tour_selection_events', 3)).toBeNull();
  });
});

describe('/api/analytics/affiliate-clicks: один адрес, не цепочка', () => {
  const url = 'http://localhost/api/analytics/affiliate-clicks';
  const body = { partner: 'aviasales', source: 'homepage' };

  it('x-real-ip приоритетнее X-Forwarded-For', async () => {
    const res = await affiliateClick(post(url, { 'x-real-ip': PROXY_IP, 'x-forwarded-for': CLIENT_CHAIN }, body));
    expect(res.status).toBe(200);
    expect(paramOf('INSERT INTO affiliate_clicks', 4)).toBe(PROXY_IP);
  });

  it('длинная цепочка XFF — пишется первый адрес и влезает в varchar(45)', async () => {
    const chain = '2001:db8:aaaa:bbbb:cccc:dddd:eeee:1, 2001:db8:aaaa:bbbb:cccc:dddd:eeee:2, 10.0.0.1';
    await affiliateClick(post(url, { 'x-forwarded-for': chain }, body));
    const written = paramOf('INSERT INTO affiliate_clicks', 4);
    expect(written).toBe('2001:db8:aaaa:bbbb:cccc:dddd:eeee:1');
    expect(String(written).length).toBeLessThanOrEqual(45);
  });
});
