/**
 * Ссылка «Продолжить в Ведаре»: отказ базы — не «ссылка устарела» (проверка
 * MCP 29.09, §4.0).
 *
 * redeemMcpHandoff глушил исключение в null, и переход отвечал человеку 410
 * «Ссылка устарела» — рабочая ссылка выглядела мёртвой, а в логе не
 * оставалось ничего. Теперь отказ базы — 503 с повтором и строкой в логе,
 * истёкшая или чужая ссылка — по-прежнему 410.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import { GET } from '@/app/mcp/h/[token]/route';

const TOKEN = 'A'.repeat(43);
const open = () => GET(new NextRequest(`http://localhost/mcp/h/${TOKEN}`), { params: Promise.resolve({ token: TOKEN }) });

describe('переход по ссылке из ответа MCP', () => {
  it('база не ответила — 503 и лог, а не «устарела»', async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    query.mockImplementation(async () => { throw Object.assign(new Error('connection terminated'), { code: '57P01' }); });
    const res = await open();
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(logged.some((l) => l.includes('sqlstate=57P01'))).toBe(true);
  });

  it('ссылки нет или срок вышел — 410, как прежде', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    const res = await open();
    expect(res.status).toBe(410);
  });
});
