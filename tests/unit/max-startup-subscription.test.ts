/**
 * Подписка бота MAX при старте контейнера (план мини-приложения, §6.5,
 * этап 0) — вызовом, а не поиском строки в файле.
 *
 * До 22.10 instrumentation.ts подписывал адрес без ключа на запасном хосте
 * tourhab.ru обычным fetch и глушил отказ пустым catch. С такой подписки ни
 * одно нажатие не проверить (lib/max/verified-press), а человек получал бы
 * второй ответ.
 *
 * Что держит:
 *  - адрес подписки — maxWebhookUrl(): ключ в адресе, хост vedarai.ru;
 *  - путь — maxFetch (корень Минцифры), а не голый fetch;
 *  - подписка на месте — повторно не ставится; есть только старая без
 *    ключа — ставится с ключом;
 *  - без ключа в окружении старт не подписывает ничего и говорит об этом;
 *  - отказ — в лог, и ключа нет ни в одной строке лога;
 *  - подписка засчитывается по ответу MAX целиком: `{success:false}` при
 *    HTTP 200 — отказ, а не «поставлена»;
 *  - отказ повторяется с паузами, а не вышло — тревога в рабочий чат: после
 *    смены ключа без новой подписки бот в MAX молчит до прогона крона;
 *  - ответ HTTP 200 без поля success или не JSON — «исход не проверен»: не
 *    подписка, а отказ с повторами и тревогой;
 *  - подписывает только боевой экземпляр (хост vedarai.ru и
 *    NODE_ENV=production): стенд или next dev с прод-переменными к MAX не
 *    ходят вовсе — подписка у бота одна, и они увели бы её на себя;
 *  - instrumentation зовёт это при старте и не ждёт сети MAX.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ maxFetch: vi.fn() }));
vi.mock('@/lib/max/max-fetch', () => ({ maxFetch: m.maxFetch }));

import { RETRY_DELAYS_MS, ensureMaxSubscriptionOnStart, subscribeMaxOnStart } from '@/lib/max/startup-subscription';
import { maxWebhookUrl } from '@/lib/max/webhook-url';

const KEY = 'startup-key-never-in-logs';
const KEYED = `https://vedarai.ru/api/max/kuzmich?s=${KEY}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let errorLog: ReturnType<typeof vi.spyOn>;
/** Всё, что ушло в консоль, одной строкой — для проверки «ключа нет». */
const logged = () => JSON.stringify(errorLog.mock.calls);

