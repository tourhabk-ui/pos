// @vitest-environment node
/**
 * Журнал видит клиентов КНР (владелец 13.10: «в MCP и A2A ни одна китайская
 * модель не зашла ни разу — мы для них не существуем»).
 *
 * До этого дня проверить тезис по журналу было нельзя: словарь родов клиента
 * не знал ни одного китайского продукта, и Qwen Code, Cherry Studio, Dify,
 * Trae, Kimi, Doubao шли в «неизвестен» — 173 из 1085 внешних вызовов за 30
 * дней к 12.10 (§4.0: «не видим» выдавалось за «не приходили»).
 *
 * Проверяется поведение: род по заголовку, метка в срезах админки (вызовом
 * функций среза с подменённым пулом) и группа в переписи (вызовом роута).
 * Отрисовка меток — tests/unit/admin-china-badge.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { uaFamily } from '@/lib/mcp/client-id';
import { chinaClientFamily, clientRegion, CHINA_CLIENT_FAMILIES, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';

type Row = Record<string, unknown>;
type Answer = (sql: string, params: unknown[]) => Row[];

function mockPool(answer: Answer) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: answer(sql, params) };
  });
  vi.resetModules();
  vi.doMock('@/lib/db-pool', () => ({ pool: { query } }));
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/db-pool');
  vi.doUnmock('@/lib/auth/middleware');
});

describe('род клиента по заголовку знает продукты КНР', () => {
  it.each([
    ['QwenCode/0.3.1 (node)', 'qwen-code'],
    ['Mozilla/5.0 (Macintosh) CherryStudio/1.4.0 Chrome/124', 'cherry-studio'],
    ['python-requests/2.32 dify/1.3', 'dify'],
    ['Trae/1.0 (darwin)', 'trae'],
    ['Kimi-Agent/2 python-httpx/0.27', 'kimi'],
    ['ModelScope-MCP-Playground/1.0', 'modelscope'],
    ['Coze/3 node-fetch', 'doubao'],
    // DeepSeek Harness: мост @deepseek-ai/dsh-mcp-client и панели dsh-mcp-*
    // представляются каждая своим именем; все начинаются с «dsh-».
    ['dsh-mcp-client/0.2.0 node', 'deepseek'],
    ['dsh-mcp-center/0.1.2', 'deepseek'],
    ['DeepSeek-Harness/0.2.1 (web)', 'deepseek'],
  ])('%s → %s', (ua, family) => {
    expect(uaFamily(ua)).toBe(family);
    expect(CHINA_CLIENT_FAMILIES.map((f) => f.family)).toContain(family);
  });

  it('прежние роды не сдвинулись', () => {
    expect(uaFamily('Claude-User/1.0')).toBe('claude');
    expect(uaFamily('python-httpx/0.27')).toBe('python');
    expect(uaFamily('curl/8.4.0')).toBe('curl');
    expect(uaFamily('')).toBe('не представился');
  });

  it('совпадение только по границе слова: «modify» — не Dify, «traefik» — не Trae', () => {
    expect(chinaClientFamily('modify-agent/1.0')).toBeNull();
    expect(chinaClientFamily('Traefik/3.0')).toBeNull();
    // «dsh» — только отдельным словом: «redshift» и «bradshaw» — не DeepSeek Harness.
    expect(chinaClientFamily('redshift-connector/2.0')).toBeNull();
    expect(chinaClientFamily('bradshaw-bot/1.0')).toBeNull();
    expect(uaFamily('modify-agent/1.0')).toBe('неизвестен');
    expect(uaFamily('Traefik/3.0')).toBe('неизвестен');
  });
});

describe('метка региона — по самоназванию, не по стране', () => {
  it('имя клиента, род заголовка или самоназвание агента из реестра → «КНР»', () => {
    expect(clientRegion('Qwen Code')).toBe(CHINA_REGION_LABEL);
    expect(clientRegion(null, 'kimi')).toBe(CHINA_REGION_LABEL);
    expect(clientRegion('CherryStudio', 'неизвестен')).toBe(CHINA_REGION_LABEL);
    expect(clientRegion('deepseek-harness', 'python')).toBe(CHINA_REGION_LABEL);
    expect(clientRegion('dsh-mcp-panel', 'неизвестен')).toBe(CHINA_REGION_LABEL);
  });

  it('не из реестра — null, а не пустая строка и не «другая страна»', () => {
    expect(clientRegion('claude-ai', 'claude')).toBeNull();
    expect(clientRegion('mira-bot')).toBeNull();
    expect(clientRegion(null, null)).toBeNull();
    expect(clientRegion('не представился', 'неизвестен')).toBeNull();
  });
});

describe('срезы админки несут метку', () => {
  it('/api/admin/analytics/a2a: клиенты MCP и агенты A2A получают region', async () => {
    mockPool((sql) => {
      if (/FROM mcp_clients/.test(sql)) {
        return [
          { client_name: 'Qwen Code', ua_family: null, caller_days: 3, days: 2, first_seen: '2026-10-12', last_seen: '2026-10-13 10:00' },
          { client_name: 'claude-ai', ua_family: 'claude', caller_days: 9, days: 5, first_seen: '2026-10-01', last_seen: '2026-10-13 09:00' },
        ];
      }
      if (/FROM a2a_requests/.test(sql) && /GROUP BY agent/.test(sql)) {
        const base = { is_self: false, requests: 2, sends: 2, text_sends: 1, tool_sends: 1, completed: 2, rejected: 0, failed: 0, protocol_errors: 0, card_reads: 0, dialogs: 1, caller_days: 1, versions: '1.0', bindings: 'jsonrpc', first_seen: '2026-10-13 08:00', last_seen: '2026-10-13 08:05' };
        return [
          { agent: 'CherryStudio', ua_family: 'cherry-studio', ...base },
          { agent: 'BrickBlueBot', ua_family: 'неизвестен', ...base },
        ];
      }
      if (/MIN\(created_at\)/.test(sql)) return [{ since: '2026-10-12', total: 4 }];
      return [];
    });
    vi.doMock('@/lib/auth/middleware', () => ({ requireAdmin: vi.fn() }));
    const { readMcp, readA2a } = await import('@/app/api/admin/analytics/a2a/route');

    const mcp = await readMcp(30);
    expect(mcp.clients.map((c) => [c.client, c.region])).toEqual([['Qwen Code', 'КНР'], ['claude-ai', null]]);

    const a2a = await readA2a(30);
    expect(a2a.by_agent.map((r) => [r.agent, r.region])).toEqual([['CherryStudio', 'КНР'], ['BrickBlueBot', null]]);
  });

  it('/api/admin/analytics/mcp: «Кто звал» получает region', async () => {
    mockPool((sql) => {
      if (/AS client,/.test(sql) && /GROUP BY 1, 2, 3/.test(sql)) {
        return [
          { client: 'Qwen Code', kind: 'представился', origin: 'external', calls: '5', caller_days: '2', last_seen: '2026-10-13 10:00' },
          { client: 'claude', kind: 'представился', origin: 'external', calls: '313', caller_days: '40', last_seen: '2026-10-13 09:00' },
        ];
      }
      if (/AS external,/.test(sql)) return [{ external: '318', self: '0', probe: '0', self_since: null, refused_since: null }];
      return [];
    });
    vi.doMock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ id: 'admin' }) }));
    const { GET } = await import('@/app/api/admin/analytics/mcp/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/admin/analytics/mcp'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_client_30d.map((c: { client: string; region: string | null }) => [c.client, c.region]))
      .toEqual([['Qwen Code', 'КНР'], ['claude', null]]);
  });
});

describe('перепись mcp-census считает клиентов КНР отдельной группой', () => {
  it('clients_china — число клиентов, вызовов и имена; из тех же строк, что clients', async () => {
    mockPool((sql) => {
      if (/AS client,/.test(sql) && !/NOT t\.ok/.test(sql)) {
        return [
          { client: 'claude', origin: 'external', calls: '313', caller_days: '40', last_seen: '2026-10-13' },
          { client: 'Qwen Code', origin: 'external', calls: '5', caller_days: '2', last_seen: '2026-10-13' },
          { client: 'kimi', origin: 'external', calls: '2', caller_days: '1', last_seen: '2026-10-12' },
        ];
      }
      if (/AS self_since/.test(sql)) return [{ self_since: null, code_since: null, refused_since: null, rows_total: '320', rows_without_code: '0' }];
      return [];
    });
    vi.stubEnv('CRON_SECRET', 'test-secret');
    const { GET } = await import('@/app/api/cron/mcp-census/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/mcp-census?days=30', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clients_china).toEqual({ clients: 2, calls: 7, names: ['Qwen Code (external, 5)', 'kimi (external, 2)'] });
  });
});
