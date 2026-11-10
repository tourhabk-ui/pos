/**
 * Отправка формы `/register`: включить контроль возвращения, затем взять лист
 * с данными группы. Без React и без базы — чтобы исходы проверялись вызовом.
 *
 * Два шага неравноправны. Первый включает контроль: его отказ — отказ формы.
 * Второй только отдаёт файл и ничего не записывает: его отказ НЕ отменяет уже
 * включённый контроль. До 10.11 оба стояли под одним `catch`: связь пропадала
 * между запросами, человек читал «Ошибка сети», не получал ссылки «Я
 * вернулся» — а контроль был включён, и после срока сторож будил его контакт
 * (ревью волны 0, docs/safety/MCHS_PLAN.md).
 */

export const REGISTER_ENDPOINT = '/api/safety/register';

/**
 * chat_id Telegram — целое число (у групп отрицательное), либо пусто. Одно
 * правило на форму и на сервер: колонка — bigint, и имя с «@» база не примет.
 * 18 цифр — заведомо внутри bigint.
 */
export const TELEGRAM_CHAT_ID = /^(-?\d{1,18})?$/;

/** Адрес формы с подставленным названием маршрута — им ходит карточка маршрута. */
export function registerFormHref(routeName: string): string {
  const name = routeName.trim().slice(0, 200);
  return name ? `/register?${new URLSearchParams({ name }).toString()}` : '/register';
}

export const REGISTER_SUBMIT_TEXT = {
  /**
   * Ответа нет вовсе: включён ли контроль — неизвестно, и это третий исход, а
   * не «не включён». Повтор без правок безопасен: сервер узнаёт свою запись.
   */
  noAnswer:
    'Связь оборвалась, ответа нет: включён ли контроль — неизвестно. ' +
    'Отправьте форму ещё раз, не меняя данных, — второй записи не появится.',
  badAnswer: 'Сервер ответил не по форме. Контроль возвращения не включён — повторите через минуту.',
  notSaved: 'Контроль возвращения не включён: сервер не принял форму.',
} as const;

export type RegisterSubmitResult =
  | { ok: true; registrationId: string; /** Лист; `null` — не отдан или не дошёл, контроль при этом включён. */ sheet: Blob | null }
  | { ok: false; error: string };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

function post(fetchImpl: Fetch, url: string, payload: unknown): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function submitTripWatchForm(
  payload: unknown,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<RegisterSubmitResult> {
  let res: Response;
  try {
    res = await post(fetchImpl, REGISTER_ENDPOINT, payload);
  } catch (err) {
    console.error('[register] запрос не дошёл или ответ не получен:', err instanceof Error ? err.name : 'unknown');
    return { ok: false, error: REGISTER_SUBMIT_TEXT.noAnswer };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    console.error('[register] ответ не разобран, статус', res.status, err instanceof Error ? err.name : 'unknown');
    return { ok: false, error: REGISTER_SUBMIT_TEXT.badAnswer };
  }
  const body = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const id = typeof body.registration_id === 'string' ? body.registration_id : '';
  if (!res.ok || body.success !== true || !id) {
    const said = typeof body.error === 'string' && body.error.trim() ? body.error.trim() : '';
    return { ok: false, error: said || REGISTER_SUBMIT_TEXT.notSaved };
  }

  // Контроль включён. Всё, что ниже, его не отменяет.
  let sheet: Blob | null = null;
  try {
    const pdfRes = await post(fetchImpl, `${REGISTER_ENDPOINT}?pdf=1`, payload);
    if (pdfRes.ok) sheet = await pdfRes.blob();
    else console.error('[register] лист не отдан, статус', pdfRes.status);
  } catch (err) {
    console.error('[register] лист не получен:', err instanceof Error ? err.name : 'unknown');
  }
  return { ok: true, registrationId: id, sheet };
}
