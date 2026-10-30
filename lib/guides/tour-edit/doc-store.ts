/**
 * Документ гида (.docx) → поля тура — база (миграция 1359, `tour_doc_drafts`).
 *
 * Черновик живёт до кнопки. «Сохранить всё» / «Сохранить: поле» в одной
 * транзакции блокирует черновик и тур, по каждому полю сверяет «было» из
 * предпросмотра с тем, что в туре сейчас, и пишет совпавшие поля ОБЩЕЙ
 * функцией `writeTourPatch` (lib/tours/tour-write) — той же, что кабинет
 * оператора на сайте и правка фразой (1357). Поле, которое поменяли после
 * предпросмотра, не пишется: гид видит новое «было». Без нажатия в
 * `operator_tours` не пишется ничего.
 *
 * Чьё: черновик — строка этой карточки И этого чата; тур — по
 * `operator_tours.operator_id` карточки. Чужое — «не найдено».
 * Отказ базы — свой исход (`db_error`), в лог — шаг и SQLSTATE, без текста.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { writeTourPatch, type TourPatchInput } from '@/lib/tours/tour-write';
import { DOC_FIELDS, type DocField } from './doc-sections';
import { lockEditTour, readEditTour, sameValue, DRAFT_TTL_HOURS, type ChatTour, type EditChannel } from './store';
import type { EditValue } from './parse';

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function logFail(what: string, err: unknown): void {
  console.error(`[guide-tour-doc] ${what} — отказ, SQLSTATE ${sqlstate(err)}`);
}

export type DocValues = Partial<Record<DocField, EditValue>>;

export interface DocDraft {
  id: string;
  tourId: string | null;
  candidateIds: string[];
  values: DocValues;
  live: Partial<Record<DocField, unknown>> | null;
  saved: DocField[];
}

/** Поля документа по порядку DOC_FIELDS. */
export function docFieldsOf(values: DocValues): DocField[] {
  return DOC_FIELDS.filter((f) => values[f] !== undefined);
}

