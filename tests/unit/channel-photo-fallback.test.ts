/**
 * Каскад фото в канале: реальное фото → куратор-фото → текст.
 *
 * Кейс владельца 27.07 («Гремучие ключи»): пост ушёл голым текстом, потому что
 * tgPostPhoto при отказе Telegram МОЛЧА откатывался в sendMessage — ни лога,
 * ни второй попытки с куратор-фото. Теперь каждый откат логируется с причиной
 * (console.error + ai_actions_log 'channel_photo_fallback'), а между фото и
 * текстом стоит попытка куратор-снимка.
 *
 * 07.09 у каскада появился шаг ПЕРЕД отправкой: снимок скачивает наш сервер и
 * отдаёт Telegram байтами. Повод — журнал прода: «failed to get HTTP URL
 * content» и «WEBPAGE_CURL_FAILED» при живых снимках, то есть Bot API не смог
 * скачать наш адрес. Поэтому заглушка теперь отвечает и за наш хост тоже:
 * считать вызовы, делая вид, что скачивания нет, значит проверять каскад,
 * которого больше не существует.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn(async () => ({ rows: [] }));
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...(args as [])),
}));

import { tgPostPhoto } from '@/lib/notifications/telegram-channel';

type FetchCall = { url: string; body: Record<string, unknown> };

/** Один пиксель JPEG хватает: важен тип содержимого, а не картинка. */
const PIXEL = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

/**
 * Заглушка отвечает за ДВА хоста: наш (отдаёт снимок) и Telegram (принимает).
 *
 * `photoHost: false` — наш снимок скачать не удалось; тогда отправка обязана
 * попробовать ссылкой, как раньше. Это отдельный случай от отказа Telegram, и
 * заглушка обязана уметь их различать.
 */
function stubTelegram(outcomes: { sendPhoto: boolean[]; sendMessage?: boolean; photoHost?: boolean }) {
  const calls: FetchCall[] = [];
  let photoAttempt = 0;
  const photoHostOk = outcomes.photoHost !== false;

  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: unknown }) => {
    const u = String(url);

    // Наш хост: снимок для загрузки байтами.
    if (!u.includes('/bot')) {
      calls.push({ url: u, body: { download: true } });
      if (!photoHostOk) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => PIXEL.buffer.slice(0),
      };
    }

    // Telegram: тело формой (загрузка) или JSON (ссылка, текст).
    const raw = init?.body;
    const body: Record<string, unknown> = typeof raw === 'string'
      ? JSON.parse(raw) as Record<string, unknown>
      : { multipart: true };
    calls.push({ url: u, body });

    let ok = true;
    let description: string | undefined;
    if (u.includes('/sendPhoto')) {
      ok = outcomes.sendPhoto[photoAttempt] ?? false;
      photoAttempt += 1;
      if (!ok) description = 'Bad Request: wrong file identifier/HTTP URL specified';
    } else if (u.includes('/sendMessage')) {
      ok = outcomes.sendMessage ?? true;
    }
    return { json: async () => ({ ok, description }) };
  }));
  return calls;
}

/** Вызовы к Telegram — без шага скачивания нашего снимка. */
const tg = (calls: FetchCall[]) => calls.filter((c) => c.url.includes('/bot'));

beforeEach(() => {
  queryMock.mockClear();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('tgPostPhoto: каскад и логирование', () => {
  it('фото ушло с первой попытки — одна отправка, никаких логов отката', async () => {
    const calls = stubTelegram({ sendPhoto: [true] });
    const res = await tgPostPhoto('chat', 'https://a/photo.jpg', 'текст', undefined, 'https://a/curator.jpg');
    expect(res.ok).toBe(true);
    expect(res.fellBackToText).toBeUndefined();
    // Скачивание своего снимка + одна отправка. К Telegram — ровно один вызов.
    expect(tg(calls)).toHaveLength(1);
    expect(tg(calls)[0].body.multipart).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('снимок уходит БАЙТАМИ, а не ссылкой', async () => {
    // Ссылку Telegram скачать не смог (журнал прода 07.09), поэтому её в теле
    // отправки быть не должно, пока наш хост отдаёт файл.
    const calls = stubTelegram({ sendPhoto: [true] });
    await tgPostPhoto('chat', 'https://a/photo.jpg', 'текст');
    expect(tg(calls)[0].body.photo).toBeUndefined();
    expect(calls[0].body.download).toBe(true);
  });

  it('свой снимок не скачался — пробуем ссылкой, как раньше', async () => {
    const calls = stubTelegram({ sendPhoto: [true], photoHost: false });
    const res = await tgPostPhoto('chat', 'https://a/photo.jpg', 'текст');
    expect(res.ok).toBe(true);
    expect(tg(calls)[0].body.photo).toBe('https://a/photo.jpg');
  });

  it('основное фото отказало → уходит куратор-фото, откат залогирован', async () => {
    const calls = stubTelegram({ sendPhoto: [false, true] });
    const res = await tgPostPhoto('chat', 'https://a/real.jpg', 'текст', undefined, 'https://a/curator.jpg');
    expect(res.ok).toBe(true);
    expect(tg(calls)).toHaveLength(2);
    expect(tg(calls)[1].url).toContain('/sendPhoto');
    // Куратор-снимок тоже уходит байтами: его скачали перед отправкой.
    expect(calls.some((c) => c.url === 'https://a/curator.jpg')).toBe(true);
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
    expect(tg(calls)[2].url).toContain('/sendMessage');
    expect(queryMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(((queryMock.mock.calls[1] as unknown[])[1] as unknown[])[1] as string) as Record<string, string>;
    expect(second.outcome).toBe('text_only');
  });

  it('без куратор-фолбэка — сразу текст, но с логом причины (раньше лога не было)', async () => {
    const calls = stubTelegram({ sendPhoto: [false] });
    const res = await tgPostPhoto('chat', 'https://a/real.jpg', 'текст');
    expect(res.ok).toBe(true);
    expect(res.fellBackToText).toBe(true);
    expect(tg(calls)[1].url).toContain('/sendMessage');
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
