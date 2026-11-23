/**
 * Чаты бота MAX, которые мы видели сами.
 *
 * GET /chats снят (dev.max.ru, июнь 2026; @maxhub/max-bot-api 1.0 убрал
 * getAllChats). Документация говорит хранить chat_id из Update и удалять
 * на bot_removed. Этот модуль делает ровно это.
 *
 * Что пишется: chat_id, тип чата (dialog | chat | channel — enum ChatType
 * библиотеки и объект Chat в документации) и название. Название — только
 * из chat_title_changed: в bot_added его нет. Имя, ник и текст сообщения
 * не пишутся.
 *
 * Уже известные id, которые событие больше не пришлёт (бот в чате давно,
 * bot_added повторно не приходит):
 *   - partners.max_chat_id, operator_members.max_chat_id,
 *     operator_staff.max_chat_id — миграция, один раз;
 *   - MAX_CHANNEL_ID и значения REPOSTER_ROUTES — при чтении списка,
 *     потому что это окружение, а не строка базы.
 * Личные chat_id гостей (leads.guest_max_chat_id и stay_requests) сюда
 * не копируются: список читает админ, чтобы сопоставить каналы, а не
 * чтобы получить новую выгрузку диалогов туристов.
 *
 * Под vitest запись не ходит в пул. Юнит-CI задаёт DATABASE_URL на
 * localhost без сервера; запрос из каждого теста вебхука ждал бы таймаут
 * пула. Тест самой записи снимает VITEST и подменяет пул.
 */

import { pool } from '@/lib/db-pool';

const CHAT_TYPES = ['dialog', 'chat', 'channel'] as const;
export type MaxChatType = (typeof CHAT_TYPES)[number];

export type ChatMemory =
  | { action: 'remember'; chatId: number; chatType: MaxChatType | null; title: string | null }
  | { action: 'forget'; chatId: number }
  | { action: 'ignore' };

export interface RememberedMaxChat {
  chat_id: number;
  title: string | null;
  type: MaxChatType | null;
}

export interface ConfiguredMaxChatIds {
  ids: number[];
  /** MAX_CHANNEL_ID задан, но это не целое число. */
  channelUnreadable: boolean;
  /** REPOSTER_ROUTES задан, но это не JSON-объект чисел. */
  routesUnreadable: boolean;
}

const TITLE_MAX = 500;

export function asChatId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

function asChatType(value: unknown): MaxChatType | null {
  return typeof value === 'string' && (CHAT_TYPES as readonly string[]).includes(value)
    ? value as MaxChatType
    : null;
}

function asTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, TITLE_MAX);
}

function recipientOf(update: Record<string, unknown>): { chatId: number; chatType: MaxChatType | null } | null {
  const message = update.message;
  if (!message || typeof message !== 'object') return null;
  const recipient = (message as Record<string, unknown>).recipient;
  if (!recipient || typeof recipient !== 'object') return null;
  const rec = recipient as Record<string, unknown>;
  const chatId = asChatId(rec.chat_id);
  if (chatId === null) return null;
  return { chatId, chatType: asChatType(rec.chat_type) };
}

/**
 * Что сделать с апдейтом. Поля — только те, что названы в документации и
 * в типах библиотеки. user, текст и payload не читаются.
 * link.chat_id — чат пересланного сообщения, не наш: не берём.
 */
export function chatMemoryFromUpdate(update: unknown): ChatMemory {
  if (!update || typeof update !== 'object') return { action: 'ignore' };
  const row = update as Record<string, unknown>;
  const kind = row.update_type;

  if (kind === 'bot_removed') {
    const chatId = asChatId(row.chat_id);
    return chatId === null ? { action: 'ignore' } : { action: 'forget', chatId };
  }

  if (kind === 'bot_added') {
    const chatId = asChatId(row.chat_id);
    if (chatId === null) return { action: 'ignore' };
    // Документация: is_channel true — бот добавлен в канал, а не в чат.
    const chatType = row.is_channel === true ? 'channel' : row.is_channel === false ? 'chat' : null;
    return { action: 'remember', chatId, chatType, title: null };
  }

  if (kind === 'chat_title_changed') {
    const chatId = asChatId(row.chat_id);
    if (chatId === null) return { action: 'ignore' };
    return { action: 'remember', chatId, chatType: null, title: asTitle(row.title) };
  }

  if (kind === 'bot_started') {
    const chatId = asChatId(row.chat_id);
    if (chatId === null) return { action: 'ignore' };
    // В примере bot_started нет is_channel и нет типа. Не выводим «диалог».
    return { action: 'remember', chatId, chatType: null, title: null };
  }

  if (kind === 'message_created' || kind === 'message_callback') {
    const recipient = recipientOf(row);
    if (!recipient) return { action: 'ignore' };
    return { action: 'remember', chatId: recipient.chatId, chatType: recipient.chatType, title: null };
  }

  return { action: 'ignore' };
}

