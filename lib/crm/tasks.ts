/**
 * lib/crm/tasks.ts — задачи партнёра по клиенту (CRM фаза 1, шаг 1в, #2325).
 *
 * «Перезвонить завтра», «уточнить состав группы», «следующий контакт». Одни
 * функции на три поверхности: экран кабинета сегодня, Кузьмич и MCP
 * партнёра (1д) завтра — здесь только данные, без знания о том, кто позвал.
 *
 * Правила:
 *  - задача принадлежит партнёру; чужая задача и задача о чужом клиенте
 *    отвечают `not_found`, как несуществующие (скоуп — в SQL);
 *  - выполнение задачи с клиентом пишет в ленту событие `task_done` — та же
 *    транзакция не нужна: лента — журнал, отказ записи события задачу не
 *    откатывает, но и не молчит (вид и SQLSTATE в лог);
 *  - срок задаётся моментом (timestamptz); «сегодня» и «просрочено» считает
 *    экран в поясе партнёра, сервер отдаёт моменты как есть.
 */
import { pool } from '@/lib/db-pool';
import { recordContactEvent } from '@/lib/crm/events';
import { DETAILS_MAX, TITLE_MAX } from '@/lib/crm/event-kinds';
import type { CrmTaskRow } from '@/lib/types/db-rows';

interface Queryable {
  query: typeof pool.query;
}

export const TASK_LIST_LIMIT = 200;
export const DONE_LIST_LIMIT = 50;

export interface TaskItem {
  id: string;
  title: string;
  details: string | null;
  due_at: string;
  done_at: string | null;
  contact: { id: string; display_name: string | null } | null;
  created_at: string;
}

export type TaskStatus = 'open' | 'done';

