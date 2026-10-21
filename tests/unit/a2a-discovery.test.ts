// @vitest-environment node
/**
 * A2A-вход находят, пускают и ведут из одного места (12.10).
 *
 * Держит связку целиком (§10.09 CLAUDE.md: объявленный исход без источника):
 *  - роуты визиток и обоих биндингов лежат на диске по путям из карточки;
 *  - Edge пускает /api/a2a без токена (реестр публичных роутов) — иначе
 *    агент получал бы 401, как было с фидом Яндекса;
 *  - robots разрешает агентские входы; манифест MCP, llms.txt и страница
 *    /mcp называют A2A — агент, пришедший одним путём, узнаёт о другом;
 *  - исполнение инструмента общее с MCP: A2A зовёт runPublicTool из роута
 *    MCP, а tools/call MCP зовёт его же — правило в одном месте.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPublicApiPath } from '@/lib/auth/public-api-routes';
import { AGENT_CARD_PATH, LEGACY_AGENT_CARD_PATH, A2A_JSONRPC_PATH, A2A_REST_PATH } from '@/lib/a2a/agent-card';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('роуты лежат по адресам из карточки', () => {
  it('визитки обеих версий и оба биндинга', () => {
    expect(existsSync(join(ROOT, 'app', AGENT_CARD_PATH, 'route.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'app', LEGACY_AGENT_CARD_PATH, 'route.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'app', A2A_JSONRPC_PATH, 'route.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'app', A2A_REST_PATH, '[[...path]]', 'route.ts'))).toBe(true);
  });

  it('визитки собираются одним модулем — своего списка навыков у роутов нет', () => {
    expect(read(`app${AGENT_CARD_PATH}/route.ts`)).toMatch(/buildAgentCard/);
    expect(read(`app${LEGACY_AGENT_CARD_PATH}/route.ts`)).toMatch(/buildLegacyAgentCard/);
    expect(read(`app${AGENT_CARD_PATH}/route.ts`)).not.toMatch(/skills:/);
  });
});

describe('Edge пускает агентов без токена', () => {
  it('/api/a2a и REST-пути публичны на любой метод', () => {
    expect(isPublicApiPath('/api/a2a', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/a2a', 'GET')).toBe(true);
    expect(isPublicApiPath('/api/a2a/v1/message:send', 'POST')).toBe(true);
    expect(isPublicApiPath('/api/a2a/v1/tasks/abc', 'GET')).toBe(true);
    // Однокоренной сосед не наследует пропуск.
    expect(isPublicApiPath('/api/a2anything', 'GET')).toBe(false);
  });
});

describe('обнаружение: robots, манифест MCP, llms.txt, страница /mcp', () => {
  it('robots разрешает визитки и биндинг', () => {
    const robots = read('app/robots.ts');
    for (const p of ['/api/a2a', '/.well-known/agent-card.json', '/.well-known/agent.json']) {
      expect(robots).toContain(`'${p}'`);
    }
  });

  it('манифест MCP указывает на визитку и оба биндинга теми же константами', () => {
    const manifest = read('app/.well-known/mcp.json/route.ts');
    expect(manifest).toMatch(/a2a:\s*\{/);
    for (const c of ['AGENT_CARD_PATH', 'LEGACY_AGENT_CARD_PATH', 'A2A_JSONRPC_PATH', 'A2A_REST_PATH']) {
      expect(manifest).toContain(c);
    }
    expect(manifest).toMatch(/from '@\/lib\/a2a\/agent-card'/);
  });

  it('llms.txt и страница /mcp называют A2A словами и адресами', () => {
    const llms = read('app/llms.txt/route.ts');
    expect(llms).toMatch(/A2A \(Agent2Agent 1\.0\)/);
    expect(llms).toContain('/.well-known/agent-card.json');
    expect(llms).toContain('/api/a2a/v1');
    expect(llms).toMatch(/подтверждает человек/);
    const page = read('app/mcp/page.tsx');
    expect(page).toMatch(/Для A2A-агентов/);
    expect(page).toContain('/.well-known/agent-card.json');
  });
});

describe('одно исполнение на MCP и A2A', () => {
  const mcpRoute = read('app/api/mcp/route.ts');

  it('runPublicTool экспортирован из роута MCP, и tools/call идёт через него', () => {
    expect(mcpRoute).toMatch(/export async function runPublicTool\(/);
    expect(mcpRoute).toMatch(/const outcome = await runPublicTool\(\{/);
    expect(mcpRoute).toMatch(/import type \{ PublicToolOutcome \} from '@\/lib\/mcp\/tool-outcome'/);
  });

  it('A2A зовёт тот же runPublicTool и Кузьмича из lib/a2a/chat, своего SQL и своих стражей не держит', () => {
    const shared = read('app/api/a2a/_shared.ts');
    expect(shared).toMatch(/import \{ runPublicTool \} from '@\/app\/api\/mcp\/route'/);
    expect(shared).toMatch(/answerAgentMessage/);
    for (const f of ['app/api/a2a/_shared.ts', 'app/api/a2a/route.ts', 'app/api/a2a/v1/[[...path]]/route.ts', 'lib/a2a/handle.ts', 'lib/a2a/wire.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/pool\.query|FROM operator_tours|INSERT INTO/);
      expect(src, f).not.toMatch(/checkMcpWrite|buildConsentRecord/);
    }
  });

  it('ответ Кузьмича агенту — тем же мозгом, что у туриста', () => {
    const chat = read('lib/a2a/chat.ts');
    expect(chat).toMatch(/aiChatAgentLoop\(/);
    expect(chat).toMatch(/KUZMICH_SYSTEM \+ A2A_AGENT_NOTE/);
    // Страховки ответа (километраж, безопасность, доставка, 112) судятся
    // вызовом: tests/unit/kuzmich-guards-all-surfaces.test.ts (аудит 1.14).
  });
});
