/**
 * Новый тур гида из чата — база (миграция 1362, `tour_create_drafts`).
 *
 * Фраза «новый тур: …» или документ без своего тура заводят ЧЕРНОВИК
 * СОЗДАНИЯ: поля ждут кнопки. «Создать черновик» в одной транзакции
 * блокирует строку, создаёт тур ОБЩЕЙ функцией сайта и чата
 * (`createOwnTourDraft`, lib/guides/own-tour-create) и отмечает строку
 * «создан» с номером тура. Повтор кнопки второго тура не заводит. Без нажатия
 * в `operator_tours` не пишется ничего.
 *
 * Чьё: строка — этой карточки И этого чата. Чужое — «не найдено».
 * Отказ базы — свой исход (`db_error`), в лог — шаг и SQLSTATE, без текста.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { createOwnTourDraft, OwnTourDraftSchema, type OwnTourDraftInput } from '@/lib/guides/own-tour-create';
import { DRAFT_TTL_HOURS, type EditChannel } from './store';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function logFail(what: string, err: unknown): void {
  console.error(`[guide-tour-create] ${what} — отказ, SQLSTATE ${sqlstate(err)}`);
}

async function inTx<T>(what: string, fn: (c: PoolClient) => Promise<T>, onError: T): Promise<T> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logFail(`соединение (${what})`, err);
    return onError;
  }
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch((e: unknown) => logFail(`откат (${what})`, e));
    logFail(what, err);
    return onError;
  } finally {
    client.release();
  }
}

/** Последнее действие в чате главное: открытые черновики всех четырёх таблиц снимаются. */
const SUPERSEDE_SQL = [
  `UPDATE tour_create_drafts SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`,
  `UPDATE tour_chat_edits SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`,
  `UPDATE tour_doc_drafts SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`,
  `UPDATE guide_chat_drafts SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('awaiting_text', 'pending')`,
];

export const CREATE_TOUR_DRAFT_SQL = `INSERT INTO tour_create_drafts (partner_id, channel, chat_id, source, draft_values, expires_at)
  VALUES ($1::uuid, $2, $3::bigint, $4, $5::jsonb, NOW() + make_interval(hours => $6::int))
  RETURNING id::text AS id`;

export type CreateSource = 'phrase' | 'doc';

export async function createTourCreateDraft(input: {
  partnerId: string;
  channel: EditChannel;
  chatId: number;
  source: CreateSource;
  values: OwnTourDraftInput;
}): Promise<{ outcome: 'created'; id: string } | { outcome: 'db_error' }> {
  return inTx<{ outcome: 'created'; id: string } | { outcome: 'db_error' }>('черновик нового тура', async (c) => {
    for (const sql of SUPERSEDE_SQL) await c.query(sql, [input.channel, String(input.chatId)]);
    const { rows } = await c.query<{ id: string }>(CREATE_TOUR_DRAFT_SQL, [
      input.partnerId, input.channel, String(input.chatId), input.source, JSON.stringify(input.values), DRAFT_TTL_HOURS,
    ]);
    const id = rows[0]?.id;
    return id ? { outcome: 'created', id } : { outcome: 'db_error' };
  }, { outcome: 'db_error' });
}

interface Row { id: string; draft_values: unknown; tour_id: string | null; status: string; expired: boolean }

const LOCK_SQL = `SELECT id::text AS id, draft_values, tour_id::text AS tour_id, status, (expires_at < NOW()) AS expired
    FROM tour_create_drafts
   WHERE id = $1::uuid AND partner_id = $2::uuid AND channel = $3 AND chat_id = $4::bigint
   FOR UPDATE`;

export interface CreateWho { partnerId: string; userId: string; channel: EditChannel; chatId: number; draftId: string }

export type CreateBlocked =
  | { kind: 'not_found' }
  | { kind: 'created_before'; tourId: string }
  | { kind: 'cancelled_before' }
  | { kind: 'superseded' }
  | { kind: 'expired' }
  | { kind: 'db_error' };

function blockedOf(r: Row): CreateBlocked | null {
  if (r.status === 'created' && r.tour_id) return { kind: 'created_before', tourId: r.tour_id };
  if (r.status === 'cancelled') return { kind: 'cancelled_before' };
  if (r.status === 'superseded') return { kind: 'superseded' };
  if (r.expired) return { kind: 'expired' };
  return null;
}

export type SaveCreate =
  | { kind: 'created'; tour: { id: string; title: string; slug: string | null } }
  /** Карточка чата — не гид: ни строки тура. */
  | { kind: 'not_guide' }
  /** Поля черновика не прошли схему общей функции — ничего не записано. */
  | { kind: 'invalid' }
  | CreateBlocked;

/**
 * «Создать черновик» — единственное место, где новый тур из чата доходит до
 * `operator_tours`, и только через общую функцию создания.
 */
export async function saveTourCreateDraft(who: CreateWho): Promise<SaveCreate> {
  return inTx<SaveCreate>('создание тура', async (c) => {
    const { rows } = await c.query<Row>(LOCK_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked) return blocked;
    const values = OwnTourDraftSchema.safeParse(row.draft_values);
    if (!values.success) return { kind: 'invalid' };
    const made = await createOwnTourDraft(c, { ownerId: who.partnerId, userId: who.userId, input: values.data });
    if (made.outcome !== 'created') return { kind: 'not_guide' };
    await c.query(
      `UPDATE tour_create_drafts SET status = 'created', tour_id = $2::bigint, decided_at = NOW()
        WHERE id = $1::uuid AND status = 'pending'`,
      [who.draftId, made.tour.id],
    );
    return { kind: 'created', tour: made.tour };
  }, { kind: 'db_error' });
}

export type CancelCreate = { kind: 'cancelled' } | CreateBlocked;

export async function cancelTourCreateDraft(who: Omit<CreateWho, 'userId'>): Promise<CancelCreate> {
  return inTx<CancelCreate>('отмена нового тура', async (c) => {
    const { rows } = await c.query<Row>(LOCK_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked && blocked.kind !== 'expired') return blocked;
    await c.query(`UPDATE tour_create_drafts SET status = 'cancelled', decided_at = NOW() WHERE id = $1::uuid`, [who.draftId]);
    return { kind: 'cancelled' };
  }, { kind: 'db_error' });
}
