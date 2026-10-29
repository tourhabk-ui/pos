/**
 * «Выполнено» под напоминанием о задаче CRM — нажатие в MAX (план «гид в
 * чате», шаг 9). Правило одно на всех партнёров: у задачи нет ни денег, ни
 * письма туристу, ни ПД туриста.
 *
 * Чат — ещё одна дверь в то же правило: отметку ставит только `completeTask`
 * (lib/crm/tasks) — владение по `partner_id` в SQL, повторная отметка не
 * пишет второй раз, событие «задача выполнена» в ленту клиента. Второй копии
 * здесь нет.
 *
 * Кто вправе:
 *  - вызывающий пускает только заверенный апдейт MAX (`verifiedOrigin`), чат
 *    — только из сообщения с кнопкой (lib/max/verified-press);
 *  - личный диалог: в группе кнопку нажал бы любой участник;
 *  - задача принадлежит карточке, к которой подключён ЭТОТ чат
 *    (`partners.max_chat_id`), — условие в SQL, а не payload: задача чужой
 *    карточки отвечает «не найдена», как несуществующая. Карточек на одном
 *    чате бывает две (один человек — туроператор и гид): напоминание каждой
 *    уходит в этот чат, и кнопка отмечает задачу той, чья она, а не только
 *    старшей, как `findPartnerByChat`. Отметил — аккаунт этой карточки
 *    (`partners.user_id`), как на сайте; аккаунта нет — отметка без автора,
 *    как у задачи из MCP.
 *
 * Чат и задача читаются одним запросом с тремя исходами: чат не подключён
 * ни к одной карточке, задача не его, задача его. Отказ базы — «не
 * отмечена», а не «не найдена» (§4.0). Слоя Кузьмича модуль не трогает:
 * слой CRM моделей не зовёт (crm-pd-parity).
 *
 * Повтор нажатия (MAX повторяет апдейты, а отсев повторов — только по mid
 * сообщения) отвечает «уже отмечена» и ничего не пишет. Отказ базы — имя
 * проверки и SQLSTATE в лог; текст ошибки не пишется — в нём бывают значения
 * строки.
 */
import { pool } from '@/lib/db-pool';
import { completeTask } from '@/lib/crm/tasks';
import { TASK_PRESS_TEXT, parseTaskPress } from '@/lib/crm/chat-task-press';
import { escapeHtml } from '@/lib/text/escape-html';

interface Queryable {
  query: typeof pool.query;
}

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

/**
 * Чат и задача одной строкой, строка есть всегда: `bound` — чат подключён
 * хоть к одной карточке; `partner_id` — задача карточки этого чата (NULL —
 * задачи нет или она чужая).
 */
export const TASK_OF_CHAT_SQL = `
  SELECT EXISTS (SELECT 1 FROM partners WHERE max_chat_id = $2::bigint) AS bound,
         t.partner_id::text AS partner_id, p.user_id::text AS user_id, t.title, (t.done_at IS NOT NULL) AS done
    FROM (VALUES (1)) AS one(x)
    LEFT JOIN crm_tasks t
      ON t.id = $1::uuid
     AND EXISTS (SELECT 1 FROM partners pc WHERE pc.id = t.partner_id AND pc.max_chat_id = $2::bigint)
    LEFT JOIN partners p ON p.id = t.partner_id`;

/** Закрытая задача этого партнёра: строка есть — отмечена раньше (гонка двух нажатий). */
export const DONE_TASK_SQL = `
  SELECT title FROM crm_tasks WHERE id = $2::uuid AND partner_id = $1 AND done_at IS NOT NULL`;

export interface TaskPressDeps {
  db?: Queryable;
}

/** Ответ бота в чат нажатия. Только MAX: в Telegram кнопки нет (шапка chat-task-press). */
export async function handleTaskPress(
  input: { chatId: number; privateChat: boolean; payload: string },
  deps: TaskPressDeps = {},
): Promise<string> {
  const db = deps.db ?? pool;
  const press = parseTaskPress(input.payload);
  if (!press) return TASK_PRESS_TEXT.unknownButton;
  if (!input.privateChat) {
    console.error('[chat-task-action] нажатие «Выполнено» не из личного диалога — не применено');
    return TASK_PRESS_TEXT.notDialog;
  }

  type Row = { bound: boolean; partner_id: string | null; user_id: string | null; title: string | null; done: boolean | null };
  let row: Row | undefined;
  try {
    ({ rows: [row] } = await db.query<Row>(TASK_OF_CHAT_SQL, [press.taskId, String(input.chatId)]));
  } catch (err) {
    console.error(`[chat-task-action] задача чата не прочитана — отказ, SQLSTATE ${sqlstate(err)}`);
    return TASK_PRESS_TEXT.dbFailed;
  }
  if (!row) {
    // Запрос отдаёт строку всегда; её нет — ответ базы непонятен, а не «чат не подключён».
    console.error('[chat-task-action] задача чата: пустой ответ базы — не применено');
    return TASK_PRESS_TEXT.dbFailed;
  }
  if (!row.bound) return TASK_PRESS_TEXT.notBound;
  if (row.partner_id === null || row.title === null) return TASK_PRESS_TEXT.notFound;
  const task = { partner_id: row.partner_id, user_id: row.user_id, title: row.title, done: row.done === true };
  if (task.done) return TASK_PRESS_TEXT.already(escapeHtml(task.title));

  try {
    const r = await completeTask(task.partner_id, press.taskId, task.user_id, db, 'partner_user');
    if (r.outcome === 'done') return TASK_PRESS_TEXT.done(escapeHtml(r.task.title));
  } catch (err) {
    console.error(`[chat-task-action] отметка задачи — отказ, SQLSTATE ${sqlstate(err)}`);
    return TASK_PRESS_TEXT.dbFailed;
  }

  // Открытая минуту назад задача уже не открыта: второе нажатие того же
  // апдейта успело раньше — «уже»; удалили в кабинете — «не найдена».
  try {
    const { rows } = await db.query<{ title: string }>(DONE_TASK_SQL, [task.partner_id, press.taskId]);
    const done = rows[0];
    return done ? TASK_PRESS_TEXT.already(escapeHtml(done.title)) : TASK_PRESS_TEXT.notFound;
  } catch (err) {
    console.error(`[chat-task-action] проверка «уже отмечена» — отказ, SQLSTATE ${sqlstate(err)}`);
    return TASK_PRESS_TEXT.doneUnchecked;
  }
}
