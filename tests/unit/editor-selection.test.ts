/**
 * tests/unit/editor-selection.test.ts
 *
 * Фидбэк владельца (07.2026): короткие описания (<300) переселялись КАЖДЫЙ
 * прогон Editor, бесконечно циклясь. Эти тесты фиксируют новый контракт
 * выборки: NULL-описания в приоритете, а уже обработанные короткие
 * «отдыхают» перед повторной попыткой (updated_at + REATTEMPT_REST_DAYS).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEditor, type RouteRow } from '@/lib/agents/editor';

const callAIFastMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
vi.mock('@/lib/ai/providers', () => ({
  callAIFast: (...args: unknown[]) => callAIFastMock(...args),
  AI_FAST_UNAVAILABLE: 'Сервис временно недоступен.',
  // Editor опрашивает провайдеров через callAIFastOrNull: отказ ВСЕХ = null.
  callAIFastOrNull: async (...args: unknown[]) => {
    const text = await callAIFastMock(...args);
    return text === 'Сервис временно недоступен.' ? null : text;
  },
}));

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

const ROUTE: RouteRow = {
  id: '00000000-0000-0000-0000-000000000001',
  title: 'Вулкан Тестовый',
  description: null,
  category: 'vulkani',
};
const LONG_TEXT = 'Содержательное описание вулкана. '.repeat(15);

function capture() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  poolQueryMock.mockImplementation((sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT id, title')) return Promise.resolve({ rows: [ROUTE] });
    if (sql.includes('UPDATE agent_route_knowledge')) return Promise.resolve({ rows: [] });
    if (sql.includes('FILTER')) return Promise.resolve({ rows: [{ queue: '3', total_short: '11' }] });
    return Promise.resolve({ rows: [] });
  });
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  callAIFastMock.mockResolvedValue(LONG_TEXT);
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

describe('findRoutesNeedingDescription: приоритет NULL + отдых коротких', () => {
  it('SELECT: NULL-первыми и короткие только «отдохнувшие» (>7 дней)', async () => {
    const calls = capture();
    await runEditor();

    const select = calls.find(c => c.sql.includes('SELECT id, title'));
    expect(select).toBeTruthy();
    // Короткие берутся только если updated_at старее интервала
    expect(select!.sql).toContain('make_interval');
    expect(select!.sql).toContain('LENGTH(description) < $1');
    // NULL-описания в приоритете сортировки
    expect(select!.sql).toContain('(description IS NULL) DESC');
    // Параметр «дней отдыха» передан (REATTEMPT_REST_DAYS = 7)
    expect(select!.params).toContain(7);
  });

  it('счётчик: отдельно очередь (actionable) и всего коротких', async () => {
    const calls = capture();
    await runEditor();

    const countSql = calls.find(c => c.sql.includes('FILTER'));
    expect(countSql).toBeTruthy();
    // Обе метрики считаются одним запросом
    expect(countSql!.sql).toContain('AS queue');
    expect(countSql!.sql).toContain('AS total_short');
  });
});
