/**
 * tests/unit/my-trip-channels.test.ts
 *
 * Связь «чат ↔ заявка» (1416) и «Моя поездка» — только у MAX и Telegram
 * (ревью безопасности #3198). processMessage зовут ещё WhatsApp и Meta — без
 * platform, и их chatId — хвост номера телефона или свёрнутый PSID, а не id
 * чата Telegram. Правило «всё, что не MAX, — Telegram» читало бы по такому
 * числу чужие заявки Telegram и писало бы туда свои связи.
 *
 * Вызовом настоящего processMessage с подменёнными моделью и базой:
 *  - без platform «Моя поездка» не читает связи и отвечает словами;
 *  - без platform ключ статуса и код передачи связей не пишут;
 *  - Telegram и MAX читают и пишут своим каналом.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { tools, fallback, fast, query, issueKey } = vi.hoisted(() => ({
  tools: vi.fn(),
  fallback: vi.fn(),
  fast: vi.fn(),
  query: vi.fn(),
  issueKey: vi.fn(),
}));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => tools(...a),
  callAIWaterfallDetailed: (...a: unknown[]) => fallback(...a),
  callAIFast: (...a: unknown[]) => fast(...a),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/services/safety/zone-weather', () => ({ getZoneWeatherForText: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/ai/route-knowledge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/route-knowledge')>()),
  searchRoutes: vi.fn().mockResolvedValue(''),
}));
vi.mock('@/lib/services/ingest/legislation-importer', () => ({ searchLegislation: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/telegram/operator-availability', () => ({ searchOperatorAvailability: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn(),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/mcp/request-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mcp/request-status')>()),
  issueRequestKey: (...a: unknown[]) => issueKey(...a),
}));

import { processMessage } from '@/lib/kuzmich/core';
import { MY_TRIP_NO_CHANNEL_TEXT, MY_TRIP_NONE_TEXT } from '@/lib/requests/my-trip';

const KEY = 'aB3dEfGh1jKlMn0pQrStUvWxYz12345_';
const reply = vi.fn();
/** Вызов, как его делает WhatsApp-вебхук: без platform, chatId — хвост номера. */
const whatsapp = { userName: 'Гость', mode: 'whatsapp', createdVia: 'whatsapp', reply, pending: new Map() };
const tg = { userName: 'Гость', mode: 'tg_bot', createdVia: 'tg_bot', reply, pending: new Map(), platform: 'tg' as const };
const max = { userName: 'Гость', mode: 'max', createdVia: 'max', reply, pending: new Map(), platform: 'max' as const, verifiedOrigin: true };

/** Запросы к таблице связей: [SQL, параметры]. */
const linkCalls = (): Array<[string, unknown[]]> =>
  query.mock.calls
    .filter((c) => String(c[0]).includes('chat_request_links'))
    .map((c) => [String(c[0]), (c[1] ?? []) as unknown[]]);

beforeEach(() => {
  for (const f of [tools, fallback, fast, query, issueKey, reply]) f.mockReset();
  query.mockImplementation(async (sql: string) => {
    // Код передачи погашен — заявка нашлась.
    if (String(sql).includes('UPDATE request_handoff_codes')) return { rows: [{ lead_id: '11111111-1111-1111-1111-111111111111', seat_request_id: null, stay_request_id: null }] };
    return { rows: [] };
  });
  issueKey.mockResolvedValue(KEY);
  reply.mockResolvedValue(undefined);
  fast.mockResolvedValue('нет');
  fallback.mockResolvedValue({ text: 'ЗАПАСНОЙ ОТВЕТ', provider: 'fallback' });
  tools.mockResolvedValue({ content: 'Ответ модели.', provider: 'test' });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('канал без связи (WhatsApp, Meta)', () => {
  it('«Моя поездка» — связи не читаются, ответ словами, модель не зовётся', async () => {
    await processMessage({ ...whatsapp, chatId: 9_141_234_567, text: 'Моя поездка' });
    expect(linkCalls()).toEqual([]);
    expect(tools).not.toHaveBeenCalled();
    expect(reply.mock.calls).toEqual([[9_141_234_567, MY_TRIP_NO_CHANNEL_TEXT]]);
  });

  it('ключ статуса — ответ есть, связи нет', async () => {
    await processMessage({ ...whatsapp, chatId: 9_141_234_567, text: `https://vedarai.ru/request-status#${KEY}` });
    expect(linkCalls()).toEqual([]);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('код передачи — погашен, ответ есть, связи нет', async () => {
    await processMessage({ ...whatsapp, chatId: 9_141_234_567, text: 'AB2C-DE3F' });
    expect(query.mock.calls.some((c) => String(c[0]).includes('UPDATE request_handoff_codes'))).toBe(true);
    expect(linkCalls()).toEqual([]);
    expect(String(reply.mock.calls[0]?.[1])).toMatch(/^Заявка найдена в этом канале/);
  });
});

describe('Telegram и MAX — своим каналом', () => {
  it('Telegram: «Моя поездка» читает связи канала telegram этого чата', async () => {
    await processMessage({ ...tg, chatId: 555, text: 'Моя поездка' });
    const reads = linkCalls().filter(([sql]) => /^\s*SELECT/i.test(sql));
    expect(reads.map(([, p]) => p.slice(0, 2))).toEqual([['telegram', '555']]);
    expect(reply.mock.calls).toEqual([[555, MY_TRIP_NONE_TEXT]]);
  });

  it('MAX: ключ статуса пишет связь канала max', async () => {
    await processMessage({ ...max, chatId: 777, text: `https://vedarai.ru/request-status#${KEY}` });
    const inserts = linkCalls().filter(([sql]) => /INSERT INTO chat_request_links/.test(sql));
    expect(inserts.map(([, p]) => p.slice(0, 2))).toEqual([['max', '777']]);
  });

  it('Telegram: код передачи пишет связь канала telegram', async () => {
    await processMessage({ ...tg, chatId: 555, text: 'AB2C-DE3F' });
    const inserts = linkCalls().filter(([sql]) => /INSERT INTO chat_request_links/.test(sql));
    expect(inserts.map(([, p]) => p.slice(0, 2))).toEqual([['telegram', '555']]);
  });
});
