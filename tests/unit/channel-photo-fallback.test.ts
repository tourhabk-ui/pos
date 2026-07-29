/**
 * Каскад фото в канале: реальное фото → куратор-фото → текст.
 *
 * Кейс владельца 27.07 («Гремучие ключи»): пост ушёл голым текстом, потому что
 * tgPostPhoto при отказе Telegram МОЛЧА откатывался в sendMessage — ни лога,
 * ни второй попытки с куратор-фото. Теперь каждый откат логируется с причиной
 * (console.error + ai_actions_log 'channel_photo_fallback'), а между фото и
 * текстом стоит попытка куратор-снимка.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn(async () => ({ rows: [] }));
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...(args as [])),
}));

import { tgPostPhoto } from '@/lib/notifications/telegram-channel';

type FetchCall = { url: string; body: Record<string, unknown> };

function stubTelegram(outcomes: { sendPhoto: boolean[]; sendMessage?: boolean }) {
  const calls: FetchCall[] = [];
  let photoAttempt = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url: String(url), body });
    let ok = true;
    let description: string | undefined;
    if (String(url).includes('/sendPhoto')) {
      ok = outcomes.sendPhoto[photoAttempt] ?? false;
      photoAttempt += 1;
      if (!ok) description = 'Bad Request: wrong file identifier/HTTP URL specified';
    } else if (String(url).includes('/sendMessage')) {
      ok = outcomes.sendMessage ?? true;
    }
    return { json: async () => ({ ok, description }) };
  }));
  return calls;
}

beforeEach(() => {
  queryMock.mockClear();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('tgPostPhoto: каскад и логирование', () => {
  it('фото ушло с первой попытки — один вызов, никаких логов отката', async () => {
    const calls = stubTelegram({ sendPhoto: [true] });
    const res = await tgPostPhoto('chat', 'https://a/photo.jpg', 'текст', undefined, 'https://a/curator.jpg');
    expect(res.ok).toBe(true);
    expect(res.fellBackToText).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('основное фото отказало → уходит куратор-фото, откат залогирован', async () => {
    const calls = stubTelegram({ sendPhoto: [false, true] });
    const res = await tgPostPhoto('chat', 'https://a/real.jpg', 'текст', undefined, 'https://a/curator.jpg');
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/sendPhoto');
    expect(calls[1].body.photo).toBe('https://a/curator.jpg');
    // Ровно одна запись — про откат на куратор-фото, с причиной Telegram.
    expect(queryMock).toHaveBeenCalledTimes(1);
    const params = (queryMock.mock.calls[0] as unknown[])[1] as unknown[];
    const logged = JSON.parse(params[1] as string) as Record<string, string>;
    expect(logged.outcome).toBe('fallback_photo');
    expect(logged.error).toContain('wrong file');
    expect(logged.photo_url).toBe('https://a/real.jpg');
  });

  it('оба фото отказали → текст, оба отката залогированы, fellBackToText', async () => {
    const calls = stubTelegram({ sendPhoto: [false, false] });
    const res = await tgPostPhoto('chat', 'https://a/real.jpg', 'текст', undefined, 'https://a/curator.jpg');
    expect(res.ok).toBe(true);
    expect(res.fellBackToText).toBe(true);
    expect(calls[2].url).toContain('/sendMessage');
    expect(queryMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(((queryMock.mock.calls[1] as unknown[])[1] as unknown[])[1] as string) as Record<string, string>;
    expect(second.outcome).toBe('text_only');
  });

  it('без куратор-фолбэка — сразу текст, но с логом причины (раньше лога не было)', async () => {
    const calls = stubTelegram({ sendPhoto: [false] });
    const res = await tgPostPhoto('chat', 'https://a/real.jpg', 'текст');
    expect(res.ok).toBe(true);
    expect(res.fellBackToText).toBe(true);
    expect(calls[1].url).toContain('/sendMessage');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(((queryMock.mock.calls[0] as unknown[])[1] as unknown[])[1] as string) as Record<string, string>;
    expect(logged.outcome).toBe('text_only');
  });
});

describe('эндпоинт картинок отдаёт реальные снимки приоритетно', () => {
  it('ORDER BY ставит wikimedia/manual-upload раньше legacy-блобов', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('app/api/images/route/[routeId]/route.ts', 'utf8');
    expect(src).toContain("model IN ('wikimedia', 'manual-upload') THEN 0");
    expect(src).toContain('ORDER BY');
    expect(src).toContain('LIMIT 1');
  });
});
