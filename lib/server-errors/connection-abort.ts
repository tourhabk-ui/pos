/**
 * lib/server-errors/connection-abort.ts — обрыв соединения, а не ошибка страницы
 * (слово владельца 19.11 «1»).
 *
 * Проверка прода 19.11 прочитала журнал серверных ошибок за неделю: у каталога
 * туров одна ошибка (13.11), у карты девять, и у всех один текст —
 * «controller[kState].transformAlgorithm is not a function», а стек целиком во
 * внутренностях Node.js (`node:internal/webstreams/transformstream`). Кода
 * Ведара в нём нет. Так Node.js отвечает, когда поток ответа уже закрыт, а
 * сервер ещё дописывает страницу: посетитель ушёл или соединение оборвалось
 * посреди ответа (Next.js, обсуждение 75995; Node.js, задача 62036).
 *
 * До этой правки суточный дайджест владельцу и объектив эволюции называли такие
 * строки «Прод 500», хотя страница не падала. Теперь у них свой род:
 *  - перепись `/api/cron/prod-errors` отдаёт их отдельно (`connection_abort`);
 *  - дайджест говорит о них одной строкой «обрыв соединения», а не «ошибка»;
 *  - объектив эволюции находки «Прод 500» из них не делает;
 *  - перепись попыток брони не считает их сорванными попытками.
 *
 * Признак узкий намеренно: текст ошибки И стек во внутренностях потоков Node.js.
 * Тот же текст с кадром нашего кода в стеке — уже не обрыв, а ошибка, и
 * остаётся «Прод 500». Признак читается из журнала при каждом чтении, а не
 * пишется в строку: так строки, записанные до правки, получают тот же род.
 * Сторож — `tests/unit/server-errors-connection-abort.test.ts`.
 */

/** Текст ошибки Node.js, когда поток ответа закрыт посреди записи. */
export const CONNECTION_ABORT_MESSAGE = 'transformAlgorithm is not a function';
/** Первый кадр стека — внутренности потоков Node.js. */
export const CONNECTION_ABORT_STACK_HEAD = 'at transformStreamDefaultControllerPerformTransform (node:internal/webstreams/';

/** Строка журнала — обрыв соединения: тот текст и стек, начатый во внутренностях потоков. */
export function isConnectionAbort(message: string | null | undefined, stack: string | null | undefined): boolean {
  if (!message || !stack) return false;
  if (!message.includes(CONNECTION_ABORT_MESSAGE)) return false;
  if (!stack.trimStart().startsWith(CONNECTION_ABORT_STACK_HEAD)) return false;
  // Каждый кадр — во внутренностях Node.js, и ни один не указывает на файл
  // вне их. Кадр нашего кода в стеке — это ошибка, а не обрыв.
  const frames = stack.split(' | ').map((f) => f.trim()).filter(Boolean);
  return frames.every((f) => f.includes('node:internal/') && !/\((?!node:internal\/)/.test(f));
}

/**
 * То же правило в SQL — для строк `ai_actions_log` (поля `metadata.message` и
 * `metadata.stack`). Кадры стека перехватчик пишет через « | »
 * (`instrumentation.ts`).
 */
export const CONNECTION_ABORT_SQL = `(
  COALESCE(metadata->>'message', '') LIKE '%${CONNECTION_ABORT_MESSAGE}%'
  AND LTRIM(COALESCE(metadata->>'stack', '')) LIKE '${CONNECTION_ABORT_STACK_HEAD}%'
  AND NOT EXISTS (
    SELECT 1 FROM unnest(string_to_array(metadata->>'stack', ' | ')) AS frame
     WHERE btrim(frame) <> ''
       AND (frame NOT LIKE '%node:internal/%' OR frame ~ '\\((?!node:internal/)')
  )
)`;
