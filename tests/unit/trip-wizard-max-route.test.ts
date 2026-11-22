/**
 * «Спланировать поездку» живым вебхуком MAX (22.11): шаг правит нажатое
 * сообщение, сборка зовёт движок (подменён) только по заверенному апдейту,
 * модель не зовётся. Подменены база, модель, транспорт MAX и сборка плана.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  pool: vi.fn(),
  db: vi.fn(),
  tools: vi.fn(),
  fallback: vi.fn(),
  orNull: vi.fn(),
  maxSend: vi.fn(),
  findAdmin: vi.fn(),
  edit: vi.fn(),
  run: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({
  pool: {
    query: (...a: unknown[]) => m.pool(...a),
    connect: async () => ({ query: (...a: unknown[]) => m.pool(...a), release: () => undefined }),
  },
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.db(...a) }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => m.fallback(...a),
  callAIWaterfallOrNull: (...a: unknown[]) => m.orNull(...a),
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
vi.mock('@/lib/planner/interests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/planner/interests')>()),
  findRoutesByInterests: vi.fn().mockResolvedValue([]),
}));
// Контроль выхода — не предмет этого сторожа.
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: vi.fn(async () => ({ success: true })) },
}));
vi.mock('@/lib/notifications/pd-alert', () => ({ sendPdAlert: vi.fn().mockResolvedValue({ delivered: true }) }));
vi.mock('@/lib/leads/create', () => ({ createLead: vi.fn().mockResolvedValue('lead-1') }));
vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({
    api: {
      sendMessageToChat: (...a: unknown[]) => m.maxSend(...a),
      sendMessageToUser: vi.fn().mockResolvedValue({}),
      answerOnCallback: vi.fn().mockResolvedValue({}),
      editMessage: (...a: unknown[]) => m.edit(...a),
    },
  }),
  maxFetch: vi.fn(),
}));
vi.mock('@/lib/max/admin-link', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/max/admin-link')>()),
  findMaxAdmin: (...a: unknown[]) => m.findAdmin(...a),
}));

vi.mock('@/lib/chat/trip-wizard-run', async (orig) => ({
  ...(await orig<typeof import('@/lib/chat/trip-wizard-run')>()),
  runWizardPlan: (...a: unknown[]) => m.run(...a),
}));

const max = await import('@/app/api/max/kuzmich/route');
const { clearMaxMessageDedup } = await import('@/lib/max/update-dedup');

const KEY = 'test-webhook-key-trip-wizard';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const CHAT = 9_512;
let seq = 0;

const post = (body: unknown, url = VERIFIED) => max.POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(body) }));

const press = (payload: string, url = VERIFIED) => post({
  update_type: 'message_callback',
  timestamp: 1,
  callback: { timestamp: 1, callback_id: `cb-tp-${++seq}`, payload, user: { user_id: CHAT, name: 'Анна' } },
  message: { recipient: { chat_id: CHAT, chat_type: 'dialog' }, body: { mid: `m-tp-${seq}`, seq: 1, text: 'шаг' } },
}, url);

const future = new Date(Date.now() + 40 * 86400000).toISOString().slice(2, 10).replace(/-/g, '');

beforeEach(() => {
  clearMaxMessageDedup();
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('CALLBACK_SIGNING_SECRET', 'route-signing');
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('сеть в тестах закрыта')));
  m.maxSend.mockResolvedValue({});
  m.edit.mockResolvedValue({ success: true });
  m.findAdmin.mockResolvedValue({ outcome: 'none' });
  m.db.mockResolvedValue({ rows: [] });
  m.pool.mockResolvedValue({ rows: [] });
  m.tools.mockResolvedValue({ content: 'ОТВЕТ МОДЕЛИ', tool_calls: null, provider: 'test' });
  m.fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback', tier: 1, failed: false });
  m.orNull.mockResolvedValue('ОТВЕТ БЕЗ ИНСТРУМЕНТОВ');
  m.run.mockResolvedValue({
    text: 'План на 5 дней с …:\n\nДень 1, 01.01 — Прилёт',
    buttons: [[{ text: 'Открыть план целиком', url: 'https://vedarai.ru/trip/0f8fad5b-d9cb-469f-a165-70867728950e' }]],
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('«Спланировать поездку» в MAX', () => {
  it('кнопка меню — первый шаг новым сообщением (меню остаётся), модель не зовётся', async () => {
    await press('tp:0:-:-:-:-:0');
    expect(m.edit).not.toHaveBeenCalled();
    const sent = m.maxSend.mock.calls.find((c) => String(c[1]).includes('Когда едете?'));
    expect(sent).toBeTruthy();
    expect(JSON.stringify(sent![2])).toMatch(/"payload":"tp:1:\d{6}:/);
    expect(m.tools).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
  });

  it('шаг «дни» — кнопки 3/5/7/10/14', async () => {
    await press(`tp:1:${future}:-:-:-:0`);
    const extra = (m.edit.mock.calls[0] as [string, { text: string; attachments: unknown[] }])[1];
    expect(extra.text).toContain('Сколько дней');
    for (const d of ['3', '5', '7', '10', '14']) expect(JSON.stringify(extra.attachments)).toContain(`"text":"${d}"`);
  });

  it('«Собрать план» по заверенному апдейту — движок зовётся, план с кнопкой-ссылкой, модель не зовётся', async () => {
    await press(`tp:5:${future}:5:2:0:1`);
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.tools).not.toHaveBeenCalled();
    // «Собираю план…», затем план правкой того же сообщения — заглушка не остаётся.
    const edits = m.edit.mock.calls as Array<[string, { text: string; attachments: unknown[] }]>;
    expect(edits.map(([, e]) => e.text.split('\n')[0])).toEqual(['Собираю план по дням…', 'План на 5 дней с …:']);
    expect(edits[0]![0]).toBe(edits[1]![0]);
    expect(JSON.stringify(edits[1]![1].attachments)).toContain('"type":"link"');
  });

  it('без заверения апдейта — план не собирается', async () => {
    await press(`tp:5:${future}:5:2:0:1`, 'http://localhost/api/max/kuzmich');
    expect(m.run).not.toHaveBeenCalled();
  });

  it('мусор в данных кнопки — «устарела», движок не зовётся', async () => {
    await press('tp:5:999999:5:2:0:1');
    expect(m.run).not.toHaveBeenCalled();
    const extra = (m.edit.mock.calls[0] as [string, { text: string }])[1];
    expect(extra.text).toContain('устарела');
  });
});
