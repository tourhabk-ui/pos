// @vitest-environment node
/**
 * Кабинет прокатчика в MAX включается только списком RENTAL_OPERATOR_PILOT_SLUGS.
 * Ссылка op_ пишет чат партнёра; обычный «Старт» и ссылка администратора adm_
 * (#2746) привязку прокатчика не создают.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  answerCb: vi.fn(),
  maxFetch: vi.fn(),
  pool: vi.fn(),
  tools: vi.fn(),
  tgSend: vi.fn(),
}));

vi.mock('@/lib/max/max-fetch', () => ({
  maxBot: () => ({ api: { sendMessageToChat: m.maxSend, sendMessageToUser: m.maxSendUser, answerOnCallback: m.answerCb } }),
  maxFetch: (...a: unknown[]) => m.maxFetch(...a),
}));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => m.pool(...a) } }));
vi.mock('@/lib/ai/providers', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/providers')>()),
  callToolsWaterfall: (...a: unknown[]) => m.tools(...a),
}));
vi.mock('@/lib/ai/rag-context', () => ({ buildRAGContext: vi.fn().mockResolvedValue('') }));
vi.mock('@/lib/kuzmich/safety-review-log', () => ({ recordSafetyReview: vi.fn() }));
vi.mock('@/lib/kuzmich/watch-flow', () => ({
  handleWatchMessage: vi.fn().mockResolvedValue(false),
  deleteWatchDraft: vi.fn().mockResolvedValue(undefined),
  telegramWatchRedirect: () => null,
}));
vi.mock('@/lib/agents/managed/kuzmich-outcomes', async (orig) => ({
  ...(await orig<typeof import('@/lib/agents/managed/kuzmich-outcomes')>()),
  gradeKuzmichResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/notifications/telegram', () => ({
  telegramService: { sendMessage: (msg: unknown) => m.tgSend(msg) },
}));

import { isRentalPilotSlug, rentalPilotBoundText, rentalPilotGreeting, rentalPilotSlugs } from '@/lib/rental/operator-pilot';
import { createPartnerLinkToken } from '@/lib/partners/channel-link';

const KEY = 'test-webhook-key-23-10';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;
const PID = '3f2b8c1a-9d4e-4b7a-8c21-0e5f6a7b8c9d';
const NOW = Date.UTC(2026, 9, 23, 12, 0);

const started = (payload: string | null) => ({
  update_type: 'bot_started', timestamp: 1, chat_id: 77, payload, user: { user_id: 77, name: 'Акбар' },
});

const replies = () => m.maxSend.mock.calls.filter((c) => c[0] === 77).map((c) => String(c[1]));
const sqls = () => m.pool.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.tgSend.mockResolvedValue({ success: true });
  m.pool.mockResolvedValue({ rows: [] });
  m.tools.mockResolvedValue({ content: 'ОТВЕТ МОДЕЛИ', provider: 'test' });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('JWT_SECRET', 'test-secret-long-enough-0123456789');
  vi.stubEnv('CONNECT_TOKEN_SECRET', '');
  vi.stubEnv('TELEGRAM_CHAT_ID', '-100500');
  vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', '');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('список пилота', () => {
  it('пустая переменная — никого; slug сравнивается без регистра и пробелов, дубли схлопываются', () => {
    expect(rentalPilotSlugs(undefined)).toEqual([]);
    expect(rentalPilotSlugs('')).toEqual([]);
    expect(rentalPilotSlugs('  , , ')).toEqual([]);
    expect(isRentalPilotSlug('laguna-prokat', '')).toBe(false);
    expect(rentalPilotSlugs(' Laguna-Prokat , laguna-prokat , fishing ')).toEqual(['laguna-prokat', 'fishing']);
    expect(isRentalPilotSlug('LAGUNA-PROKAT', 'laguna-prokat')).toBe(true);
    expect(isRentalPilotSlug('fishing', 'laguna-prokat')).toBe(false);
    expect(isRentalPilotSlug(null, 'laguna-prokat')).toBe(false);
  });

  it('текст привязки экранирует имя и не обещает правку цен', () => {
    const bound = rentalPilotBoundText('Лагуна <Прокат>');
    expect(bound).toContain('подключены как прокатчик');
    expect(bound).toContain('Лагуна &lt;Прокат&gt;');
    expect(bound).not.toContain('<Прокат>');
    expect(bound).not.toMatch(/цен[аыу]/);
    const greet = rentalPilotGreeting('Лагуна Прокат');
    expect(greet).toContain('ничего не переключает');
    expect(greet).not.toMatch(/машин/);
  });
});

describe('вебхук MAX', () => {
  async function post(payload: string | null) {
    const { POST } = await import('@/app/api/max/kuzmich/route');
    await POST(new NextRequest(VERIFIED, { method: 'POST', body: JSON.stringify(started(payload)) }));
  }

  it('обычный «Старт» без ссылки чат не привязывает и отвечает как туристу', async () => {
    await post(null);
    await post('');
    await post('lead');
    expect(sqls().some((s) => /SET max_chat_id/.test(s))).toBe(false);
    expect(replies().some((t) => t.includes('Я Кузьмич'))).toBe(true);
    expect(replies().some((t) => t.includes('прокатчик'))).toBe(false);
  });

  it('ссылка op_ при флаге привязывает и называет прокатчика; без флага — прежний текст оператора', async () => {
    const t = createPartnerLinkToken(PID, NOW);
    if (!t.ok) throw new Error('нет токена');
    m.pool.mockImplementation(async (sql: unknown) => {
      if (/SET max_chat_id/.test(String(sql))) {
        return { rows: [{ name: 'Лагуна Прокат', slug: 'laguna-prokat', previous: null }] };
      }
      return { rows: [] };
    });

    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    await post(`op_${t.token}`);
    expect(sqls().some((s) => /SET max_chat_id/.test(s))).toBe(true);
    expect(replies()).toEqual([expect.stringContaining('подключены как прокатчик «Лагуна Прокат»')]);
    expect(replies().join('\n')).not.toContain('Я Кузьмич');

    m.maxSend.mockClear();
    m.pool.mockClear();
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', '');
    await post(`op_${t.token}`);
    const text = replies().join('\n');
    expect(text).toMatch(/подключён к оператору «Лагуна Прокат»/);
    expect(text).not.toMatch(/прокатчик/);
  });

  it('уже привязанный прокатчик на обычный «Старт» не перезаписывает чат', async () => {
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    m.pool.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (/SET max_chat_id/.test(s)) return { rows: [{ name: 'не должно', slug: 'laguna-prokat', previous: null }] };
      if (/FROM partners/.test(s) && /max_chat_id/.test(s)) {
        return { rows: [{ id: PID, slug: 'laguna-prokat', name: 'Лагуна Прокат', category: 'transfer', user_id: null, profile_status: null }] };
      }
      return { rows: [] };
    });
    await post(null);
    expect(sqls().some((s) => /SET max_chat_id/.test(s))).toBe(false);
    expect(replies()).toEqual([expect.stringContaining('Вы подключены как прокатчик «Лагуна Прокат»')]);
    expect(replies()[0]).toContain('ничего не переключает');
    expect(m.tools).not.toHaveBeenCalled();
  });

  it('ссылка администратора adm_ карточку партнёра не пишет', async () => {
    vi.stubEnv('RENTAL_OPERATOR_PILOT_SLUGS', 'laguna-prokat');
    await post(`adm_${'b'.repeat(32)}`);
    expect(sqls().some((s) => /SET max_chat_id|SET telegram_chat_id/.test(s))).toBe(false);
    expect(replies().join('\n')).not.toMatch(/прокатчик/);
    expect(replies().join('\n')).toMatch(/не ответила|администратор/);
  });
});
