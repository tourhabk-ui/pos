/**
 * События, на которые подписан бот MAX.
 *
 * Откуда список. Документация MAX (dev.max.ru, страница «Получение ID чата
 * или канала», снята 23.11.2026): готового списка чатов нет, GET /chats
 * не поддерживается с июня 2026, chat_id приходит в Update — через
 * POST /subscriptions или GET /updates — на события вроде bot_added и
 * bot_started. Убирать чат документация предлагает на соответствующем
 * событии, пример — bot_removed. Название чата — событие chat_title_changed
 * (объект Update: chat_id и title). Те же имена событий есть в типах
 * @maxhub/max-bot-api 1.1.0 (UpdateType).
 *
 * message_created и message_callback уже были в подписке: у них chat_id
 * лежит в message.recipient (типы MessageRecipient библиотеки).
 *
 * POST /subscriptions этими типами добавляет события к уже стоящей
 * подписке (changelog MAX: «чтобы добавить новые события, используйте
 * POST /subscriptions»). Чего в ответе GET нет — подписка не считается
 * полной: «не вижу список» не равно «список тот, что нужен».
 */

export const MAX_BOT_UPDATE_TYPES = [
  'bot_started',
  'message_created',
  'message_callback',
  'bot_added',
  'bot_removed',
  'chat_title_changed',
] as const;

export type MaxBotUpdateType = (typeof MAX_BOT_UPDATE_TYPES)[number];

/** В списке подписки есть все события, без которых бот не узнает свои чаты. */
export function subscriptionCoversBotChats(updateTypes: unknown): boolean {
  if (!Array.isArray(updateTypes)) return false;
  const got = new Set(updateTypes.filter((x): x is string => typeof x === 'string'));
  return MAX_BOT_UPDATE_TYPES.every((t) => got.has(t));
}
