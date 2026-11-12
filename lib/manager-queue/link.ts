/**
 * Ссылка на очередь менеджера для писем и сообщений ему (этап 3б). Очередь —
 * страница админки: по ссылке её открывает только вошедший администратор.
 */
import { getPublicBaseUrl } from '@/lib/config';

export const MANAGER_QUEUE_PATH = '/hub/admin/queue';

export function managerQueueUrl(): string {
  return `${getPublicBaseUrl()}${MANAGER_QUEUE_PATH}`;
}

/**
 * Строка под сообщением менеджеру о случае, который встал в очередь: где он
 * лежит и где поставить «Взял». Сообщению о случае, которого в очереди нет
 * («Беру», «Свободно»), строка не добавляется.
 */
export function withQueueLine(text: string, queued: boolean): string {
  return queued ? `${text}\nВ очереди менеджера — там же отметка «Взял»: ${managerQueueUrl()}` : text;
}
