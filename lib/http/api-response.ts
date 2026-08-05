/**
 * Чтение ответа API без падения на пустом теле.
 *
 * Живой случай 05.08: владелец правил тур в кабинете и получил
 * «Failed to execute 'json' on 'Response': Unexpected end of JSON input».
 * Это не ошибка сервера — это ошибка ЧТЕНИЯ ответа: клиент звал `res.json()`
 * до проверки `res.ok`, а роут упал и вернул пустое тело. Настоящая причина
 * (отказ Postgres) до человека не доехала вовсе: он увидел исключение
 * браузера вместо «почему не сохранилось».
 *
 * Пустой ответ — сам по себе факт, и его надо назвать вслух: пятисотка без
 * тела, обрыв прокси, слишком большой запрос. Молчание сервера нельзя
 * показывать как молчание интерфейса.
 */

/** Конверт, в котором наши роуты отдают ошибки. */
interface ErrorEnvelope {
  error?: unknown;
  reason?: unknown;
  details?: { fieldErrors?: Record<string, string[]> };
}

function fieldErrorsText(details: ErrorEnvelope['details']): string {
  const entries = Object.entries(details?.fieldErrors ?? {});
  const parts = entries
    .map(([field, msgs]) => (msgs?.[0] ? `${field}: ${msgs[0]}` : null))
    .filter((s): s is string => s !== null);
  return parts.join('; ');
}

/**
 * Возвращает разобранное тело либо человеческое объяснение отказа.
 * Никогда не бросает: любой ответ описуем словами.
 */
export async function readApiResponse<T = unknown>(
  res: Response,
): Promise<{ data: T | null; error: string | null }> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { data: null, error: `Ответ сервера не удалось прочитать (HTTP ${res.status}).` };
  }

  if (text.trim() === '') {
    return {
      data: null,
      error: res.ok
        ? `Сервер вернул пустой ответ (HTTP ${res.status}).`
        : `Сервер вернул пустой ответ (HTTP ${res.status}) — запрос не выполнен. Причина в логах сервера.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // HTML страницы ошибки от прокси или платформы — показываем начало, а не
    // всю верстку: человеку нужен статус и первые слова, остальное шум.
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    return { data: null, error: `Сервер ответил не в формате JSON (HTTP ${res.status}): ${head}` };
  }

  if (!res.ok) {
    const env = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as ErrorEnvelope;
    let message = typeof env.error === 'string' && env.error ? env.error : `Ошибка сервера (HTTP ${res.status})`;
    const fields = fieldErrorsText(env.details);
    if (fields) message += ` (${fields})`;
    if (typeof env.reason === 'string' && env.reason) message += ` — ${env.reason}`;
    return { data: null, error: message };
  }

  return { data: parsed as T, error: null };
}
