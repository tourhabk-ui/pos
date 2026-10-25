// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'GPTBot' }) }));

import { GET } from '@/app/llms-en.txt/route';
import { AGENT_ENTRY_PATHS } from '@/lib/analytics/agent-entry-paths';
import robots from '@/app/robots';

describe('/llms-en.txt', () => {
  it('states canonical identity crisply', async () => {
    const res = await GET();
    expect(res.headers.get('content-language')).toBe('en');
    const body = await res.text();
    for (const s of ['Vedar Kamchatka (vedarai.ru', 'Ведар Камчатка', 'not a travel agency', 'Kamchatka', 'https://vedarai.ru/api/mcp', 'Model Context Protocol', 'no payment through the portal', 'free for tourists']) {
      expect(body).toContain(s);
    }
    expect(body).not.toMatch(/Multi-Channel|Master Channel Partner/);
  });
  it('is counted and allowed by robots', async () => {
    expect([...AGENT_ENTRY_PATHS]).toContain('/llms-en.txt');
    const { rules } = await robots();
    const groups = Array.isArray(rules) ? rules : [rules];
    for (const g of groups) {
      const allow = Array.isArray(g.allow) ? g.allow : [g.allow];
      expect(allow, String(g.userAgent)).toContain('/llms-en.txt');
    }
  });
});
