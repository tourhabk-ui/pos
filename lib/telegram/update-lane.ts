/**
 * Очередь апдейтов Telegram по чату.
 *
 * Вебхук держал соединение, пока Кузьмич ходил в модель (потолок — десятки
 * секунд). Прокси обрывал ответ раньше, Bot API считал доставку неудачной и
 * присылал следующий апдейт, пока предыдущий ещё писал ответ. Повтор того же
 * update_id отсекает lib/telegram/update-dedup, но следующий апдейт — другой
 * id: два хода одного чата шли сразу, и готовый ответ уезжал не на тот вопрос.
 * /start, стоявший за длинным ходом, доходил только со следующим сообщением.
 *
 * Здесь ход чата ждёт предыдущий. Вебхук отвечает 200 сразу (в тестах ждёт
 * конец хода — иначе отправку нечем судить). Повтор уже принятого update_id
 * в очередь не ставится: его отсекает дедуп до этой функции.
 */

const tails = new Map<string, Promise<void>>();

export function telegramChatKey(update: {
  message?: { chat?: { id?: number } };
  callback_query?: { message?: { chat?: { id?: number } }; from?: { id?: number } };
}): string {
  const id = update.message?.chat?.id
    ?? update.callback_query?.message?.chat?.id
    ?? update.callback_query?.from?.id;
  return id === undefined ? 'no-chat' : String(id);
}

/** Следующий ход этого чата начнётся после предыдущего, даже если тот упал. */
export function enqueueTelegramChat(key: string, job: () => Promise<void>): Promise<void> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(() => job(), () => job());
  const tracked = run.finally(() => {
    if (tails.get(key) === tracked) tails.delete(key);
  });
  tails.set(key, tracked);
  return tracked;
}

/**
 * В прогоне тестов вебхук дожидается хода: проверка читает то, что ушло
 * человеку. На сервере — нет: 200 уходит сразу, и Bot API не повторяет
 * апдейт из-за долгой модели.
 */
export function webhookAwaitsHandler(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === 'true';
}
