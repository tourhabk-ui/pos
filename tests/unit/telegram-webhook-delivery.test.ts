/**
 * Сторож вебхука Telegram видит ошибку доставки (15.10).
 *
 * Утром 15.10 Telegram не достучался до сервера («Connection timed out»),
 * партнёр нажал /start дважды и ответа не получил, а сторож вебхука отвечал
 * «ok»: он смотрел только адрес и очередь, а `last_error_date` /
 * `last_error_message`, которые Telegram записал, не читал вовсе.
 *
 * Здесь проверяется поведение, вызовом:
 *  - суждение о доставке на граничных данных (свежесть от прошлой проверки,
 *    повтор, очередь, нечитаемая прошлая проверка, текст без момента);
 *  - проверка с подменённым Telegram: тревога владельцу уходит при повторе и
 *    очереди, не уходит при одной осечке, текст Telegram экранирован, а
 *    неушедшая тревога не выглядит ушедшей;
 *  - чтение прошлой проверки: отказ базы — 'unknown', а не «проверок не было»;
 *  - роут: прошлая проверка доходит до суждения, запись в журнал не глушится.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
vi.mock('@/lib/agents/cron-lease', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/cron-lease')>()),
  claimCronWindow: async () => 'claimed' as const,
}));

const {
  judgeDeliveryError,
  checkAndRestoreWebhook,
  readPreviousDeliveryCheck,
  FRESH_ERROR_WINDOW_MS,
} = await import('@/lib/telegram/operator-availability');

const NOW = Date.parse('2026-10-15T09:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const EXPECTED_URL = 'https://vedarai.ru/api/telegram/webhook';

describe('judgeDeliveryError — суждение о доставке', () => {
  const prevAt = iso(NOW - 30 * MIN);

  it('ошибок не записано — none', () => {
    expect(judgeDeliveryError({ lastErrorAt: null, lastErrorMessage: null, pending: 0, nowMs: NOW, previous: null })).toBe('none');
  });

  it('текст ошибки без момента — не «ошибок нет», а одна свежая', () => {
    expect(judgeDeliveryError({ lastErrorAt: null, lastErrorMessage: 'Connection timed out', pending: 0, nowMs: NOW, previous: null })).toBe('single');
  });

  it('ошибка до прошлой проверки — stale, даже если окно в 35 минут её бы приняло', () => {
    const previous = { checked_at: prevAt, delivery: 'single' as const, last_error_at: iso(NOW - 31 * MIN) };
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 31 * MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous })).toBe('stale');
  });

  it('прошлая проверка была три часа назад — ошибка двухчасовой давности свежая', () => {
    const previous = { checked_at: iso(NOW - 180 * MIN), delivery: 'none' as const, last_error_at: null };
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 120 * MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous })).toBe('single');
  });

  it('свежая ошибка, прошлая проверка чистая — single', () => {
    const previous = { checked_at: prevAt, delivery: 'none' as const, last_error_at: null };
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 5 * MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous })).toBe('single');
  });

  it('свежая ошибка, и прошлая видела свою свежую — repeating', () => {
    const previous = { checked_at: prevAt, delivery: 'single' as const, last_error_at: iso(NOW - 40 * MIN) };
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 5 * MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous })).toBe('repeating');
  });

  it('прошлая видела давнюю (stale) — повтора нет, single', () => {
    const previous = { checked_at: prevAt, delivery: 'stale' as const, last_error_at: iso(NOW - 600 * MIN) };
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 5 * MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous })).toBe('single');
  });

  it('свежая ошибка и очередь не пуста — stuck', () => {
    const previous = { checked_at: prevAt, delivery: 'none' as const, last_error_at: null };
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 5 * MIN), lastErrorMessage: 'x', pending: 4, nowMs: NOW, previous })).toBe('stuck');
  });

  it('прошлую проверку прочитать не удалось — окно 35 минут, повтор не выдумывается', () => {
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - 20 * MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous: 'unknown' })).toBe('single');
    expect(judgeDeliveryError({ lastErrorAt: iso(NOW - FRESH_ERROR_WINDOW_MS - MIN), lastErrorMessage: 'x', pending: 0, nowMs: NOW, previous: 'unknown' })).toBe('stale');
  });
});

describe('checkAndRestoreWebhook — тревога о доставке', () => {
  let sent: Array<{ text: string }> = [];
  let sendStatus = 200;

  function stubTelegram(info: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/getWebhookInfo')) {
        return new Response(JSON.stringify({ ok: true, result: { url: EXPECTED_URL, pending_update_count: 0, ...info } }));
      }
      if (url.endsWith('/sendMessage')) {
        sent.push(JSON.parse(init?.body ?? '{}') as { text: string });
        return new Response('{}', { status: sendStatus });
      }
      throw new Error(`неожиданный запрос ${url}`);
    }));
  }

  beforeEach(() => {
    sent = [];
    sendStatus = 200;
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://vedarai.ru';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const prev = { checked_at: iso(NOW - 30 * MIN), delivery: 'single' as const, last_error_at: iso(NOW - 45 * MIN) };

  it('повтор ошибки — тревога уходит, текст Telegram экранирован', async () => {
    stubTelegram({ last_error_date: (NOW - 5 * MIN) / 1000, last_error_message: 'Wrong response from the webhook: 502 <Bad Gateway>' });
    const r = await checkAndRestoreWebhook({ previous: prev, nowMs: NOW });
    expect(r.status).toBe('ok');
    expect(r.delivery).toBe('repeating');
    expect(r.delivery_alert).toBe('sent');
    expect(r.last_error_at).toBe(iso(NOW - 5 * MIN));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('502 &lt;Bad Gateway&gt;');
    expect(sent[0].text).not.toContain('<Bad Gateway>');
    expect(sent[0].text).toContain('по Камчатке');
  });

  it('очередь копится — тревога со словами о людях, которые ждут', async () => {
    stubTelegram({ last_error_date: (NOW - 2 * MIN) / 1000, last_error_message: 'Connection timed out', pending_update_count: 3 });
    const r = await checkAndRestoreWebhook({ previous: null, nowMs: NOW });
    expect(r.delivery).toBe('stuck');
    expect(r.delivery_alert).toBe('sent');
    expect(sent[0].text).toContain('В очереди: 3');
    expect(sent[0].text).toContain('ждут ответа');
  });

  it('одна осечка, доставленная повтором, — без тревоги, но видна в ответе', async () => {
    stubTelegram({ last_error_date: (NOW - 5 * MIN) / 1000, last_error_message: 'Connection timed out' });
    const r = await checkAndRestoreWebhook({ previous: { ...prev, delivery: 'none', last_error_at: null }, nowMs: NOW });
    expect(r.delivery).toBe('single');
    expect(r.delivery_alert).toBeNull();
    expect(r.last_error_message).toBe('Connection timed out');
    expect(sent).toHaveLength(0);
  });

  it('тревога не ушла — так и сказано, а не «ушла»', async () => {
    sendStatus = 500;
    stubTelegram({ last_error_date: (NOW - 2 * MIN) / 1000, last_error_message: 'Connection timed out', pending_update_count: 2 });
    const r = await checkAndRestoreWebhook({ previous: null, nowMs: NOW });
    expect(r.delivery_alert).toBe('not_sent');
  });

  it('прошлая проверка не передана — суждение знает, что повтор узнать было нечем', async () => {
    stubTelegram({});
    const r = await checkAndRestoreWebhook({ nowMs: NOW });
    expect(r.delivery).toBe('none');
    expect(r.previous_check).toBe('unknown');
  });
});

describe('readPreviousDeliveryCheck — прошлая проверка из журнала', () => {
  beforeEach(() => { queryMock.mockReset(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it('отказ базы — unknown и строка в логе с SQLSTATE', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('relation missing'), { code: '42P01' }));
    await expect(readPreviousDeliveryCheck()).resolves.toBe('unknown');
    expect(String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toContain('42P01');
  });

  it('проверок не было — null', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(readPreviousDeliveryCheck()).resolves.toBeNull();
  });

  it('незнакомое суждение в журнале — null, а не доверие строке', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ checked_at: '2026-10-15T08:30:00Z', delivery: 'bogus', last_error_at: null }] });
    await expect(readPreviousDeliveryCheck()).resolves.toEqual({ checked_at: '2026-10-15T08:30:00Z', delivery: null, last_error_at: null });
  });
});

describe('GET /api/cron/telegram-webhook-watchdog — прошлая проверка доходит до суждения', () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env.CRON_SECRET = 'test-secret';
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret';
    process.env.TELEGRAM_WEBHOOK_URL = 'https://vedarai.ru';
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('повтор узнан по журналу, суждение записано в журнал; отказ записи — в логе', async () => {
    const realNow = Date.now();
    queryMock
      .mockResolvedValueOnce({ rows: [{ checked_at: iso(realNow - 30 * MIN), delivery: 'single', last_error_at: iso(realNow - 40 * MIN) }] })
      .mockRejectedValueOnce(Object.assign(new Error('insert failed'), { code: '23514' }));
    const sentTexts: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.endsWith('/getWebhookInfo')) {
        return new Response(JSON.stringify({ ok: true, result: {
          url: EXPECTED_URL, pending_update_count: 0,
          last_error_date: Math.floor((realNow - 5 * MIN) / 1000), last_error_message: 'Connection timed out',
        } }));
      }
      sentTexts.push(String(init?.body));
      return new Response('{}');
    }));

    const { GET } = await import('@/app/api/cron/telegram-webhook-watchdog/route');
    const res = await GET(new Request('https://vedarai.ru/api/cron/telegram-webhook-watchdog', {
      headers: { authorization: 'Bearer test-secret' },
    }));
    const body = await res.json() as { delivery: string; delivery_alert: string };
    expect(res.status).toBe(200);
    expect(body.delivery).toBe('repeating');
    expect(body.delivery_alert).toBe('sent');
    expect(sentTexts).toHaveLength(1);

    const insert = queryMock.mock.calls[1];
    expect(String(insert[0])).toContain('INSERT INTO agent_run_history');
    expect(JSON.parse(String((insert[1] as unknown[])[3]))).toMatchObject({ delivery: 'repeating' });
    const logged = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]));
    expect(logged.some(l => l.includes('23514'))).toBe(true);
  });
});