export function configuredMaxChatIds(env: NodeJS.ProcessEnv = process.env): ConfiguredMaxChatIds {
  const ids: number[] = [];
  let channelUnreadable = false;
  let routesUnreadable = false;

  const channel = env.MAX_CHANNEL_ID?.trim();
  if (channel) {
    const id = asChatId(channel);
    if (id === null) channelUnreadable = true;
    else ids.push(id);
  }

  const raw = env.REPOSTER_ROUTES?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
      routesUnreadable = true;
    }
    if (!routesUnreadable) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        routesUnreadable = true;
      } else {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          const id = asChatId(value);
          if (id === null) {
            routesUnreadable = true;
            continue;
          }
          ids.push(id);
        }
      }
    }
  }

  return { ids: [...new Set(ids)], channelUnreadable, routesUnreadable };
}

const REMEMBER_SQL = `INSERT INTO max_bot_chats (chat_id, chat_type, title)
VALUES ($1::bigint, $2::text, $3::text)
ON CONFLICT (chat_id) DO UPDATE SET
  chat_type = COALESCE(EXCLUDED.chat_type, max_bot_chats.chat_type),
  title = COALESCE(EXCLUDED.title, max_bot_chats.title),
  last_event_at = NOW()`;

function persistSkipped(): boolean {
  return process.env.VITEST === 'true';
}

function logWriteFailure(action: 'remember' | 'forget', err: unknown): void {
  const code = typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : '';
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[max/bot-chats] не записал чат (${action}${code ? `, ${code}` : ''}): ${message}`);
}

/** Запомнить или забыть чат. Отказ базы не бросает: ответ туристу важнее списка. */
export async function applyChatMemory(update: unknown): Promise<'remembered' | 'forgotten' | 'ignored' | 'skipped' | 'failed'> {
  if (persistSkipped()) return 'skipped';
  const memory = chatMemoryFromUpdate(update);
  if (memory.action === 'ignore') return 'ignored';
  try {
    if (memory.action === 'forget') {
      await pool.query('DELETE FROM max_bot_chats WHERE chat_id = $1::bigint', [memory.chatId]);
      return 'forgotten';
    }
    await pool.query(REMEMBER_SQL, [memory.chatId, memory.chatType, memory.title]);
    return 'remembered';
  } catch (err) {
    logWriteFailure(memory.action, err);
    return 'failed';
  }
}

async function seedConfiguredChats(): Promise<void> {
  const configured = configuredMaxChatIds();
  if (configured.channelUnreadable) {
    console.error('[max/bot-chats] MAX_CHANNEL_ID задан, но это не целое число — в список чатов не попал');
  }
  if (configured.routesUnreadable) {
    console.error('[max/bot-chats] REPOSTER_ROUTES не разобран как объект chat_id — значения в список не попали');
  }
  if (configured.ids.length === 0) return;
  await pool.query(
    `INSERT INTO max_bot_chats (chat_id)
     SELECT x FROM unnest($1::bigint[]) AS t(x)
     ON CONFLICT (chat_id) DO NOTHING`,
    [configured.ids],
  );
}

/** Чаты из таблицы плюс id из окружения. Живой MAX не вызывается. */
export async function listRememberedMaxChats(): Promise<RememberedMaxChat[]> {
  await seedConfiguredChats();
  const res = await pool.query<{ chat_id: string | number; chat_type: string | null; title: string | null }>(
    'SELECT chat_id, chat_type, title FROM max_bot_chats ORDER BY chat_id',
  );
  const chats: RememberedMaxChat[] = [];
  for (const row of res.rows) {
    const chatId = asChatId(row.chat_id);
    if (chatId === null) {
      console.error('[max/bot-chats] chat_id из базы не прочитан как целое — строка в список не попала');
      continue;
    }
    chats.push({ chat_id: chatId, title: asTitle(row.title), type: asChatType(row.chat_type) });
  }
  return chats;
}
