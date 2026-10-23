/**
 * Команды бота Кузьмича в MAX — подсказки, которые MAX показывает при вводе
 * «/» (вопрос владельца 23.10: «почему при переходе по кнопке max в чате
 * макс нет команды /start»).
 *
 * Telegram-боту список команд ставит setMyCommands при настройке вебхука
 * (app/api/telegram/setup-webhook). MAX-боту его не ставил никто: метод у MAX
 * свой — `PATCH /me/commands` на platform-api2.max.ru
 * (dev.max.ru/docs-api/methods/PATCH/me/commands, до 32 команд, пустой массив
 * снимает все). Ставит его крон самолечения бота (/api/cron/max-webhook) —
 * тот же, что держит подписку: список приезжает после выката с первым
 * прогоном и возвращается, если его сняли.
 *
 * Список — ровно те команды, что понимает processMessage (lib/kuzmich/core):
 * /start, /help, /reset. Подсказка команды, которой бот не знает, — обещание
 * без исполнителя (CLAUDE.md, правило 10.09); сторож зовёт каждую команду
 * настоящим processMessage (tests/unit/max-start-link.test.ts).
 */

import { maxFetch } from '@/lib/max/max-fetch';

const MAX_API_BASE = 'https://platform-api2.max.ru';

export interface MaxBotCommand {
  name: string;
  description: string;
}

export const MAX_BOT_COMMANDS: readonly MaxBotCommand[] = [
  { name: 'start', description: 'Начать: что умеет Кузьмич и темы' },
  { name: 'help', description: 'Подсказки: туры, маршруты, безопасность' },
  { name: 'reset', description: 'Очистить историю разговора' },
];

/** Исход установки: «поставлен» засчитывается по ответу MAX, отказ называет причину без токена. */
export type MaxBotCommandsOutcome = { state: 'ok' } | { state: 'failed'; reason: string };

function namesOf(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  return list.map((c) => (c && typeof c === 'object' ? String((c as { name?: unknown }).name ?? '') : ''));
}

/**
 * Поставить список команд бота. Отказ не глушится: причина — в лог и в исход
 * (§4.0), вызывающий решает, что с ним делать.
 */
export async function syncMaxBotCommands(token: string): Promise<MaxBotCommandsOutcome> {
  let reason: string;
  try {
    const res = await maxFetch(`${MAX_API_BASE}/me/commands`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ commands: MAX_BOT_COMMANDS }),
    });
    const body: unknown = await res.json().catch(() => null);
    const data = body && typeof body === 'object' ? (body as { success?: unknown; message?: unknown; commands?: unknown }) : {};
    if (!res.ok) {
      reason = `HTTP ${res.status}${typeof data.message === 'string' ? `: ${data.message.slice(0, 120)}` : ''}`;
    } else if (data.success === false) {
      reason = `MAX ответил success: false${typeof data.message === 'string' ? ` (${data.message.slice(0, 120)})` : ''}`;
    } else {
      // Ответ MAX — список команд бота; если он пришёл, он обязан совпасть с нашим.
      const got = namesOf(data.commands);
      const want = MAX_BOT_COMMANDS.map((c) => c.name);
      if (got === null || got.join(',') === want.join(',')) return { state: 'ok' };
      reason = `MAX вернул другой список команд: ${got.join(', ') || '(пусто)'}`;
    }
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    reason = [code, err instanceof Error ? err.message : String(err)].filter(Boolean).join(': ').slice(0, 200);
  }
  console.error(`[max/bot-commands] команды бота не поставлены: ${reason}`);
  return { state: 'failed', reason };
}