beforeEach(() => {
  m.maxFetch.mockReset();
  vi.stubEnv('MAX_BOT_TOKEN', 'bot-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  // Не задан: прежний код брал тогда запасной хост tourhab.ru.
  vi.stubEnv('NEXT_PUBLIC_BASE_URL', undefined);
  // Боевой экземпляр; прочие окружения — отдельный блок ниже.
  vi.stubEnv('NODE_ENV', 'production');
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** Вызовы maxFetch: метод и тело. */
const calls = () => m.maxFetch.mock.calls.map((c) => ({
  url: String(c[0]),
  method: (c[1] as RequestInit | undefined)?.method ?? 'GET',
  body: (c[1] as RequestInit | undefined)?.body ? JSON.parse(String((c[1] as RequestInit).body)) as { url: string } : null,
}));

describe('подписка MAX при старте', () => {
  it('подписки нет — ставится адрес с ключом на vedarai.ru, не tourhab.ru', async () => {
    m.maxFetch
      .mockResolvedValueOnce(json({ subscriptions: [{ url: 'https://other.example/hook' }] }))
      .mockResolvedValueOnce(json({ success: true }));

    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'registered' });
    const [list, register] = calls();
    expect(list).toMatchObject({ url: 'https://platform-api2.max.ru/subscriptions', method: 'GET' });
    expect(register).toMatchObject({ url: 'https://platform-api2.max.ru/subscriptions', method: 'POST' });
    expect(register!.body!.url).toBe(maxWebhookUrl());
    expect(register!.body!.url).toBe(KEYED);
    expect(logged()).not.toContain(KEY);
  });

  it('подписка с ключом на месте — повторно не ставится', async () => {
    m.maxFetch.mockResolvedValueOnce(json({ subscriptions: [{ url: KEYED }] }));
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'present' });
    expect(calls().map((c) => c.method)).toEqual(['GET']);
  });

  it('есть только старая подписка без ключа — ставится с ключом', async () => {
    m.maxFetch
      .mockResolvedValueOnce(json([{ url: 'https://vedarai.ru/api/max/kuzmich' }]))
      .mockResolvedValueOnce(json({ success: true }));
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'registered' });
    expect(calls()[1]!.body!.url).toBe(KEYED);
  });

  it('без ключа в окружении — не подписывает ничего и говорит, что нажатия не проверить', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'skipped', reason: 'no_key' });
    expect(m.maxFetch).not.toHaveBeenCalled();
    expect(logged()).toContain('MAX_WEBHOOK_SECRET не задан');
  });

  it('без токена бота — молча нечего делать', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', '');
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'skipped', reason: 'no_token' });
    expect(m.maxFetch).not.toHaveBeenCalled();
  });

  it('список не прочитан (сеть) — отказ в логе с причиной, ключа в логе нет, вслепую не подписывает', async () => {
    m.maxFetch.mockRejectedValueOnce(Object.assign(new Error(`connect failed for ${KEYED}`), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }));
    const out = await ensureMaxSubscriptionOnStart();
    expect(out).toMatchObject({ outcome: 'failed', step: 'list' });
    expect(m.maxFetch).toHaveBeenCalledTimes(1);
    expect(logged()).toContain('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(logged()).toContain('s=[secret]');
    expect(logged()).not.toContain(KEY);
  });

  it('MAX отказал в подписке — отказ в логе, ключа в логе нет', async () => {
    m.maxFetch
      .mockResolvedValueOnce(json({ subscriptions: [] }))
      .mockResolvedValueOnce(json({ code: 'error' }, 400));
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'failed', step: 'register', reason: 'HTTP 400' });
    expect(logged()).toContain('HTTP 400');
    expect(logged()).toContain('s=[secret]');
    expect(logged()).not.toContain(KEY);
  });

  it('MAX ответил HTTP 200 и {success:false} — подписка не засчитана, причина словами MAX', async () => {
    m.maxFetch
      .mockResolvedValueOnce(json({ subscriptions: [] }))
      .mockResolvedValueOnce(json({ success: false, message: `url ${KEYED} rejected` }));
    const out = await ensureMaxSubscriptionOnStart();
    expect(out).toMatchObject({ outcome: 'failed', step: 'register' });
    expect(out.outcome === 'failed' && out.reason).toContain('success: false: url');
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(logged()).not.toContain(KEY);
  });

  it.each([
    ['{}', 'HTTP 200, в ответе нет поля success — исход не проверен'],
    ['OK', 'HTTP 200, ответ не разобран — исход не проверен'],
  ])('MAX ответил HTTP 200 и %s — исход не проверен, подписка не засчитана', async (body, reason) => {
    m.maxFetch
      .mockResolvedValueOnce(json({ subscriptions: [] }))
      .mockResolvedValueOnce(new Response(body, { status: 200 }));
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'failed', step: 'register', reason });
    expect(logged()).toContain('исход не проверен');
    expect(logged()).not.toContain(KEY);
  });

  it('MAX не ответил на список — HTTP-код в логе, подписки вслепую нет', async () => {
    m.maxFetch.mockResolvedValueOnce(json({}, 503));
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'failed', step: 'list', reason: 'HTTP 503' });
    expect(m.maxFetch).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(KEY);
  });
});