function iso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function clean(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

type TaskJoinRow = Pick<CrmTaskRow, 'id' | 'title' | 'details' | 'due_at' | 'done_at' | 'contact_id' | 'created_at'>
  & { contact_name: string | null };

function toItem(r: TaskJoinRow): TaskItem {
  return {
    id: r.id,
    title: r.title,
    details: r.details,
    due_at: iso(r.due_at),
    done_at: r.done_at ? iso(r.done_at) : null,
    contact: r.contact_id ? { id: r.contact_id, display_name: r.contact_name } : null,
    created_at: iso(r.created_at),
  };
}

const TASK_SELECT = `
  SELECT t.id, t.title, t.details, t.due_at, t.done_at, t.contact_id, t.created_at,
         c.display_name AS contact_name
    FROM crm_tasks t
    LEFT JOIN crm_contacts c ON c.id = t.contact_id`;

/**
 * Задачи партнёра. Открытые — по сроку, ближайшие сверху (просроченные —
 * первыми); выполненные — свежие сверху. `contactId` сужает до клиента.
 */
export async function listTasks(
  partnerId: string,
  opts: { status: TaskStatus; contactId?: string | null },
  db: Queryable = pool,
): Promise<TaskItem[]> {
  const open = opts.status === 'open';
  const { rows } = await db.query<TaskJoinRow>(
    `${TASK_SELECT}
      WHERE t.partner_id = $1
        AND ${open ? 't.done_at IS NULL' : 't.done_at IS NOT NULL'}
        AND ($2::uuid IS NULL OR t.contact_id = $2::uuid)
      ORDER BY ${open ? 't.due_at ASC, t.created_at ASC' : 't.done_at DESC'}
      LIMIT $3`,
    [partnerId, opts.contactId ?? null, open ? TASK_LIST_LIMIT : DONE_LIST_LIMIT],
  );
  return rows.map(toItem);
}

export interface NewTaskInput {
  title: string;
  details?: string | null;
  dueAt: Date;
  contactId?: string | null;
  createdBy?: string | null;
}

export type CreateTaskResult = { outcome: 'created'; task: TaskItem } | { outcome: 'contact_not_found' };

/** Клиент задачи обязан быть клиентом этого партнёра — иначе `contact_not_found`. */
export async function createTask(partnerId: string, input: NewTaskInput, db: Queryable = pool): Promise<CreateTaskResult> {
  const title = clean(input.title, TITLE_MAX);
  if (!title) throw new Error('задача без заголовка');
  const details = input.details?.trim() ? input.details.trim().slice(0, DETAILS_MAX) : null;
  const contactId = input.contactId ?? null;
  const { rows } = await db.query<TaskJoinRow>(
    `WITH owner AS (
       SELECT id, display_name FROM crm_contacts WHERE id = $2::uuid AND partner_id = $1
     ), ins AS (
       INSERT INTO crm_tasks (partner_id, contact_id, title, details, due_at, origin, created_by)
       SELECT $1, $2::uuid, $3, $4, $5::timestamptz, 'manual', $6
        WHERE $2::uuid IS NULL OR EXISTS (SELECT 1 FROM owner)
       RETURNING id, title, details, due_at, done_at, contact_id, created_at
     )
     SELECT ins.*, owner.display_name AS contact_name FROM ins LEFT JOIN owner ON owner.id = ins.contact_id`,
    [partnerId, contactId, title, details, input.dueAt.toISOString(), input.createdBy ?? null],
  );
  if (!rows[0]) return { outcome: 'contact_not_found' };
  return { outcome: 'created', task: toItem(rows[0]) };
}

export interface TaskPatch {
  title?: string;
  details?: string | null;
  dueAt?: Date;
}

/** Правка открытой задачи: заголовок, подробности, срок. Выполненная не правится. */
export async function updateTask(
  partnerId: string,
  taskId: string,
  patch: TaskPatch,
  db: Queryable = pool,
): Promise<TaskItem | null> {
  const title = patch.title !== undefined ? clean(patch.title, TITLE_MAX) : null;
  if (patch.title !== undefined && !title) throw new Error('задача без заголовка');
  const detailsGiven = patch.details !== undefined;
  const details = patch.details?.trim() ? patch.details.trim().slice(0, DETAILS_MAX) : null;
  const { rows } = await db.query<TaskJoinRow>(
    `WITH upd AS (
       UPDATE crm_tasks
          SET title = COALESCE($3, title),
              details = CASE WHEN $4::boolean THEN $5 ELSE details END,
              due_at = COALESCE($6::timestamptz, due_at),
              updated_at = NOW()
        WHERE id = $2::uuid AND partner_id = $1 AND done_at IS NULL
        RETURNING id, title, details, due_at, done_at, contact_id, created_at
     )
     SELECT upd.*, c.display_name AS contact_name FROM upd LEFT JOIN crm_contacts c ON c.id = upd.contact_id`,
    [partnerId, taskId, title, detailsGiven, details, patch.dueAt ? patch.dueAt.toISOString() : null],
  );
  return rows[0] ? toItem(rows[0]) : null;
}

export type CompleteResult = { outcome: 'done'; task: TaskItem } | { outcome: 'not_found' };

/**
 * Отметить выполненной. Повторная отметка — `not_found` (открытой задачи с
 * таким id нет), а не вторая запись в ленте.
 */
export async function completeTask(
  partnerId: string,
  taskId: string,
  doneBy: string | null,
  db: Queryable = pool,
): Promise<CompleteResult> {
  const { rows } = await db.query<TaskJoinRow>(
    `WITH upd AS (
       UPDATE crm_tasks SET done_at = NOW(), done_by = $3, updated_at = NOW()
        WHERE id = $2::uuid AND partner_id = $1 AND done_at IS NULL
        RETURNING id, title, details, due_at, done_at, contact_id, created_at
     )
     SELECT upd.*, c.display_name AS contact_name FROM upd LEFT JOIN crm_contacts c ON c.id = upd.contact_id`,
    [partnerId, taskId, doneBy],
  );
  const row = rows[0];
  if (!row) return { outcome: 'not_found' };
  if (row.contact_id) {
    const r = await recordContactEvent({
      partnerId,
      contactId: row.contact_id,
      kind: 'task_done',
      actorKind: 'partner_user',
      actorUserId: doneBy,
      title: row.title,
      payload: { task_id: row.id, due_at: iso(row.due_at) },
    }, db);
    if (r.outcome !== 'recorded') {
      console.error('[crm] событие «задача выполнена» не записано:', r.outcome === 'failed' ? r.reason : r.outcome);
    }
  }
  return { outcome: 'done', task: toItem(row) };
}

/** Удалить задачу партнёра (ошибочно заведённую). Выполненную — тоже: лента уже записала факт. */
export async function deleteTask(partnerId: string, taskId: string, db: Queryable = pool): Promise<boolean> {
  const { rowCount } = await db.query(
    `DELETE FROM crm_tasks WHERE id = $2::uuid AND partner_id = $1`,
    [partnerId, taskId],
  );
  return (rowCount ?? 0) > 0;
}
