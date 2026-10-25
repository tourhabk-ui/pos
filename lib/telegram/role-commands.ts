/**
 * Команды бота в одном чате туроператора. Общий список бота не трогаем:
 * турист по-прежнему видит свои команды, оператор — свои, в своём чате.
 * Отказ установки не отменяет привязку.
 */

import { OPERATOR_COMMANDS } from '@/lib/telegram/operator-desk';

export async function setOperatorChatCommands(chatId: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('[telegram/commands] TELEGRAM_BOT_TOKEN не задан — команды чата оператора не поставлены');
    return;
  }
  const base = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  try {
    const res = await fetch(`${base}/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: OPERATOR_COMMANDS,
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
