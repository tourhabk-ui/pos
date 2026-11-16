/**
 * /.well-known/poppy.json — документ обнаружения Poppy 1.0 (#3459).
 *
 * Сверено с разделом 3.1 спецификации
 * (https://personalagentprotocol.org/docs/1.0/spec): обязательные
 * `protocol_version` и `organization` (`name`, `domain` = хост, отдающий
 * документ), хотя бы одно из `agent`/`apis`/`web`; пункт `apis` — `type`,
 * `url`, `description`; тип `mcp` (раздел 7). Полей сверх 3.1 нет, и нет
 * того, чего у Ведара нет (auth, agent, web, tasks). Вызовом роута.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

vi.mock('@/lib/analytics/agent-entry-hits', () => ({ recordAgentEntryHit: vi.fn() }));

import { GET, OPTIONS } from '@/app/.well-known/poppy.json/route';
import { GET as mcpManifest } from '@/app/.well-known/mcp.json/route';
import { buildPoppyDocument, POPPY_PATH } from '@/lib/mcp/poppy';
import { recordAgentEntryHit } from '@/lib/analytics/agent-entry-hits';
import { AGENT_ENTRY_PATHS } from '@/lib/analytics/agent-entry-paths';

const SPEC_TOP_LEVEL = ['protocol_version', 'supported_versions', 'organization', 'auth', 'agent', 'apis', 'web', 'tasks', 'extensions'];

async function served(): Promise<{ res: Response; doc: Record<string, unknown> }> {
  const res = await GET(new Request('https://vedarai.ru/.well-known/poppy.json', { headers: { 'user-agent': 'Muse/1.0' } }));
  return { res, doc: await res.clone().json() as Record<string, unknown> };
}

function urlsIn(v: unknown): string[] {
  if (typeof v === 'string') return /^[a-z]+:\/\//i.test(v) ? [v] : [];
  if (Array.isArray(v)) return v.flatMap(urlsIn);
  if (v && typeof v === 'object') return Object.values(v).flatMap(urlsIn);
  return [];
}

describe('GET /.well-known/poppy.json', () => {
  it('200, application/json, час кэша, CORS на чтение; вход считается переписью агентов', async () => {
    const { res } = await served();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(vi.mocked(recordAgentEntryHit)).toHaveBeenCalledWith(POPPY_PATH, 'Muse/1.0');
    expect(AGENT_ENTRY_PATHS).toContain(POPPY_PATH);
    expect((await OPTIONS()).status).toBe(204);
  });

  it('поля — только из раздела 3.1; обязательные на месте; домен — хост сайта', async () => {
    const { doc } = await served();
    expect(Object.keys(doc).filter((k) => !SPEC_TOP_LEVEL.includes(k))).toEqual([]);
    expect(doc.protocol_version).toBe('1.0');
    expect(doc.organization).toEqual({ name: 'Ведар Камчатка', domain: 'vedarai.ru' });
    // Возможностей, которых у Ведара нет, документ не объявляет.
    for (const k of ['auth', 'agent', 'web', 'tasks', 'extensions', 'supported_versions']) expect(doc, k).not.toHaveProperty(k);
  });

  it('один API — тот же MCP, что в манифесте /.well-known/mcp.json; описание без обещания брони', async () => {
    const { doc } = await served();
    const apis = doc.apis as Array<Record<string, unknown>>;
    expect(apis).toHaveLength(1);
    expect(Object.keys(apis[0]).sort()).toEqual(['description', 'type', 'url']);
    expect(apis[0].type).toBe('mcp');
    const manifest = await (await mcpManifest(new Request('https://vedarai.ru/.well-known/mcp.json'))).json() as { endpoint: string; transport: string };
    expect(apis[0].url).toBe(manifest.endpoint);
    expect(manifest.transport).toBe('streamable-http');
    const d = String(apis[0].description);
    expect(d).toMatch(/информационный портал/);
    expect(d).toMatch(/не бронь/);
    expect(d).toMatch(/согласи/);
    expect(d.length).toBeLessThan(300);
  });

  it('все адреса — https; домен следует за адресом сайта, порт — только не 443', () => {
    expect(urlsIn(buildPoppyDocument()).every((u) => u.startsWith('https://'))).toBe(true);
    expect(urlsIn(buildPoppyDocument()).length).toBeGreaterThan(0);
    expect(buildPoppyDocument('https://vedarai.ru/').organization.domain).toBe('vedarai.ru');
    expect(buildPoppyDocument('https://staging.vedarai.ru:8443').organization.domain).toBe('staging.vedarai.ru:8443');
    expect(buildPoppyDocument('https://vedarai.ru/').apis[0].url).toBe('https://vedarai.ru/api/mcp');
  });

  it('общий no-store из next.config документ не перебивает', async () => {
    const ROOT = process.cwd();
    const req = createRequire(join(ROOT, 'package.json'));
    const { getPathMatch } = req('next/dist/shared/lib/router/utils/path-match') as {
      getPathMatch: (s: string, o: Record<string, unknown>) => (p: string) => false | object;
    };
    const { modifyRouteRegex } = req('next/dist/lib/redirect-status') as { modifyRouteRegex: (r: string) => string };
    const cfg = req(join(ROOT, 'next.config.js')) as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> };
    const cacheFor = async (path: string) => {
      let v: string | null = null;
      for (const rule of await cfg.headers()) {
        const m = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true, regexModifier: (r: string) => modifyRouteRegex(r) });
        if (m(path) === false) continue;
        for (const h of rule.headers) if (h.key.toLowerCase() === 'cache-control') v = h.value;
      }
      return v;
    };
    expect(await cacheFor(POPPY_PATH)).toBeNull();
    expect(await cacheFor('/.well-known/poppy.json.bak')).toMatch(/no-store/);
  });
});