function liveOf(tour: ChatTour, values: DocValues): Partial<Record<DocField, unknown>> {
  return Object.fromEntries(docFieldsOf(values).map((f) => [f, tour.fields[f] ?? null]));
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

/** Последнее действие в чате главное: прежние черновики этого чата снимаются. */
const SUPERSEDE_SQL = [
  `UPDATE tour_doc_drafts SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`,
  `UPDATE tour_chat_edits SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`,
  `UPDATE guide_chat_drafts SET status = 'superseded', decided_at = NOW()
    WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('awaiting_text', 'pending')`,
];

export const CREATE_DOC_DRAFT_SQL = `INSERT INTO tour_doc_drafts
    (partner_id, channel, chat_id, tour_id, candidate_ids, doc_values, live_values, expires_at)
  VALUES ($1::uuid, $2, $3::bigint, $4::bigint, $5::bigint[], $6::jsonb, $7::jsonb,
          NOW() + make_interval(hours => $8::int))
  RETURNING id::text AS id`;

export type CreateDocDraft = { outcome: 'created'; id: string } | { outcome: 'db_error' };

export async function createDocDraft(input: {
  partnerId: string;
  channel: EditChannel;
  chatId: number;
  tour: ChatTour | null;
  candidateIds: string[];
  values: DocValues;
}): Promise<CreateDocDraft> {
  return inTx<CreateDocDraft>('черновик документа', async (c) => {
    for (const sql of SUPERSEDE_SQL) await c.query(sql, [input.channel, String(input.chatId)]);
    const { rows } = await c.query<{ id: string }>(CREATE_DOC_DRAFT_SQL, [
      input.partnerId, input.channel, String(input.chatId), input.tour?.id ?? null, input.candidateIds,
      JSON.stringify(input.values), input.tour ? JSON.stringify(liveOf(input.tour, input.values)) : null, DRAFT_TTL_HOURS,
    ]);
    const id = rows[0]?.id;
    return id ? { outcome: 'created', id } : { outcome: 'db_error' };
  }, { outcome: 'db_error' });
}

interface DocRowDb {
  id: string; tour_id: string | null; candidate_ids: string[] | null; doc_values: DocValues;
  live_values: Partial<Record<DocField, unknown>> | null; saved_fields: string[] | null; status: string; expired: boolean;
}

const LOCK_SQL = `SELECT id::text AS id, tour_id::text AS tour_id, candidate_ids::text[] AS candidate_ids, doc_values,
         live_values, saved_fields, status, (expires_at < NOW()) AS expired
    FROM tour_doc_drafts
   WHERE id = $1::uuid AND partner_id = $2::uuid AND channel = $3 AND chat_id = $4::bigint
   FOR UPDATE`;

function toDraft(r: DocRowDb): DocDraft {
  return {
    id: r.id,
    tourId: r.tour_id,
    candidateIds: r.candidate_ids ?? [],
    values: r.doc_values ?? {},
    live: r.live_values,
    saved: (r.saved_fields ?? []).filter((f): f is DocField => (DOC_FIELDS as readonly string[]).includes(f)),
  };
}

export type DocBlocked =
  | { kind: 'not_found' }
  | { kind: 'saved_before' }
  | { kind: 'cancelled_before' }
  | { kind: 'superseded' }
  | { kind: 'expired' }
  | { kind: 'db_error' };

function blockedOf(r: DocRowDb): DocBlocked | null {
  if (r.status === 'saved') return { kind: 'saved_before' };
  if (r.status === 'cancelled') return { kind: 'cancelled_before' };
  if (r.status === 'superseded') return { kind: 'superseded' };
  if (r.expired) return { kind: 'expired' };
  return null;
}

export interface DocWho { partnerId: string; channel: EditChannel; chatId: number; draftId: string }

export type ChooseDocTour = { kind: 'chosen'; draft: DocDraft; tour: ChatTour } | { kind: 'stale_button' } | DocBlocked;

/** Тур кнопкой — из кандидатов черновика, свой. */
export async function chooseDocTour(who: DocWho, index: number): Promise<ChooseDocTour> {
  return inTx<ChooseDocTour>('выбор тура документа', async (c) => {
    const { rows } = await c.query<DocRowDb>(LOCK_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked) return blocked;
    const tourId = row.tour_id ?? (row.candidate_ids ?? [])[index];
    if (tourId === undefined) return { kind: 'stale_button' };
    const t = await readEditTour(who.partnerId, tourId, c);
    if (t.outcome === 'db_error') throw new Error('тур не прочитан');
    if (t.outcome === 'not_found') return { kind: 'not_found' };
    if (row.tour_id !== null) return { kind: 'chosen', draft: toDraft(row), tour: t.tour };
    const live = liveOf(t.tour, row.doc_values);
    await c.query(`UPDATE tour_doc_drafts SET tour_id = $2::bigint, live_values = $3::jsonb WHERE id = $1::uuid`,
      [who.draftId, tourId, JSON.stringify(live)]);
    return { kind: 'chosen', draft: { ...toDraft(row), tourId, live }, tour: t.tour };
  }, { kind: 'db_error' });
}

export type SaveDoc =
  | {
    kind: 'saved';
    draft: DocDraft;
    tour: ChatTour;
    /** Записано этим нажатием. */
    written: DocField[];
    /** Поменяли после предпросмотра — не записано, «было» обновлено. */
    changed: DocField[];
    /** Ещё ждут кнопки. */
    remaining: DocField[];
    title: string;
  }
  | { kind: 'need_tour' }
  | { kind: 'tour_gone' }
  | { kind: 'nothing' }
  | DocBlocked;

/**
 * «Сохранить всё» (`which = 'all'`) или одно поле. Единственное место, где
 * документ доходит до тура; запись — `writeTourPatch` с владельцем в UPDATE.
 */
export async function saveDocDraft(who: DocWho, which: DocField | 'all'): Promise<SaveDoc> {
  const out = await inTx<SaveDoc>('сохранение документа', async (c) => {
    const { rows } = await c.query<DocRowDb>(LOCK_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked) return blocked;
    if (row.tour_id === null) return { kind: 'need_tour' };
    const draft = toDraft(row);
    const locked = await lockEditTour(c, who.partnerId, row.tour_id);
    if (!locked) return { kind: 'tour_gone' };
    const pending = docFieldsOf(draft.values).filter((f) => !draft.saved.includes(f));
    const asked = which === 'all' ? pending : pending.filter((f) => f === which);
    if (asked.length === 0) return { kind: 'nothing' };
    const written: DocField[] = [];
    const changed: DocField[] = [];
    const live = { ...(draft.live ?? {}) };
    const input: Partial<Record<DocField, EditValue>> = {};
    for (const f of asked) {
      const now = locked.tour.fields[f] ?? null;
      if (!sameValue(now, live[f] ?? null)) {
        // Поле правили на сайте или фразой после предпросмотра: не пишем,
        // показываем новое «было» — решает гид.
        changed.push(f);
        live[f] = now;
        continue;
      }
      input[f] = draft.values[f];
      written.push(f);
    }
    let title = locked.tour.title;
    if (written.length > 0) {
      const w = await writeTourPatch(c, {
        tourId: row.tour_id,
        ownerId: who.partnerId,
        input: input as TourPatchInput,
        current: locked.row,
      });
      // Тур проверен под блокировкой строкой выше: «записал» без записи не говорим.
      if (w.outcome !== 'written') throw new Error(`тур не записан: ${w.outcome}`);
      title = w.row.title;
    }
    const saved = [...draft.saved, ...written];
    const remaining = docFieldsOf(draft.values).filter((f) => !saved.includes(f));
    await c.query(
      `UPDATE tour_doc_drafts
          SET saved_fields = $2::text[], live_values = $3::jsonb,
              status = CASE WHEN $4::boolean THEN 'saved' ELSE status END,
              decided_at = CASE WHEN $4::boolean THEN NOW() ELSE decided_at END
        WHERE id = $1::uuid AND status = 'pending'`,
      [who.draftId, saved, JSON.stringify(live), remaining.length === 0],
    );
    return {
      kind: 'saved', draft: { ...draft, saved, live }, tour: locked.tour, written, changed, remaining, title,
    };
  }, { kind: 'db_error' });
  if (out.kind === 'saved' && out.written.length > 0 && out.draft.tourId) pingTourChanged(out.draft.tourId);
  return out;
}

export type CancelDoc = { kind: 'cancelled' } | DocBlocked;

export async function cancelDocDraft(who: DocWho): Promise<CancelDoc> {
  return inTx<CancelDoc>('отмена документа', async (c) => {
    const { rows } = await c.query<DocRowDb>(LOCK_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked && blocked.kind !== 'expired') return blocked;
    await c.query(`UPDATE tour_doc_drafts SET status = 'cancelled', decided_at = NOW() WHERE id = $1::uuid`, [who.draftId]);
    return { kind: 'cancelled' };
  }, { kind: 'db_error' });
}
