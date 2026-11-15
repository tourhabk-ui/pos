/**
 * lib/kuzmich/group-prompt.ts — инструкция Кузьмича для группового чата
 * Telegram (/api/telegram/kuzmich, processGroupMessage).
 *
 * Ядро промпта то же, что на остальных поверхностях, и части по ситуации —
 * те же, что выбирает kuzmichModulesFor (#3399, п. 5; ревью безопасности
 * #3416: групповой путь собирал промпт вручную и, когда правила о заявке и
 * сроке ответа оператора ушли из ядра в часть, остался без них). Данных хода
 * группа не получает: ответ в 2-3 строки и приглашение в личку.
 */
import { KUZMICH_SYSTEM, kuzmichModulesFor } from '@/lib/kuzmich/core';

export const GROUP_CHAT_NOTE = 'Ты в групповом чате. Отвечай коротко (2-3 строки). Чтобы оставить заявку оператору, приглашай писать в личку боту.';

export function groupSystemContent(question: string, tourContext: string): string {
  const modules = kuzmichModulesFor(question, { placeFound: false });
  return [KUZMICH_SYSTEM, modules, tourContext, GROUP_CHAT_NOTE].filter(Boolean).join('\n\n');
}
