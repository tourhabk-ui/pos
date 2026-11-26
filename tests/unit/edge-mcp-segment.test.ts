// @vitest-environment node
/**
 * /api/mcp на Edge — пропуск по сегментам пути, а не по началу строки
 * (проверка безопасности ИИ-части 26.11, слово владельца «чини Карт бланш»).
 *
 * MCP-сервер открыт без входа: его зовут чужие агенты. Шлюз пропускал всё,
 * что начинается со строки «/api/mcp», — и будущий роут /api/mcp-admin или
 * /api/mcpstats ушёл бы к обработчику без JWT, хотя в реестре публичных API
 * его нет. Тест исполняет настоящий middleware (как edge-admin-gate):
 * «пропущен» — NextResponse.next(), заголовок x-middleware-next: 1.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }),
  },
}));

beforeAll(() => {
  process.env.JWT_SECRET = 'test-secret-at-least-32-bytes-long-000';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});

async function run(path: string, method: string) {
  const { middleware } = await import('../../middleware');
  return middleware(new NextRequest(`https://vedarai.ru${path}`, { method }));
}

const passed = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('MCP открыт анониму целиком и только он', () => {
  it('сам сервер и его подпути пропускаются без входа', async () => {
    for (const [path, method] of [['/api/mcp', 'POST'], ['/api/mcp', 'GET'], ['/api/mcp/server-card', 'GET'], ['/api/mcp/partner', 'POST']] as const) {
      expect(passed(await run(path, method)), `${method} ${path}`).toBe(true);
    }
  });

  it('роут, чьё имя лишь начинается с mcp, без входа не пропускается', async () => {
    for (const path of ['/api/mcp-admin', '/api/mcpstats', '/api/mcp_export/run']) {
      const res = await run(path, 'POST');
      expect(passed(res), path).toBe(false);
      expect(res.status, path).toBe(401);
    }
  });

  it('подпути, которые тест называет, существуют', () => {
    for (const dir of ['app/api/mcp/server-card', 'app/api/mcp/partner']) {
      expect(existsSync(join(process.cwd(), dir)), dir).toBe(true);
    }
  });
});
