/**
 * Публичный MCP открыт для индекса, приватное /api — нет; корневой
 * /.well-known/oauth-protected-resource отвечает 200 и не объявляет OAuth
 * для публичного /api/mcp.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { GET as rootPrm } from '@/app/.well-known/oauth-protected-resource/route';

const ROOT = process.cwd();
const req = createRequire(join(ROOT, 'package.json'));
type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match');
const { modifyRouteRegex } = req('next/dist/lib/redirect-status');

async function robots(path: string): Promise<string | null> {
  const rules: HeaderRule[] = await req(join(ROOT, 'next.config.js')).headers();
  let v: string | null = null;
  for (const rule of rules) {
    const m = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r: string) => modifyRouteRegex(r) });
    if (m(path) === false) continue;
    for (const h of rule.headers) if (h.key.toLowerCase() === 'x-robots-tag') v = h.value;
  }
  return v;
}

describe('X-Robots-Tag на /api', () => {
  it('публичный MCP без noindex', async () => {
    for (const p of ['/api/mcp', '/api/mcp/server-card', '/llms.txt', '/robots.txt', '/sitemap.xml', '/.well-known/oauth-protected-resource', '/.well-known/mcp.json']) {
      expect(await robots(p), p).toBeNull();
    }
  });
  it('приватное /api по-прежнему noindex', async () => {
    for (const p of ['/api/mcp/partner', '/api/mcpx', '/api/mcp-admin', '/api/admin/users', '/api/auth/login', '/api/crm/x', '/hub/admin']) {
      expect(await robots(p), p).toMatch(/noindex/);
    }
  });
});

describe('корневой oauth-protected-resource', () => {
  it('200 JSON, resource = хост, без authorization_servers', async () => {
    const res = rootPrm();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe('https://vedarai.ru');
    expect(body.authorization_servers).toBeUndefined();
  });
});
