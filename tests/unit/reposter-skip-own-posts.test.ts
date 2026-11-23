/**
 * Репостер не шлёт в MAX то, что платформа уже отправила туда сама.
 *
 * postToAllChannels и ручной пост с toMax зеркалят текст в MAX и ставят
 * перекрёстную ссылку. Тот же channel_post приходит в вебхук репостера.
 * Без записи (chat.id, message_id) в MAX было бы два поста.
 *
 * Ручной пост без toMax в журнал не пишется: его репостер должен переслать.
 * Альбом — все message_id, не только первая.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const queryMock = vi.fn();
vi.mock('@/lib/database', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

const maxText = vi.fn(async () => ({ ok: true }));
const maxPhoto = vi.fn(async () => ({ ok: true }));
vi.mock('@/lib/notifications/max-channel', () => ({
  maxPostToChannel: (...args: unknown[]) => maxText(...args),
  maxPostPhotoToChannel: (...args: unknown[]) => maxPhoto(...args),
}));

vi.mock('@/lib/notifications/cover-image', () => ({
  resolveCoverImage: async () => ({ url: 'https://vedarai.ru/cover.jpg', source: 'test' }),
}));

import { postToAllChannels } from '@/lib/notifications/telegram-channel';
import { publishManualChannelPost } from '@/lib/notifications/manual-channel-post';
import { sentMessagesFromTelegramBody } from '@/lib/notifications/tg-sent-messages';
import { POST } from '@/app/api/bots/reposter/webhook/route';

const CHAT = -1005551230;
const POST_TEXT =
  'Авачинский вулкан открыт для восхождения. Выход с приюта в шесть утра, ' +
  'подъём занимает около шести часов. Регистрация в МЧС обязательна до выхода.';

const ownKeys = new Set<string>();
const actions: string[] = [];
let ownIds: string[] = [];
let failLookup = false;

function message(id: number): { message_id: number; chat: { id: number; type: string } } {
  return { message_id: id, chat: { id: CHAT, type: 'channel' } };
}

function telegramJson(url: string): { ok: boolean; description?: string; result?: unknown } {
  if (url.includes('sendMediaGroup')) {
    return { ok: true, result: [message(10), message(11), message(12)] };
  }
  if (url.includes('sendPhoto')) return { ok: true, result: message(77) };
  if (url.includes('sendMessage')) return { ok: true, result: message(5) };
  return { ok: false, description: 'unexpected method' };
}

const PIXEL = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

function installFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (!u.includes('/bot')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
        arrayBuffer: async () => PIXEL.slice().buffer,
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => telegramJson(u),
    };
  }));
}

async function webhook(post: Record<string, unknown>): Promise<{ status: number; body: { ok?: boolean; skipped?: boolean; error?: string } }> {
  const res = await POST(new NextRequest('http://localhost/api/bots/reposter/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'test-secret',
    },
    body: JSON.stringify({ update_id: 1, channel_post: post }),
  }));
  return { status: res.status, body: await res.json() as { ok?: boolean; skipped?: boolean; error?: string } };
}

beforeEach(() => {
  ownKeys.clear();
  actions.length = 0;
  ownIds = [];
  failLookup = false;
  maxText.mockClear();
  maxPhoto.mockClear();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql);
    const list = Array.isArray(params) ? params : [];
    if (text.includes('tg_channel_own_posts') && text.includes('INSERT')) {
      const chats = list[0] as string[];
      const ids = list[1] as string[];
      ownIds = ids;
      chats.forEach((chat, i) => ownKeys.add(`${chat}:${ids[i]}`));
      actions.push('own');
      return { rows: [], rowCount: ids.length };
    }
    if (text.includes('tg_channel_own_posts') && text.includes('SELECT')) {
      if (failLookup) {
        const err = new Error('connection refused');
        (err as { code?: string }).code = '57P01';
        throw err;
      }
      const key = `${list[0]}:${list[1]}`;
      const hit = ownKeys.has(key);
      return { rows: hit ? [{ hit: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (text.includes('ai_actions_log') && typeof list[0] === 'string') actions.push(list[0]);
    return { rows: [], rowCount: 0 };
  });
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_CHANNEL_ID', '@kamchatka_real');
  vi.stubEnv('REPOSTER_WEBHOOK_SECRET', 'test-secret');
  vi.stubEnv('TELEGRAM_CHANNEL_LINK', '');
  vi.stubEnv('MAX_CHANNEL_LINK', '');
  vi.stubEnv('MAX_BOT_TOKEN', '');
  vi.stubEnv('MAX_CHANNEL_ID', '');
  installFetch();
});

describe('свой пост в MAX второй раз не уходит', () => {
  it('postToAllChannels записывает id до попытки MAX, вебхук этот пост пропускает', async () => {
    const sent = await postToAllChannels({
      channelId: '@kamchatka_real',
      postType: 'admin_max',
      text: POST_TEXT,
      awaitMax: true,
    });
    expect(sent.ok).toBe(true);
    expect(ownKeys.has(`${CHAT}:5`)).toBe(true);
    expect(actions.indexOf('own')).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf('own')).toBeLessThan(actions.indexOf('max_post_failed'));

    const skipped = await webhook({
      message_id: 5,
      chat: { id: CHAT, type: 'channel' },
      date: 1,
      text: POST_TEXT,
    });
    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({ ok: true, skipped: true });
    expect(maxText).not.toHaveBeenCalled();
    expect(maxPhoto).not.toHaveBeenCalled();
  });

  it('ручку базы не подтверждает приёмом и в MAX не шлёт', async () => {
    failLookup = true;
    const res = await webhook({
      message_id: 5,
      chat: { id: CHAT, type: 'channel' },
      date: 1,
      text: POST_TEXT,
    });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(maxText).not.toHaveBeenCalled();
  });
});

describe('ручной пост без toMax пересылается', () => {
  it('id не записывается, вебхук отправляет текст в MAX', async () => {
    const published = await publishManualChannelPost({
      channel: 'travel',
      text: POST_TEXT,
      toMax: false,
    });
    expect(published.ok).toBe(true);
    expect(actions).not.toContain('own');
    expect(ownKeys.size).toBe(0);

    const forwarded = await webhook({
      message_id: 77,
      chat: { id: CHAT, type: 'channel' },
      date: 1,
      text: POST_TEXT,
    });
    expect(forwarded.status).toBe(200);
    expect(forwarded.body.ok).toBe(true);
    expect(forwarded.body.skipped).toBeUndefined();
    expect(maxText).toHaveBeenCalledTimes(1);
  });

  it('с toMax id пишется до MAX, и вебхук пост пропускает', async () => {
    const published = await publishManualChannelPost({
      channel: 'travel',
      text: POST_TEXT,
      toMax: true,
    });
    expect(published.ok).toBe(true);
    expect(ownKeys.has(`${CHAT}:77`)).toBe(true);
    await vi.waitFor(() => {
      expect(actions).toContain('max_post_failed');
    });
    expect(actions.indexOf('own')).toBeLessThan(actions.indexOf('max_post_failed'));

    maxText.mockClear();
    const skipped = await webhook({
      message_id: 77,
      chat: { id: CHAT, type: 'channel' },
      date: 1,
      photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }],
      caption: POST_TEXT,
    });
    expect(skipped.body).toEqual({ ok: true, skipped: true });
    expect(maxText).not.toHaveBeenCalled();
    expect(maxPhoto).not.toHaveBeenCalled();
  });
});

describe('альбом пишет все message_id', () => {
  it('ответ sendMediaGroup разбирается по каждому кадру', () => {
    expect(sentMessagesFromTelegramBody({
      ok: true,
      result: [message(10), message(11), message(12)],
    })).toEqual([
      { chatId: CHAT, messageId: 10 },
      { chatId: CHAT, messageId: 11 },
      { chatId: CHAT, messageId: 12 },
    ]);
  });

  it('все id альбома записаны, и каждый channel_post вебхук пропускает', async () => {
    const sent = await postToAllChannels({
      channelId: '@kamchatka_real',
      postType: 'kuzmich_tour',
      text: POST_TEXT,
      photoUrls: [
        'https://vedarai.ru/a.jpg',
        'https://vedarai.ru/b.jpg',
        'https://vedarai.ru/c.jpg',
      ],
      awaitMax: true,
    });
    expect(sent.ok).toBe(true);
    expect(sent.photo).toBe('sent');
    expect(ownIds).toEqual(['10', '11', '12']);
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('sendMediaGroup'))).toBe(true);

    for (const id of [10, 11, 12]) {
      const res = await webhook({
        message_id: id,
        chat: { id: CHAT, type: 'channel' },
        date: 1,
        photo: [{ file_id: `f${id}`, file_unique_id: `u${id}`, width: 10, height: 10 }],
      });
      expect(res.body).toEqual({ ok: true, skipped: true });
    }
    expect(maxPhoto).not.toHaveBeenCalled();

    const other = await webhook({
      message_id: 99,
      chat: { id: CHAT, type: 'channel' },
      date: 1,
      text: 'Чужой пост канала, его репостер должен переслать.',
    });
    expect(other.body.ok).toBe(true);
    expect(other.body.skipped).toBeUndefined();
    expect(maxText).toHaveBeenCalledTimes(1);
  });
});
