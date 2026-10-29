/**
 * Команды бота в одном чате партнёра. Общий список бота не трогаем:
 * турист по-прежнему видит свои команды, партнёр — свои, в своём чате.
 * Отказ установки не отменяет привязку.
 *
 * Туроператор — команды его постоянной клавиатуры (`OPERATOR_COMMANDS`).
 * Гид — команды его вкладок и «Ещё» (`roleChatCommands`): из тех же кнопок,
 * что под ответом и в «Ещё», поэтому команды без кнопки не бывает, и наоборот.
 * «Ещё» команды не имеет: это не раздел, а список кнопок.
 * Каждую команду строки выполняет tryRoleMenuTelegramMessage.
 */

import { OPERATOR_COMMANDS } from '@/lib/telegram/operator-desk';
import type { MenuButton } from '@/lib/roles/chat-menu';

export type ChatCommand = { command: string; description: string };

/** Код действия кнопки меню (`rm:<роль>:<действие>`) → команда чата. Сводки командой нет: она словом «/сводка» и только в MAX. */
const COMMAND_OF_ACTION: Readonly<Record<string, string>> = {
  in: 'requests',
  tk: 'tasks',
  cl: 'clients',
  bk: 'bookings',
  tr: 'tours',
  hp: 'help',
};

/** Команды по строке меню роли: то же название, что на кнопке. */
export function roleChatCommands(menu: readonly MenuButton[]): ChatCommand[] {
  const out: ChatCommand[] = [];
  for (const b of menu) {
    const code = /^rm:[a-z]{2}:([a-z]{2})$/.exec(b.payload)?.[1];
    const command = code ? COMMAND_OF_ACTION[code] : undefined;
    if (command) out.push({ command, description: b.text });
  }
  return out;
}

export async function setRoleChatCommands(chatId: number, commands: readonly ChatCommand[]): Promise<void> {
  if (commands.length === 0) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[telegram/commands] TELEGRAM_BOT_TOKEN не задан — команды чата партнёра не поставлены');
    return;
  }
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    const res = await fetch(`${base}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands,
        scope: { type: 'chat', chat_id: chatId },
      }),
    });
    if (!res.ok) {
      console.error('[telegram/commands] setMyCommands HTTP', res.status);
    }
  } catch (err) {
    console.error('[telegram/commands] setMyCommands не выполнен', err instanceof Error ? err.message : err);
  }
}

export async function setOperatorChatCommands(chatId: number): Promise<void> {
  await setRoleChatCommands(chatId, OPERATOR_COMMANDS);
}
