/**
 * Кнопка «Выполнено» под напоминанием о сроке задачи CRM (план «гид в чате»,
 * шаг 9) — форма payload, разбор, подписи и тексты ответа. Без базы и сети:
 * модуль читают и напоминание (lib/crm/reminders), и классификатор нажатий
 * MAX (lib/max/verified-press, через который его читает и мозг Кузьмича).
 * Само действие — lib/crm/chat-task-action.
 *
 *   `tk:d:<uuid задачи>` — отметить задачу выполненной.
 *
 * В payload только номер задачи. Кнопка — в одно касание, без вопроса «Да /
 * Не надо», как у брони: у задачи нет ни денег, ни письма туристу, ни ПД
 * туриста, и отметку партнёр снимает в кабинете так же, как ставит.
 *
 * Кнопка живёт только в MAX: напоминание идёт через `sendPdAlert`, а он
 * кнопки-действия из заглушки Telegram выбрасывает. В Telegram задача
 * отмечается в кабинете или словами помощнику (`crm_complete_task`).
 */

export const TASK_PRESS_PREFIX = 'tk:';

const TASK_DONE = /^tk:d:(.+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTaskPressPayload(payload: string): boolean {
  return payload.startsWith(TASK_PRESS_PREFIX);
}

export function taskDonePayload(taskId: string): string {
  return `tk:d:${taskId}`;
}

/** null — не наша кнопка или испорченный payload. */
export function parseTaskPress(payload: string): { taskId: string } | null {
  const m = TASK_DONE.exec(payload);
  const id = (m?.[1] ?? '').toLowerCase();
  return m && UUID.test(id) ? { taskId: id } : null;
}

/** Подпись задачи на кнопке, когда задач под напоминанием несколько. */
const TASK_REF_MAX = 24;

function clipRef(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return t.length > TASK_REF_MAX ? `${t.slice(0, TASK_REF_MAX - 1).trimEnd()}…` : t;
}

/**
 * Кнопка под задачей. `n` — номер строки в напоминании, когда задач в нём
 * несколько: два «Перезвонить» различает только номер. Задача одна — просто
 * «Выполнено». Подпись — текст кнопки, не HTML: экранировать нечего.
 */
export function taskDoneButton(task: { id: string; title: string }, n: number | null): { text: string; payload: string } {
  return {
    text: n === null ? 'Выполнено' : `Выполнено: ${n}. ${clipRef(task.title)}`,
    payload: taskDonePayload(task.id),
  };
}

/** Ответы бота на нажатие. Заголовок задачи вставляет вызывающий, экранированным. */
export const TASK_PRESS_TEXT = {
  unknownButton: 'Кнопка не распознана — задача не отмечена.',
  notDialog: 'Задачу кнопкой отмечают в личном диалоге с ботом. Здесь ничего не отмечено.',
  notBound: 'Этот чат не подключён к кабинету — задачу не отметил.',
  notFound: 'Задача не найдена среди ваших — ничего не отмечено.',
  dbFailed: 'База не ответила — задача не отмечена. Отметьте её в кабинете, раздел «Задачи», или нажмите кнопку позже.',
  doneUnchecked: 'Это нажатие ничего не отметило, а отмечена ли задача раньше, проверить не удалось — база не ответила. '
    + 'Посмотрите в кабинете, раздел «Задачи».',
  done: (title: string) => `Задача «${title}» отмечена выполненной.`,
  already: (title: string) => `Задача «${title}» уже отмечена выполненной — ничего не изменено.`,
} as const;
