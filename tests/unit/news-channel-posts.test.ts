/**
 * Ручной пост и репостер ставят в каждый канал ссылку на СВОЙ канал (слово
 * владельца 28.11). Ни ручной пост, ни вебхук репостера не идут через
 * crossLinkedTexts: если бы правило стояло только там, в MAX уезжал бы
 * t.me/kamchatka_real. Проверка — вызовом: что ушло в Telegram и что в MAX.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ORGANIZATION_PROFILES } from '@/lib/seo/organization-profiles';

const TG = ORGANIZATION_PROFILES.telegramChannel;
const MAX = ORGANIZATION_PROFILES.maxChannel;

let tgDuplicate = false;
const queryMock = vi.fn(async (sql: unknown) => {
  const text = String(sql);
  if (tgDuplicate && text.includes("action_type = 'manual_channel_post'")) return { rows: [{ hit: 1 }], rowCount: 1 };
  if (text.includes('tg_channel_own_posts') && text.includes('SELECT')) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
});
vi.mock('@/lib/database', () => ({ query: (sql: unknown, params?: unknown) => queryMock(sql, params) }));

vi.mock('@/lib/notifications/cover-image', () => ({
  resolveCoverImage: async () => ({ url: 'https://vedarai.ru/cover.jpg', source: 'test' }),
}));

/** Что ушло в канал MAX ручным постом (maxChannelPost → maxFetch). */
const maxSent: string[] = [];
vi.mock('@/lib/max/max-fetch', () => ({
  maxFetch: async (_url: unknown, init?: { body?: unknown }) => {
    maxSent.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
    return new Response(JSON.stringify({ message: { body: { mid: 'm1' } } }));
  },
}));

/** Что ушло в канал MAX репостером. */
const reposted: string[] = [];
vi.mock('@/lib/notifications/max-channel', () => ({
  maxPostToChannel: async (text: string) => { reposted.push(text); return { ok: true }; },
  maxPostPhotoToChannel: async (_url: string, caption: string) => { reposted.push(caption); return { ok: true }; },
}));

/**
 * Что ушло в Telegram: тело запроса Bot API целиком (подпись лежит в caption,
 * text или в media альбома — где именно, тесту не важно).
 */
const tgSent: string[] = [];
function bodyText(body: unknown): string {
  if (body instanceof FormData) {
    return [...body.values()].filter((v): v is string => typeof v === 'string').join('\n');
  }
  return typeof body === 'string' ? body : '';
}

import { publishManualChannelPost } from '@/lib/notifications/manual-channel-post';
import { POST } from '@/app/api/bots/reposter/webhook/route';

const TEXT =
  'Авачинский открыт для восхождения, выход с приюта в шесть утра. '
  + 'Наш канал в Telegram: https://t.me/kamchatka_real, разбор недели — https://t.me/kamchatka_real/444. '
  + 'Канал в MAX для тех, кто там: https://max.ru/id4101147649_biz';

beforeEach(() => {
  tgDuplicate = false;
  maxSent.length = 0;
  reposted.length = 0;
  tgSent.length = 0;
  queryMock.mockClear();
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_CHANNEL_ID', '@kamchatka_real');
  vi.stubEnv('MAX_BOT_TOKEN', 'max-test-token');
  vi.stubEnv('MAX_CHANNEL_ID', '-100');
  vi.stubEnv('MAX_CHANNEL_LINK', '');
  vi.stubEnv('TELEGRAM_CHANNEL_LINK', '');
  vi.stubEnv('REPOSTER_WEBHOOK_SECRET', 'test-secret');
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url);
    if (!u.includes('/bot')) {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: false }));
    tgSent.push(bodyText(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: -1005551230, type: 'channel' } } }));
  }));
});

describe('ручной пост: каждому каналу — свой канал', () => {
  it('в Telegram корень канала MAX — Telegram-каналом; в MAX корень Telegram — каналом MAX, пост 444 как был', async () => {
    const published = await publishManualChannelPost({ channel: 'travel', text: TEXT, toMax: true });
    expect(published.ok).toBe(true);
    await vi.waitFor(() => expect(maxSent).toHaveLength(1));

    expect(tgSent).toHaveLength(1);
    expect(tgSent[0]).toContain('Наш канал в Telegram: https://t.me/kamchatka_real,');
    expect(tgSent[0]).toContain(`для тех, кто там: ${TG}`);
    expect(tgSent[0]).not.toContain(MAX);

    expect(maxSent[0]).toContain(`Наш канал в MAX: ${MAX},`);
    expect(maxSent[0]).toContain('разбор недели — https://t.me/kamchatka_real/444.');
    expect(maxSent[0]).not.toMatch(/t\.me\/kamchatka_real(?!\/444)/);
  });

  it('альбом и видео в Telegram — тоже с Telegram-каналом', async () => {
    for (const extra of [
      { photos: ['/images/a.jpg', '/images/b.jpg'] },
      { video: '/media/clip.mp4' },
    ]) {
      tgSent.length = 0;
      const published = await publishManualChannelPost({ channel: 'travel', text: TEXT, ...extra });
      expect(published.ok).toBe(true);
      expect(tgSent.length).toBeGreaterThan(0);
      expect(tgSent.join('\n')).toContain(`для тех, кто там: ${TG}`);
      expect(tgSent.join('\n')).not.toContain(MAX);
    }
  });

  it('догонка MAX у поста, уже вышедшего в Telegram, — тоже со ссылкой на канал MAX', async () => {
    tgDuplicate = true;
    const published = await publishManualChannelPost({ channel: 'travel', text: TEXT, toMax: true });
    expect(published).toEqual({ ok: true, duplicate: true });
    expect(tgSent).toHaveLength(0);
    expect(maxSent).toHaveLength(1);
    expect(maxSent[0]).toContain(`Наш канал в MAX: ${MAX},`);
    expect(maxSent[0]).not.toMatch(/t\.me\/kamchatka_real(?!\/444)/);
  });
});

async function webhook(post: Record<string, unknown>): Promise<number> {
  const res = await POST(new NextRequest('http://localhost/api/bots/reposter/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'test-secret' },
    body: JSON.stringify({ update_id: 1, channel_post: { message_id: 5, chat: { id: -1005551230, type: 'channel' }, date: 1, ...post } }),
  }));
  return res.status;
}

describe('репостер: в MAX уходит текст со ссылкой на канал MAX', () => {
  const TG_POST = 'Новости края. Наш канал в Telegram: https://t.me/kamchatka_real. Вчера: https://t.me/kamchatka_real/910';
  const EXPECTED = `Новости края. Наш канал в MAX: ${MAX}. Вчера: https://t.me/kamchatka_real/910`;

  it('текстовый пост', async () => {
    expect(await webhook({ text: TG_POST })).toBe(200);
    expect(reposted).toEqual([EXPECTED]);
  });

  it('подпись к фото', async () => {
    expect(await webhook({ photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10 }], caption: TG_POST })).toBe(200);
    expect(reposted).toEqual([EXPECTED]);
  });

  it('подпись к видео', async () => {
    expect(await webhook({ video: { file_id: 'v' }, caption: TG_POST })).toBe(200);
    expect(reposted).toEqual([EXPECTED]);
  });
});
