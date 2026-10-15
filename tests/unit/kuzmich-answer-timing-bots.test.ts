/**
 * Замер ответа Кузьмича в Telegram и MAX — вызовом вебхуков (аудит 15.10, A19).
 *
 * Живой вход Telegram — канонический вебхук /api/telegram/webhook
 * (lib/telegram/operator-availability, CANONICAL_WEBHOOK_PATH). До правки
 * TG-BRAIN (15.10) он отвечал туристу одиночным вызовом модели мимо цикла и
 * писал замер сам; теперь идёт в aiChat — цикл инструментов, — и строку пишет
 * aiChat, ровно одну. MAX идёт через processMessage → aiChat → цикл
 * инструментов. Оба роута здесь вызываются с настоящим мозгом Кузьмича:
 * подменены модель, база и транспорт.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  fallback: vi.fn(),
  direct: vi.fn(),
  tgSend: vi.fn(),
  maxSend: vi.fn(),
  clock: { now: 1_800_000_000_000 },
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.pool(...a) } }));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => m.fallback(...a),
  callAIWithModelDirect: (...a: unknown[]) => m.direct(...a),
  callAIFast: vi.fn().mockResolvedValue('нет'),
}));
vi.mock('@/lib/ai/agent-models', () => ({ getModelForAgent: () => 'test-model' }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/route-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/route-knowledge')>()),
  searchRoutes: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telegram/operator-availability')>()),
  searchOperatorAvailability: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
// Контроль выхода — не предмет этого сторожа: вопрос о вулкане до него не доходит.
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));

// ── Telegram: транспорт и соседи роута ─────────────────────────────────────
vi.mock('@/lib/notifications/telegram', () => ({ telegramService: { sendMessage: (...a: unknown[]) => m.tgSend(...a) } }));
vi.mock('@/lib/telegram/webhook-secret', () => ({ verifyWebhookSecret: () => 'ok', refuseUnconfiguredWebhook: vi.fn() }));
vi.mock('@/lib/planner/interests', () => ({
  parseInterestsFromText: () => ({ interests: [] }), findRoutesByInterests: vi.fn(), formatRoutesForTelegram: vi.fn(),
}));
vi.mock('@/lib/telegram/group-monitor', () => ({ groupMonitor: { processMessage: vi.fn() } }));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn() }));

// ── MAX: транспорт и подлинность вебхука ───────────────────────────────────
vi.mock('@/lib/max/max-fetch', () => ({ maxBot: () => ({ api: { sendMessageToChat: (...a: unknown[]) => m.maxSend(...a) } }) }));
vi.mock('@/lib/max/webhook-url', () => ({ isVerifiedMaxWebhook: () => true }));
vi.mock('@/lib/kuzmich/operator-chat', () => ({
  PARTNER_EMAIL_BIND_CLOSED: 'привязка по почте закрыта',
  findPartnerByChat: vi.fn().mockResolvedValue({ outcome: 'not_found' }),
  processPartnerMessage: vi.fn(),
}));

import { KUZMICH_ANSWER_ACTION } from '@/lib/kuzmich/answer-ceiling';
import { RECORD_KUZMICH_ANSWER_SQL } from '@/lib/kuzmich/answer-timing';

const telegram = await import('@/app/api/telegram/webhook/route');
const max = await import('@/app/api/max/kuzmich/route');

function records(): Array<{ provider: unknown; meta: Record<string, unknown> }> {
  return m.pool.mock.calls
    .filter((c) => c[0] === RECORD_KUZMICH_ANSWER_SQL)
    .map((c) => {
      const p = c[1] as unknown[];
      expect(p[0]).toBe(KUZMICH_ANSWER_ACTION);
      return { provider: p[1], meta: JSON.parse(String(p[2])) as Record<string, unknown> };
    });
}

const ASK = 'Когда лучше идти на Авачинский вулкан?';

beforeEach(() => {
  vi.clearAllMocks();
  m.clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => m.clock.now);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  m.pool.mockResolvedValue({ rows: [] });
  m.db.mockResolvedValue({ rows: [] });
  m.tgSend.mockResolvedValue({ success: true });
  m.maxSend.mockResolvedValue({});
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Telegram, живой вебхук /api/telegram/webhook → цикл инструментов', () => {
  it('ответ туристу — одна строка замера: telegram, ход цикла, провайдер, elapsed_ms от входа в цикл', async () => {
    m.tools.mockImplementationOnce(async () => {
      m.clock.now += 9_000;
      return { content: 'Лучше всего — в июле и августе.', provider: 'deepseek' };
    });
    const res = await telegram.POST(new NextRequest('http://localhost/api/telegram/webhook', {
      method: 'POST',
      body: JSON.stringify({ update_id: 7001, message: { message_id: 1, from: { id: 4242, first_name: 'Анна' }, chat: { id: 4242, type: 'private' }, text: ASK } }),
    }));
    expect(await res.json()).toEqual({ ok: true });
    expect(m.tools).toHaveBeenCalledTimes(1);
    // Одиночного вызова мимо цикла больше нет (TG-BRAIN).
    expect(m.direct).not.toHaveBeenCalled();
    expect(m.tgSend).toHaveBeenCalledWith(expect.objectContaining({ chatId: '4242', text: expect.stringContaining('в июле и августе') }));

    // Строка одна: замер пишет aiChat, вебхук своей второй не добавляет.
    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('deepseek');
    expect(rows[0]!.meta).toMatchObject({
      surface: 'telegram', elapsed_ms: 9_000, turns: 1, tool_rounds: 0, path: 'tools', ceiling_hit: false,
    });
  });
});

describe('MAX, вебхук /api/max/kuzmich → цикл инструментов', () => {
  it('ответ туристу — строка замера: max, ходы цикла, провайдер, elapsed_ms от входа в цикл', async () => {
    m.tools
      .mockImplementationOnce(async () => {
        m.clock.now += 5_000;
        return { content: null, provider: 'deepseek', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'safety_status', arguments: '{}' } }] };
      })
      .mockImplementationOnce(async () => { m.clock.now += 4_000; return { content: 'В июле и августе, если нет тревог.', provider: 'deepseek' }; });

    const res = await max.POST(new NextRequest('http://localhost/api/max/kuzmich', {
      method: 'POST',
      body: JSON.stringify({
        update_type: 'message_created',
        message: { recipient: { chat_id: 77 }, sender: { user_id: 77, name: 'Анна' }, body: { text: ASK } },
      }),
    }));
    expect(await res.json()).toEqual({ ok: true });
    expect(m.tools).toHaveBeenCalledTimes(2);
    expect(m.maxSend).toHaveBeenCalledWith(77, expect.stringContaining('В июле и августе'), expect.anything());

    const rows = records();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('deepseek');
    expect(rows[0]!.meta).toMatchObject({
      surface: 'max', elapsed_ms: 9_000, turns: 2, tool_rounds: 1, path: 'tools', ceiling_hit: false,
    });
  });
});
