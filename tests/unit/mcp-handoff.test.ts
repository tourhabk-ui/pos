/**
 * MCP handoff — мост «ответ агента → действие человека» (этап 2 плана
 * метрик MCP, чертёж владельца 15.08).
 *
 * Сторож держит гарантии чертежа:
 *  1. В БД только SHA-256 токена — сырой token нигде не сохраняется.
 *  2. target_path — только белый список, построенный серверным кодом;
 *     URL из аргументов внешнего агента не берётся.
 *  3. Атрибуция — подписанная HttpOnly-cookie; токен не живёт в query
 *     финальной страницы (отдельный redirect + no-referrer).
 *  4. Ни ПД, ни аргументов инструментов в таблицах handoff-а.
 *  5. Без MCP_ATTRIBUTION_COOKIE_SECRET всё деградирует мягко.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSafeTarget,
  makeAttributionCookieValue,
  readVerifiedMcpAttribution,
} from '@/lib/mcp/handoff';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const HANDOFF = read('lib/mcp/handoff.ts');
const REDIRECT = read('app/mcp/h/[token]/route.ts');
const MCP_ROUTE = read('app/api/mcp/route.ts');
const LEADS = read('app/api/leads/route.ts');
const MIGRATION = read('migrations/862_mcp_handoffs.sql');

describe('белый список целей', () => {
  it('реальные пути Ведара проходят', () => {
    expect(isSafeTarget({ targetType: 'planner', targetPath: '/planner?days=7' })).toBe(true);
    expect(isSafeTarget({ targetType: 'plan', targetPath: '/plans/pervaya-poezdka-na-kamchatku' })).toBe(true);
    expect(isSafeTarget({ targetType: 'safety', targetPath: '/safety' })).toBe(true);
    expect(isSafeTarget({ targetType: 'tour', targetPath: '/catalog/tours/1' })).toBe(true);
  });

  it('open redirect и чужие типы — нет', () => {
    expect(isSafeTarget({ targetType: 'planner', targetPath: '//evil.example' })).toBe(false);
    expect(isSafeTarget({ targetType: 'planner', targetPath: 'https://evil.example/planner' })).toBe(false);
    expect(isSafeTarget({ targetType: 'planner', targetPath: '/hub/admin' })).toBe(false);
    expect(isSafeTarget({ targetType: 'safety', targetPath: '/planner' })).toBe(false);
  });
});

describe('токен и хранение', () => {
  it('256 бит энтропии, в БД только SHA-256', () => {
    expect(HANDOFF).toMatch(/randomBytes\(32\)/);
    expect(HANDOFF).toMatch(/sha256\(token\)/);
    // INSERT кладёт tokenHash, сырого token в параметрах запроса нет.
    expect(HANDOFF).not.toMatch(/VALUES[^;]*\btoken\b[^_]/);
    expect(MIGRATION).toMatch(/token_hash CHAR\(64\) NOT NULL UNIQUE/);
  });

  it('в таблицах нет ПД и аргументов инструментов', () => {
    // Смотрим только объявления колонок (без комментариев): ни телефона,
    // ни имени человека, ни комментария, ни аргументов. tool_name — имя
    // инструмента из реестра, не ПД.
    const columns = MIGRATION
      .split('\n')
      .filter((l) => /^\s{2}[a-z_]+ /.test(l))
      .map((l) => l.trim().split(' ')[0]);
    for (const bad of ['phone', 'user_name', 'comment', 'args', 'arguments', 'prompt', 'email']) {
      expect(columns, `колонка ${bad}`).not.toContain(bad);
    }
    expect(MIGRATION).toMatch(/target_path TEXT NOT NULL CHECK \(target_path LIKE '\/%'\)/);
  });
});

describe('redirect-эндпоинт', () => {
  it('валидация формата токена до похода в БД, 303 и HttpOnly cookie', () => {
    expect(REDIRECT).toMatch(/\^\[A-Za-z0-9_-\]\{43\}\$/);
    expect(REDIRECT).toMatch(/status: 303/);
    expect(REDIRECT).toMatch(/httpOnly: true/);
    expect(REDIRECT).toMatch(/sameSite: 'lax'/);
  });

  it('токен не утекает: no-referrer и no-store', () => {
    expect(REDIRECT).toMatch(/Referrer-Policy', 'no-referrer'/);
    expect(REDIRECT).toMatch(/no-store, private/);
  });
});

describe('подписанная атрибуция', () => {
  const OLD = process.env.MCP_ATTRIBUTION_COOKIE_SECRET;
  beforeAll(() => { process.env.MCP_ATTRIBUTION_COOKIE_SECRET = 'x'.repeat(48); });
  afterAll(() => { process.env.MCP_ATTRIBUTION_COOKIE_SECRET = OLD; });

  it('подпись сходится по кругу, подделка — нет', () => {
    const id = '0b10231b-063c-4d6d-8778-8e18486b6fa4';
    const cookie = makeAttributionCookieValue(id)!;
    expect(readVerifiedMcpAttribution(cookie)).toBe(id);
    expect(readVerifiedMcpAttribution(`${id}.forged`)).toBeNull();
    expect(readVerifiedMcpAttribution('not-a-uuid.sig')).toBeNull();
  });

  it('без секрета — мягкая деградация, не исключение', () => {
    delete process.env.MCP_ATTRIBUTION_COOKIE_SECRET;
    expect(makeAttributionCookieValue('0b10231b-063c-4d6d-8778-8e18486b6fa4')).toBeNull();
    expect(readVerifiedMcpAttribution('whatever.sig')).toBeNull();
    process.env.MCP_ATTRIBUTION_COOKIE_SECRET = 'x'.repeat(48);
  });
});

describe('врезка в MCP-роут и приём лида', () => {
  it('ссылка добавляется только после успешного вызова, цели строит сервер', () => {
    expect(MCP_ROUTE).toMatch(/handoffTargetForTool\(toolName, toolArgs\)/);
    expect(MCP_ROUTE).toMatch(/Продолжить в Ведаре/);
    // В ветке ошибки handoff не выпускается.
    const catchBlock = MCP_ROUTE.slice(MCP_ROUTE.indexOf('} catch (toolErr)'));
    expect(catchBlock).not.toMatch(/issueMcpHandoff/);
  });

  it('лид с формы несёт mcp_handoff_id из проверенной cookie, не из body', () => {
    expect(LEADS).toMatch(/attachMcpAttribution\(/);
    expect(LEADS).toMatch(/mcp_handoff_id: mcpHandoffId/);
    // Идентификатор нельзя подсунуть телом запроса — только verified cookie.
    expect(LEADS).not.toMatch(/body[^;]*mcp_handoff_id/);
  });
});