describe('подписка при старте: повтор с паузами и тревога', () => {
  const sleep = vi.fn(async () => undefined);
  const alert = vi.fn();
  beforeEach(() => {
    sleep.mockClear();
    alert.mockReset();
    alert.mockResolvedValue({ ok: true });
  });

  it('паузы по умолчанию — минуты, а не часы крона', () => {
    expect(RETRY_DELAYS_MS.length).toBeGreaterThan(0);
    expect(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(15 * 60_000);
  });

  it('сеть отказала дважды, потом подписка встала — тревоги нет, паузы по порядку', async () => {
    m.maxFetch
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ subscriptions: [] }))
      .mockResolvedValueOnce(json({ success: true }));
    const out = await subscribeMaxOnStart({ delaysMs: [5, 7, 11], sleep, alert });
    expect(out).toEqual({ outcome: 'registered' });
    expect(sleep.mock.calls).toEqual([[5], [7]]);
    expect(alert).not.toHaveBeenCalled();
  });

  it('все попытки не удались — одна тревога с причиной и тем, как поднять бота; ключа в ней нет', async () => {
    m.maxFetch.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? json({ success: false, message: `quota for ${KEYED}` })
      : json({ subscriptions: [] })));
    const out = await subscribeMaxOnStart({ delaysMs: [1, 1], sleep, alert });
    expect(out).toMatchObject({ outcome: 'failed', step: 'register' });
    expect(m.maxFetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(3);
    expect(alert).toHaveBeenCalledTimes(1);
    const text = String(alert.mock.calls[0]![0]);
    expect(text).toContain('Попыток: 3;');
    expect(text).toContain('success: false: quota');
    expect(text).toContain('cron-max-webhook');
    expect(text).not.toContain(KEY);
  });

  it('MAX каждый раз отвечает HTTP 200 без success — повторы с паузами и одна тревога «не проверено»', async () => {
    const replies = ['{}', 'OK', '{"result":"done"}'];
    m.maxFetch.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(replies.shift() ?? '{}', { status: 200 })
      : json({ subscriptions: [] })));
    const out = await subscribeMaxOnStart({ delaysMs: [3, 4], sleep, alert });
    expect(out).toMatchObject({ outcome: 'failed', step: 'register', reason: expect.stringContaining('исход не проверен') });
    expect(sleep.mock.calls).toEqual([[3], [4]]);
    expect(m.maxFetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(3);
    expect(alert).toHaveBeenCalledTimes(1);
    const text = String(alert.mock.calls[0]![0]);
    expect(text).toContain('Попыток: 3;');
    expect(text).toContain('исход не проверен');
  });

  it('тревога не доставлена — это названо в логе', async () => {
    m.maxFetch.mockResolvedValue(json({}, 502));
    alert.mockResolvedValue({ ok: false, reason: 'TELEGRAM_BOT_TOKEN не задан' });
    await subscribeMaxOnStart({ delaysMs: [], sleep, alert });
    expect(logged()).toContain('тревога о подписке при старте не доставлена: TELEGRAM_BOT_TOKEN не задан');
  });

  it('без ключа — ни повторов, ни тревоги: это настройка, она в логе', async () => {
    vi.stubEnv('MAX_WEBHOOK_SECRET', '');
    expect(await subscribeMaxOnStart({ delaysMs: [1, 1], sleep, alert })).toEqual({ outcome: 'skipped', reason: 'no_key' });
    expect(sleep).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('подписка при старте: только боевой экземпляр', () => {
  const sleep = vi.fn(async () => undefined);
  const alert = vi.fn(async () => ({ ok: true as const }));
  beforeEach(() => {
    sleep.mockClear();
    alert.mockClear();
    // Если бы проверки не было, MAX принял бы подписку: исход отличался бы.
    m.maxFetch.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? json({ success: true })
      : json({ subscriptions: [] })));
  });
  const posts = () => m.maxFetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

  it.each([
    ['стенд', 'https://staging.vedarai.ru', 'staging.vedarai.ru'],
    ['прежний хост', 'https://tourhab.ru', 'tourhab.ru'],
    ['next dev', 'http://localhost:3000', 'localhost'],
  ])('чужой NEXT_PUBLIC_BASE_URL (%s) с прод-переменными — POST к MAX не уходит, причина в логе без ключа', async (_name, base, host) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', base);
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'skipped', reason: 'foreign_host' });
    expect(posts()).toHaveLength(0);
    expect(m.maxFetch).not.toHaveBeenCalled();
    expect(logged()).toContain(`хост ${host}`);
    expect(logged()).not.toContain(KEY);
  });

  it('NODE_ENV=development на боевом адресе — POST к MAX не уходит, причина в логе', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'skipped', reason: 'not_production' });
    expect(posts()).toHaveLength(0);
    expect(m.maxFetch).not.toHaveBeenCalled();
    expect(logged()).toContain('NODE_ENV=development');
    expect(logged()).not.toContain(KEY);
  });

  it('старт стенда — ни повторов, ни тревоги: это не отказ, а не тот экземпляр', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://staging.vedarai.ru');
    expect(await subscribeMaxOnStart({ delaysMs: [1, 1], sleep, alert })).toEqual({ outcome: 'skipped', reason: 'foreign_host' });
    expect(posts()).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('www.vedarai.ru в проде — канон, подписка ставится на него', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://www.vedarai.ru/');
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'registered' });
    expect(posts()).toHaveLength(1);
    expect(calls()[1]!.body!.url).toBe(`https://www.vedarai.ru/api/max/kuzmich?s=${KEY}`);
  });
});

describe('instrumentation: старт зовёт подписку и не ждёт сети MAX', () => {
  const ensure = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    ensure.mockReset();
    vi.doMock('@/lib/max/startup-subscription', () => ({ subscribeMaxOnStart: ensure }));
    vi.doMock('@/lib/config', () => ({ validateConfig: () => ({ warnings: [], fatal: [] }) }));
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    // Обработчики процесса из register() в процесс теста не вешаем.
    vi.spyOn(process, 'on').mockImplementation(() => process);
  });
  afterEach(() => {
    vi.doUnmock('@/lib/max/startup-subscription');
    vi.doUnmock('@/lib/config');
  });

  it('с токеном бота — подписка зовётся, register не ждёт её окончания', async () => {
    let finish: () => void = () => undefined;
    ensure.mockReturnValue(new Promise<void>((r) => { finish = r; }));
    const { register } = await import('@/instrumentation');
    await register();
    await vi.waitFor(() => expect(ensure).toHaveBeenCalledTimes(1));
    finish();
  });

  it('без токена бота — подписка не зовётся', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', '');
    const { register } = await import('@/instrumentation');
    await register();
    await new Promise((r) => setTimeout(r, 0));
    expect(ensure).not.toHaveBeenCalled();
  });

  it('отказ загрузки модуля подписки — в лог, не в тишину', async () => {
    ensure.mockRejectedValue(new Error('модуль не загрузился'));
    const { register } = await import('@/instrumentation');
    await register();
    await vi.waitFor(() => expect(errorLog.mock.calls.some((c) => String(c[0]).includes('подписка при старте не выполнилась'))).toBe(true));
  });
});
