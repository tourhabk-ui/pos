/**
 * Отказы провайдеров, которые ЛГУТ о причине.
 *
 * Повод — слова владельца 04.09: «XAI_API_KEY геоблок». Проба с прода
 * получает от api.x.ai `{"code":"invalid-argument","error":"Incorrect API key
 * provided..."}` — провайдер отвечает про КЛЮЧ там, где дело в адресе
 * запроса. Такой ответ хуже молчания: он посылает человека перевыпускать
 * исправный ключ, и вечер уходит впустую. Ровно это и случилось: в разборе
 * 04.09 xAI был записан как «ключ недействителен», пока владелец не поправил.
 *
 * Здесь НЕ приговор, а поправка. Диагностика по-прежнему печатает ответ
 * провайдера дословно и ДОБАВЛЯЕТ к нему известное; сама заметка называет,
 * откуда она взялась и чем не является. Снять строку может только замер: тот
 * же ключ, отправленный из места без гео-блока. Пока замера нет, здесь стоит
 * свидетельство, а не факт, и оно так и подписано.
 */

export interface RefusalNote {
  /** Провайдер, как он назван в диагностике. */
  provider: string;
  /** Признак в ответе: код и/или кусок тела. */
  match: (status: number | null, body: string) => boolean;
  /** Что об этом известно и откуда. */
  note: string;
}

const NOTES: RefusalNote[] = [
  {
    provider: 'xai',
    match: (status, body) => status !== null && status >= 400 && /incorrect api key|invalid.?argument/i.test(body),
    note: 'У этого ответа ДВА кандидата, и текст провайдера не различает их: гео-отказ по адресу '
      + 'запроса (слова владельца 04.09) либо вопрос к ключу или счёту (кредиты в консоли x.ai '
      + 'отдельны от подписки SuperGrok). Различает их строка xai:reachability в этой же выдаче: '
      + 'проба без ключа говорит о ДОРОГЕ. Пока она не прочитана, ключ не перевыпускать.',
  },
  {
    provider: 'gemini',
    match: (status, body) => status === 400 && /user location is not supported/i.test(body),
    note: 'Гео-отказ Google по адресу запроса: с IP Timeweb каталог моделей и генерация закрыты. '
      + 'Ни ключ, ни id модели не помогут — нужен только релей.',
  },
  {
    provider: 'openrouter',
    match: (status, body) => status === 403 && /access denied by security policy/i.test(body),
    note: 'Это ответ КРАЯ Cloudflare, а не OpenRouter: до провайдера запрос не дошёл. '
      + 'Отличать от 403 самого OpenRouter (там тело иное) — иначе ищут деньги на счёте вместо дороги.',
  },
];

/** Известное об отказе; null — ничего не известно, и выдумывать нечего. */
export function refusalNote(provider: string, status: number | null, body: string | undefined): string | null {
  const text = body ?? '';
  for (const n of NOTES) {
    if (n.provider === provider && n.match(status, text)) return n.note;
  }
  return null;
}
