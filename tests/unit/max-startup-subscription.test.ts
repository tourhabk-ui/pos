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
 *  - instrumentation зовёт это при старте и не ждёт сети MAX.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ maxFetch: vi.fn() }));
vi.mock('@/lib/max/max-fetch', () => ({ maxFetch: m.maxFetch }));

import { ensureMaxSubscriptionOnStart } from '@/lib/max/startup-subscription';
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

  it('MAX не ответил на список — HTTP-код в логе, подписки вслепую нет', async () => {
    m.maxFetch.mockResolvedValueOnce(json({}, 503));
    expect(await ensureMaxSubscriptionOnStart()).toEqual({ outcome: 'failed', step: 'list', reason: 'HTTP 503' });
    expect(m.maxFetch).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(KEY);
  });
});

describe('instrumentation: старт зовёт подписку и не ждёт сети MAX', () => {
  const ensure = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    ensure.mockReset();
    vi.doMock('@/lib/max/startup-subscription', () => ({ ensureMaxSubscriptionOnStart: ensure }));
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
