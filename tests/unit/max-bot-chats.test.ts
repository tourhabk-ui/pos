/**
 * Чаты бота MAX после снятия GET /chats.
 *
 * Бот запоминает chat_id из апдейта и забывает его на bot_removed.
 * Имя, ник и текст сообщения в запись не попадают. Незаверенный вебхук
 * не пишет ничего. Список админа читает таблицу и id из окружения,
 * а не API MAX.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const q = vi.hoisted(() => vi.fn(async () => ({ rows: [] as Array<Record<string, unknown>> })));
vi.mock('@/lib/db-pool', () => ({ pool: { query: q } }));

import {
  applyChatMemory,
  chatMemoryFromUpdate,
  configuredMaxChatIds,
  listRememberedMaxChats,
} from '@/lib/max/bot-chats';
import { maxListChats } from '@/lib/notifications/max-channel';
import { subscriptionCoversBotChats } from '@/lib/max/update-types';

const PERSON = {
  user_id: 9,
  name: 'Иван Петров',
  username: 'ivan914',
  first_name: 'Иван',
};

beforeEach(() => {
  q.mockReset();
  q.mockResolvedValue({ rows: [] });
  vi.stubEnv('VITEST', '');
  vi.stubEnv('MAX_BOT_TOKEN', 'bot-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', 'hook-key');
  vi.stubEnv('MAX_CHANNEL_ID', '');
  vi.stubEnv('REPOSTER_ROUTES', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

const sqlOf = () => q.mock.calls.map((c) => String(c[0]));
const paramsOf = () => q.mock.calls.map((c) => c[1]);

describe('что апдейт говорит о чате', () => {
  it('bot_added без user (так документация с ноября 2026) запоминает канал', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'bot_added',
      timestamp: 1,
      chat_id: -100,
      is_channel: true,
    })).toEqual({ action: 'remember', chatId: -100, chatType: 'channel', title: null });
  });

  it('bot_added в группу — тип chat, имя из user не читается', () => {
    const memory = chatMemoryFromUpdate({
      update_type: 'bot_added',
      chat_id: 15,
      is_channel: false,
      user: PERSON,
    });
    expect(memory).toEqual({ action: 'remember', chatId: 15, chatType: 'chat', title: null });
    expect(JSON.stringify(memory)).not.toContain('Иван');
    expect(JSON.stringify(memory)).not.toContain('914');
  });

  it('bot_removed забывает чат и не сохраняет человека', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'bot_removed',
      chat_id: 15,
      is_channel: false,
      user: PERSON,
    })).toEqual({ action: 'forget', chatId: 15 });
  });

  it('bot_started запоминает chat_id и не объявляет тип, которого в событии нет', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'bot_started',
      chat_id: 77,
      payload: 'login-secret',
      user: PERSON,
    })).toEqual({ action: 'remember', chatId: 77, chatType: null, title: null });
  });

  it('message_created берёт чат получателя, а не чат пересланного сообщения', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'message_created',
      message: {
        sender: PERSON,
        recipient: { chat_id: 42, chat_type: 'dialog', user_id: 9 },
        body: { mid: 'm', seq: 1, text: 'телефон +7 914 123-45-67' },
        link: { type: 'forward', chat_id: 999, message: { text: 'чужой' } },
      },
    })).toEqual({ action: 'remember', chatId: 42, chatType: 'dialog', title: null });
  });

  it('message_callback без сообщения чата не запоминает: chat_id там не назван', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'message_callback',
      callback: { callback_id: 'c', payload: 'x', user: PERSON },
    })).toEqual({ action: 'ignore' });
  });

  it('chat_title_changed запоминает название чата, не человека', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'chat_title_changed',
      chat_id: 42,
      title: '  Камчатка  ',
      user: PERSON,
    })).toEqual({ action: 'remember', chatId: 42, chatType: null, title: 'Камчатка' });
  });

  it('bot_stopped чат не удаляет: задача снимает запись на bot_removed', () => {
    expect(chatMemoryFromUpdate({ update_type: 'bot_stopped', chat_id: 77, user: PERSON })).toEqual({ action: 'ignore' });
  });

  it('неизвестный chat_type не становится типом', () => {
    expect(chatMemoryFromUpdate({
      update_type: 'message_created',
      message: { recipient: { chat_id: 3, chat_type: 'secret' }, body: { text: 'x' } },
    })).toEqual({ action: 'remember', chatId: 3, chatType: null, title: null });
  });
});

describe('запись в таблицу', () => {
  it('bot_added пишет chat_id и тип, а имя и телефон — нет', async () => {
    const outcome = await applyChatMemory({
      update_type: 'bot_added',
      chat_id: 15,
      is_channel: true,
      user: { ...PERSON, username: '+7 914 123-45-67' },
    });
    expect(outcome).toBe('remembered');
    expect(sqlOf()[0]).toContain('ON CONFLICT (chat_id)');
    expect(sqlOf()[0]).toContain('COALESCE(EXCLUDED.chat_type');
    expect(paramsOf()).toEqual([[15, 'channel', null]]);
    expect(JSON.stringify(q.mock.calls)).not.toContain('Иван');
    expect(JSON.stringify(q.mock.calls)).not.toContain('914');
  });

  it('bot_removed удаляет строку', async () => {
    expect(await applyChatMemory({ update_type: 'bot_removed', chat_id: 15, is_channel: false })).toBe('forgotten');
    expect(sqlOf()[0]).toContain('DELETE FROM max_bot_chats');
    expect(paramsOf()).toEqual([[15]]);
  });

  it('отказ базы — failed и строка в лог, без тела апдейта', async () => {
    q.mockRejectedValueOnce(Object.assign(new Error('relation "max_bot_chats" does not exist'), { code: '42P01' }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = await applyChatMemory({
      update_type: 'bot_added',
      chat_id: 15,
      is_channel: true,
      user: PERSON,
    });
    expect(outcome).toBe('failed');
    const logged = errorLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('[max/bot-chats]');
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('Иван');
  });

  it('под VITEST в базу не ходит', async () => {
    vi.stubEnv('VITEST', 'true');
    expect(await applyChatMemory({ update_type: 'bot_added', chat_id: 1, is_channel: true })).toBe('skipped');
    expect(q).not.toHaveBeenCalled();
  });
});

describe('список для админа', () => {
  it('берёт строки таблицы и id из окружения, MAX не вызывает', async () => {
    vi.stubEnv('MAX_CHANNEL_ID', '-100');
    vi.stubEnv('REPOSTER_ROUTES', JSON.stringify({ '555': 42, '777': '42' }));
    q.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('SELECT')) {
        return { rows: [
          { chat_id: '-100', chat_type: null, title: null },
          { chat_id: '42', chat_type: 'channel', title: 'Камчатка' },
        ] };
      }
      return { rows: [] };
    });
    const result = await maxListChats();
    expect(result.ok).toBe(true);
    expect(result.chats).toEqual([
      { chat_id: -100, title: null, type: null },
      { chat_id: 42, title: 'Камчатка', type: 'channel' },
    ]);
    const insert = q.mock.calls.find((c) => String(c[0]).includes('unnest'));
    expect(insert?.[1]).toEqual([[-100, 42]]);
    expect(sqlOf().join('\n')).not.toContain('getAllChats');
  });

  it('битый REPOSTER_ROUTES не затирает уже известные чаты и говорит об этом', async () => {
    vi.stubEnv('MAX_CHANNEL_ID', '5');
    vi.stubEnv('REPOSTER_ROUTES', '{не json');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    q.mockImplementation(async (sql: string) => (
      String(sql).startsWith('SELECT') ? { rows: [{ chat_id: '5', chat_type: null, title: null }] } : { rows: [] }
    ));
    const chats = await listRememberedMaxChats();
    expect(chats).toEqual([{ chat_id: 5, title: null, type: null }]);
    expect(errorLog.mock.calls.map((c) => String(c[0])).join('\n')).toContain('REPOSTER_ROUTES');
    expect(configuredMaxChatIds().routesUnreadable).toBe(true);
  });

  it('без токена бота список не выдаёт за чаты бота', async () => {
    vi.stubEnv('MAX_BOT_TOKEN', '');
    const result = await maxListChats();
    expect(result).toEqual({ ok: false, error: 'MAX_BOT_TOKEN not set' });
    expect(q).not.toHaveBeenCalled();
  });
});

describe('вебхук пишет чат только когда заверен', () => {
  const added = {
    update_type: 'bot_added',
    chat_id: 15,
    is_channel: true,
    user: PERSON,
  };

  it('запрос без ключа подписки не пишет чат', async () => {
    const { POST } = await import('@/app/api/max/kuzmich/route');
    const res = await POST(new NextRequest('http://localhost/api/max/kuzmich', {
      method: 'POST',
      body: JSON.stringify(added),
    }));
    expect(res.status).toBe(200);
    expect(q).not.toHaveBeenCalled();
  });

  it('заверенный bot_added пишет chat_id, имя в запрос не попадает', async () => {
    const { POST } = await import('@/app/api/max/kuzmich/route');
    const res = await POST(new NextRequest('http://localhost/api/max/kuzmich?s=hook-key', {
      method: 'POST',
      body: JSON.stringify(added),
    }));
    expect(res.status).toBe(200);
    expect(paramsOf()).toEqual([[15, 'channel', null]]);
    expect(JSON.stringify(q.mock.calls)).not.toContain('Иван');
    expect(JSON.stringify(q.mock.calls)).not.toContain('ivan914');
  });

  it('заверенный bot_removed стирает чат', async () => {
    const { POST } = await import('@/app/api/max/kuzmich/route');
    await POST(new NextRequest('http://localhost/api/max/kuzmich?s=hook-key', {
      method: 'POST',
      body: JSON.stringify({ update_type: 'bot_removed', chat_id: 15, is_channel: true, user: PERSON }),
    }));
    expect(sqlOf()[0]).toContain('DELETE FROM max_bot_chats');
    expect(paramsOf()[0]).toEqual([15]);
  });
});

describe('подписка покрывает события чатов', () => {
  it('старые три события — не покрывают, полный список и лишние сверх него — покрывают', () => {
    expect(subscriptionCoversBotChats(['bot_started', 'message_created', 'message_callback'])).toBe(false);
    expect(subscriptionCoversBotChats(undefined)).toBe(false);
    expect(subscriptionCoversBotChats([
      'bot_started', 'message_created', 'message_callback', 'bot_added', 'bot_removed', 'chat_title_changed', 'message_edited',
    ])).toBe(true);
  });
});
