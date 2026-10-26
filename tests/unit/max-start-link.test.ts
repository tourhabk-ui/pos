// @vitest-environment node
/**
 * Старт Кузьмича в MAX по кнопке сайта (вопрос владельца 23.10: «почему при
 * переходе по кнопке max в чате макс нет команды /start»).
 *
 * Две причины, обе держатся здесь:
 *  - ссылка без старта: событие bot_started MAX присылает при переходе по
 *    ссылке СО стартом, и человек, уже писавший боту, открывал пустой чат.
 *    Теперь кнопка ведёт на `?start=lead`, и вебхук на такой старт отвечает
 *    как на /start — приветствием и меню тем (настоящий processMessage);
 *  - подсказок «/» не было: список команд MAX-боту не ставил никто. Теперь его
 *    ставит крон самолечения (`lib/max/bot-commands`), и в списке ровно те
 *    команды, что бот понимает, — каждая проверена вызовом processMessage.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const m = vi.hoisted(() => ({
  maxSend: vi.fn(),
  maxSendUser: vi.fn(),
  answerCb: vi.fn(),
  maxFetch: vi.fn(),
  pool: vi.fn(),
  tools: vi.fn(),
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

import { KUZMICH_MAX_URL, KUZMICH_TELEGRAM_URL } from '@/components/shared/KuzmichActions';
import { startActionOf } from '@/lib/max/verified-press';
import { createPartnerLinkToken, partnerTokenFromStart, PARTNER_LINK_PREFIX } from '@/lib/partners/channel-link';
import { memberTokenFromStart } from '@/lib/operators/member-channel';
import { statusTokenFromStart } from '@/lib/seat-requests/core';
import { MAX_BOT_COMMANDS, syncMaxBotCommands } from '@/lib/max/bot-commands';
import { processMessage } from '@/lib/kuzmich/core';

const KEY = 'test-webhook-key-23-10';
const VERIFIED = `http://localhost/api/max/kuzmich?s=${KEY}`;

const started = (payload: string | null) => ({
  update_type: 'bot_started', timestamp: 1, chat_id: 77, payload, user: { user_id: 77, name: 'Анна' },
});

/** Что бот ответил в чат 77 (тексты по порядку). */
const replies = () => m.maxSend.mock.calls.filter((c) => c[0] === 77).map((c) => String(c[1]));

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.maxSend.mockResolvedValue({});
  m.pool.mockResolvedValue({ rows: [] });
  m.tools.mockResolvedValue({ content: 'ОТВЕТ МОДЕЛИ', provider: 'test' });
  vi.stubEnv('MAX_BOT_TOKEN', 'test-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('кнопка MAX на сайте ведёт на старт бота', () => {
  it('ссылка — бот Кузьмича со стартом lead, как у Telegram; старт короче 128 знаков', () => {
    const u = new URL(KUZMICH_MAX_URL);
    expect(u.origin + u.pathname).toBe('https://max.ru/id4101147649_bot');
    expect(u.searchParams.get('start')).toBe('lead');
    expect(u.searchParams.get('start')!.length).toBeLessThanOrEqual(128);
    expect(new URL(KUZMICH_TELEGRAM_URL).searchParams.get('start')).toBe('lead');
  });

  it('кнопки сайта не ведут на бота без старта: адрес — только из KUZMICH_MAX_URL', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx$/.test(e.name)) files.push(p);
      }
    };
    walk(join(process.cwd(), 'app'));
    walk(join(process.cwd(), 'components'));
    const bare = files.filter((f) => /href=["']https:\/\/max\.ru\/id4101147649_bot["']/.test(readFileSync(f, 'utf8')));
    expect(bare).toEqual([]);
  });

  it('метку lead не берёт себе ни вход, ни подключение партнёра, команды или туриста', () => {
    expect(startActionOf('lead')).toBeNull();
    expect(partnerTokenFromStart('lead')).toBeNull();
    expect(memberTokenFromStart('lead')).toBeNull();
    expect(statusTokenFromStart('lead')).toBeNull();
  });

  it.each([
    ['заверенный апдейт', VERIFIED],
    ['без ключа подписки', 'http://localhost/api/max/kuzmich'],
  ])('старт по ссылке (%s) — приветствие и меню тем, модель не зовётся', async (_kind, url) => {
    if (url !== VERIFIED) vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    const { POST } = await import('@/app/api/max/kuzmich/route');
    await POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(started('lead')) }));
    const texts = replies();
    expect(texts[0]).toContain('Я Кузьмич');
    expect(texts[1]).toBe('Выберите тему или задайте вопрос:');
    expect(m.tools).not.toHaveBeenCalled();
  });
});

