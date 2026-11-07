/**
 * Пост в канал из MAX администратора (фаза 2г): разбор команды «пост» и
 * публикация единственным путём канала с исходом каждого канала.
 *
 * Путь целиком — превью, «Да», журнал, повтор, отказы — на схеме прода и
 * настоящем обработчике бота: tests/integration/max-login-confirm.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ maxFetch: vi.fn(), query: vi.fn() }));

vi.mock('@/lib/max/max-fetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/max/max-fetch')>()),
  maxFetch: (...a: unknown[]) => m.maxFetch(...a),
}));
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => m.query(...a) }));

const { adminPostBody, isAdminPostText } = await import('@/lib/max/admin-post');
const { postAdminText } = await import('@/lib/notifications/telegram-channel');

describe('команда «пост»: первое слово решает', () => {
  it.each([
    ['пост\nОткрыли даты', 'Открыли даты'],
    ['Пост: Открыли даты', 'Открыли даты'],
    ['ПОСТ — Открыли даты', 'Открыли даты'],
    ['пост в канал: Открыли даты', 'Открыли даты'],
    ['пост Открыли даты', 'Открыли даты'],
    ['  пост\n\n  Открыли даты  ', 'Открыли даты'],
    ['пост', ''],
    ['пост в канал', ''],
  ])('%j → текст поста', (text, body) => {
    expect(adminPostBody(text)).toBe(body);
    expect(isAdminPostText(text)).toBe(true);
  });

  it.each(['Постановление губернатора', 'пост-релиз вышел', 'покажи пост', '/post sezon', 'брони', 'постой'])(
    '%j — не пост: дальше разбирают даты и команды',
    (text) => {
      expect(adminPostBody(text)).toBeNull();
      expect(isAdminPostText(text)).toBe(false);
    },
  );

  it('строки и пустые строки текста сохраняются как написаны', () => {
    expect(adminPostBody('пост\nПервая строка.\n\nВторая строка.')).toBe('Первая строка.\n\nВторая строка.');
  });
});

describe('postAdminText — единственный путь канала, исход каждого канала', () => {
  const GOOD = 'Открыли даты на Горелый: 12 и 14 декабря, группа до 6 человек, сбор в 7:00.';
  const tg: Array<{ chat_id: string; text: string }> = [];

  beforeEach(() => {
    tg.length = 0;
    m.query.mockReset().mockResolvedValue({ rows: [] });
    m.maxFetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ message: { body: { mid: 'x' } } })));
    vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-tg');
    vi.stubEnv('TELEGRAM_CHANNEL_ID', '-1001');
    vi.stubEnv('TELEGRAM_API_BASE', 'https://tg.test');
    vi.stubEnv('MAX_BOT_TOKEN', 'test-max');
    vi.stubEnv('MAX_CHANNEL_ID', '-2');
    vi.stubEnv('MAX_CHANNEL_LINK', '');
    vi.stubEnv('TELEGRAM_CHANNEL_LINK', '');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('https://tg.test/')) {
        tg.push(JSON.parse(String(init?.body)) as { chat_id: string; text: string });
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response('', { status: 200 });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('ушло в оба канала: ответа MAX дождались, текст — слово в слово', async () => {
    expect(await postAdminText(GOOD)).toEqual({ kind: 'sent', telegram: { ok: true }, max: { ok: true } });
    expect(tg).toEqual([expect.objectContaining({ chat_id: '-1001', text: GOOD })]);
    expect(m.maxFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((m.maxFetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({ text: GOOD });
  });

  it('MAX отказал — отказ назван, Telegram ушёл', async () => {
    m.maxFetch.mockImplementation(async () => new Response(JSON.stringify({ description: 'Chat not found' }), { status: 404 }));
    expect(await postAdminText(GOOD)).toEqual({
      kind: 'sent', telegram: { ok: true }, max: { ok: false, error: 'Chat not found' },
    });
  });

  it('проверка не пропустила — не ушло никуда, причина без приставки «Публикация отменена»', async () => {
    const r = await postAdminText('Коротко');
    expect(r).toEqual({ kind: 'refused', reason: expect.stringContaining('текст слишком короткий') });
    expect(r.kind === 'refused' ? r.reason : '').not.toContain('Публикация отменена');
    expect(tg).toHaveLength(0);
    expect(m.maxFetch).not.toHaveBeenCalled();
  });

  it('Telegram-канал не настроен — не отправлено никуда', async () => {
    vi.stubEnv('TELEGRAM_CHANNEL_ID', '');
    expect(await postAdminText(GOOD)).toEqual({ kind: 'not_configured' });
    expect(tg).toHaveLength(0);
    expect(m.maxFetch).not.toHaveBeenCalled();
  });
});