describe('команды бота в MAX', () => {
  it('ставятся PATCH /me/commands на platform-api2 с токеном бота — ровно список MAX_BOT_COMMANDS', async () => {
    m.maxFetch.mockResolvedValue(new Response(JSON.stringify({ commands: MAX_BOT_COMMANDS }), { status: 200 }));
    expect(await syncMaxBotCommands('test-token')).toEqual({ state: 'ok' });
    const [url, init] = m.maxFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://platform-api2.max.ru/me/commands');
    expect(init.method).toBe('PATCH');
    expect(init.headers.Authorization).toBe('test-token');
    expect(JSON.parse(init.body)).toEqual({ commands: MAX_BOT_COMMANDS });
    expect(MAX_BOT_COMMANDS.map((c) => c.name)).toEqual(['start', 'help', 'reset']);
  });

  it('ответ без списка, но с HTTP 200 — поставлены', async () => {
    m.maxFetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await syncMaxBotCommands('t')).toEqual({ state: 'ok' });
  });

  it.each([
    ['HTTP 500', () => new Response(JSON.stringify({ message: 'internal' }), { status: 500 }), /HTTP 500: internal/],
    ['success: false при 200', () => new Response(JSON.stringify({ success: false, message: 'bad' }), { status: 200 }), /success: false \(bad\)/],
    ['чужой список в ответе', () => new Response(JSON.stringify({ commands: [{ name: 'start' }] }), { status: 200 }), /другой список команд: start/],
  ])('%s — «не поставлены» с причиной в исходе и в логе', async (_kind, reply, why) => {
    m.maxFetch.mockResolvedValue(reply());
    const out = await syncMaxBotCommands('t');
    expect(out.state).toBe('failed');
    expect(out.state === 'failed' && out.reason).toMatch(why);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('[max/bot-commands]'));
  });

  it('сеть не дошла — «не поставлены», токена в причине нет', async () => {
    m.maxFetch.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    const out = await syncMaxBotCommands('secret-token-value');
    expect(out).toEqual({ state: 'failed', reason: 'ETIMEDOUT: connect ETIMEDOUT' });
    expect(JSON.stringify(out)).not.toContain('secret-token-value');
  });

  const PARTNER = '0f2a7f0e-3f5d-4c1a-9b0e-7d4b2a1c5e6f';
  let midSeq = 0;
  const typed = (text: string) => ({
    update_type: 'message_created',
    timestamp: 1,
    message: {
      sender: { user_id: 77, name: 'Павел' },
      recipient: { chat_id: 77, chat_type: 'dialog' },
      // Своё mid у каждого сообщения: одинаковое отсекается как повтор доставки (25.10).
      body: { mid: `m-${++midSeq}`, seq: 1, text, attachments: [] as unknown[] },
    },
  });

  it.each([
    ['payload bot_started', (code: string) => started(code)],
    ['сообщение /start op_', (code: string) => typed(`/start ${code}`)],
    ['сообщение /start@бота op_', (code: string) => typed(`/start@id4101147649_bot ${code}`)],
    ['голое сообщение op_', (code: string) => typed(code)],
  ])('%s подключает MAX: адрес записан, ответ называет подключение, приветствия Кузьмича нет, код в ответ и лог не попадает', async (_kind, body) => {
    vi.stubEnv('CONNECT_TOKEN_SECRET', 'test-secret-for-partner-links-16');
    m.pool.mockImplementation(async (sql: string) => (
      String(sql).includes('UPDATE partners')
        ? { rows: [{ name: 'Местечко Камчатка', display_name: 'Местечко Камчатка', category: 'operator', slug: 'mestecko', previous: null }] }
        : { rows: [] }
    ));
    const t = createPartnerLinkToken(PARTNER);
    if (!t.ok) throw new Error(t.reason);
    const code = `${PARTNER_LINK_PREFIX}${t.token}`;
    const { POST } = await import('@/app/api/max/kuzmich/route');
    await POST(new NextRequest(VERIFIED, { method: 'POST', body: JSON.stringify(body(code)) }));
    const upd = m.pool.mock.calls.find((c) => /UPDATE partners/.test(String(c[0])) && /max_chat_id/.test(String(c[0])));
    // Третий параметр — человек, открывший ссылку (user_id апдейта): по нему
    // администратор заводит вход на сайт через MAX (1336).
    expect(upd?.[1]).toEqual(['77', PARTNER, '77']);
    const said = replies().join('\n');
    expect(said).toMatch(/Вы подключены как туроператор «Местечко Камчатка»/);
    // /start в processMessage отвечает приветствием, не вызывая модель:
    // «инструменты не звали» само по себе приветствие не опровергает.
    expect(said).not.toMatch(/Я Кузьмич/);
    expect(said).not.toContain(t.token);
    expect(m.tools).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.flat().join(' ')).not.toContain(t.token);
  });

  it.each(MAX_BOT_COMMANDS.map((c) => c.name))('команда /%s из списка — бот её понимает: ответ без модели', async (name) => {
    const reply = vi.fn().mockResolvedValue(undefined);
    await processMessage({
      chatId: 77, text: `/${name}`, userName: 'Анна', userId: 77, mode: 'max', createdVia: 'max',
      pending: new Map(), reply, platform: 'max', verifiedOrigin: true,
    });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(String(reply.mock.calls[0]![1]).length).toBeGreaterThan(10);
    expect(m.tools).not.toHaveBeenCalled();
  });
});
