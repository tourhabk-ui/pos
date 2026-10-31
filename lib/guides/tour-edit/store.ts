/**
 * Правка своего тура из чата кабинета — база (миграция 1357).
 *
 * Черновик (`tour_chat_edits`) живёт до кнопки: «Сохранить» в одной
 * транзакции блокирует черновик и тур, сверяет «было» из предпросмотра с
 * тем, что в туре сейчас, и пишет тур ОБЩЕЙ функцией `writeTourPatch`
 * (lib/tours/tour-write) — той же, что кабинет оператора на сайте. Без
 * нажатия в `operator_tours` не пишется ничего.
 *
 * Чьё: черновик — строка этой карточки И этого чата; тур — по
 * `operator_tours.operator_id` карточки (как у /api/guide/own/dates). Чужой
 * черновик и чужой тур — «не найдено», ни строки не тронуто.
 *
 * Отказ базы — свой исход (`db_error`), не «нет туров» и не «не найдено»
 * (§4.0): в лог — имя шага и SQLSTATE, без текста тура.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { pingTourChanged } from '@/lib/seo/indexnow';
import { writeTourPatch, type TourPatchInput } from '@/lib/tours/tour-write';
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { EDIT_FIELDS, type EditField, type EditTour, type EditValue } from './parse';

export type EditChannel = 'max' | 'telegram';

/** Сколько живёт черновик до кнопки. */
export const DRAFT_TTL_HOURS = 2;

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function logFail(what: string, err: unknown): void {
  console.error(`[guide-tour-edit] ${what} — отказ, SQLSTATE ${sqlstate(err)}`);
}

// ── Туры гида ───────────────────────────────────────────────────────────────

export interface ChatTour extends EditTour {
  slug: string | null;
  isActive: boolean;
  isPublished: boolean;
  basePrice: number | null;
  priceUnit: string | null;
  maxParticipants: number | null;
  /** Текущие значения полей правки — для «было». */
  fields: Record<EditField, unknown>;
}

const TOUR_COLUMNS = `t.id::text AS id, t.title, NULLIF(btrim(t.slug), '') AS slug,
       COALESCE(t.is_active, FALSE) AS is_active, COALESCE(t.is_published, FALSE) AS is_published,
       t.base_price, t.price_unit, t.max_participants,
       t.short_description, t.description, t.program, t.included, t.not_included, t.what_to_bring, t.safety_notes`;

interface TourRowDb {
  id: string; title: string; slug: string | null; is_active: boolean; is_published: boolean;
  base_price: string | number | null; price_unit: string | null; max_participants: number | null;
  short_description: string | null; description: string | null; program: unknown;
  included: unknown; not_included: unknown; what_to_bring: unknown; safety_notes: unknown;
}

function toTour(r: TourRowDb): ChatTour {
  const fields = {} as Record<EditField, unknown>;
  for (const f of EDIT_FIELDS) fields[f] = normalizeField(f, (r as unknown as Record<string, unknown>)[f]);
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    isActive: r.is_active === true,
    isPublished: r.is_published === true,
    basePrice: r.base_price === null ? null : Number(r.base_price),
    priceUnit: r.price_unit,
    maxParticipants: r.max_participants,
    fields,
  };
}

/**
 * Значение поля в одном виде для сравнения и показа: текст — строка или
 * null, список — массив строк или null, программа — массив шагов или null,
 * цена — число или null. Пустое — null.
 */
export function normalizeField(field: EditField, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (field) {
    case 'base_price': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'program': {
      // jsonb и text[] pg отдаёт уже разобранными; иное — не список.
      const arr = raw;
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr.map((s) => {
        const o = (s && typeof s === 'object' ? s : { title: String(s), text: '' }) as Record<string, unknown>;
        return { title: typeof o.title === 'string' ? o.title : '', text: typeof o.text === 'string' ? o.text : '' };
      });
    }
    case 'included':
    case 'not_included':
    case 'what_to_bring':
    case 'safety_notes': {
      const arr = raw;
      if (!Array.isArray(arr) || arr.length === 0) return null;
      return arr.map((x) => String(x));
    }
    default:
      return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }
}

/** Ключи объекта по порядку: jsonb хранит их по-своему, «было» сравнивается по смыслу. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonical(o[k])]));
  }
  return v ?? null;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export type OwnTours = { outcome: 'ok'; tours: ChatTour[] } | { outcome: 'db_error' };

/** Свои неудалённые туры карточки — и черновики, и скрытые. */
export async function readEditTours(partnerId: string, db: Pick<PoolClient, 'query'> = pool): Promise<OwnTours> {
  try {
    const { rows } = await db.query<TourRowDb>(
      `SELECT ${TOUR_COLUMNS}
         FROM operator_tours t
        WHERE t.operator_id = $1::uuid AND t.deleted_at IS NULL
        ORDER BY COALESCE(t.is_published, FALSE) DESC, t.title, t.id`,
      [partnerId],
    );
    return { outcome: 'ok', tours: rows.map(toTour) };
  } catch (err) {
    logFail('туры гида', err);
    return { outcome: 'db_error' };
  }
}

/**
 * Свой тур под блокировкой — в транзакции записи (документ гида, 1361):
 * строка для `writeTourPatch` и тур для сверки «было». null — тура нет или не
 * её. Отказ базы — исключение (транзакция вызывающего откатится).
 */
export async function lockEditTour(
  c: Pick<PoolClient, 'query'>,
  partnerId: string,
  tourId: string,
): Promise<{ tour: ChatTour; row: Record<string, unknown> } | null> {
  const { rows } = await c.query<TourRowDb & { main_place_id: string | null }>(
    `SELECT ${TOUR_COLUMNS}, t.main_place_id
       FROM operator_tours t
      WHERE t.id = $2::bigint AND t.operator_id = $1::uuid AND t.deleted_at IS NULL
      FOR UPDATE`,
    [partnerId, tourId],
  );
  const row = rows[0];
  return row ? { tour: toTour(row), row: row as unknown as Record<string, unknown> } : null;
}

export type OwnTour = { outcome: 'ok'; tour: ChatTour } | { outcome: 'not_found' } | { outcome: 'db_error' };

export async function readEditTour(partnerId: string, tourId: string, db: Pick<PoolClient, 'query'> = pool): Promise<OwnTour> {
  try {
    const { rows } = await db.query<TourRowDb>(
      `SELECT ${TOUR_COLUMNS}
         FROM operator_tours t
        WHERE t.id = $2::bigint AND t.operator_id = $1::uuid AND t.deleted_at IS NULL`,
      [partnerId, tourId],
    );
    const row = rows[0];
    return row ? { outcome: 'ok', tour: toTour(row) } : { outcome: 'not_found' };
  } catch (err) {
    logFail('тур гида', err);
    return { outcome: 'db_error' };
  }
}

// ── Черновик ────────────────────────────────────────────────────────────────

export interface Draft {
  id: string;
  tourId: string | null;
  candidateIds: string[];
  field: EditField;
  newValue: EditValue;
  liveValue: unknown;
}

const SUPERSEDE_SQL = `UPDATE tour_chat_edits SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`;

/** Открытый черновик роли гида в этом чате (1360: ответ на отзыв, профиль) — тоже: последнее действие главное. */
const SUPERSEDE_ROLE_SQL = `UPDATE guide_chat_drafts SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('awaiting_text', 'pending')`;
/** И документ гида (1361), ждущий кнопки. */
const SUPERSEDE_DOC_SQL = `UPDATE tour_doc_drafts SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`;
/** И новый тур (1362), ждущий кнопки «Создать черновик». */
const SUPERSEDE_CREATE_SQL = `UPDATE tour_create_drafts SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`;

export const CREATE_DRAFT_SQL = `INSERT INTO tour_chat_edits
    (partner_id, channel, chat_id, tour_id, candidate_ids, field, new_value, live_value, expires_at)
  VALUES ($1::uuid, $2, $3::bigint, $4::bigint, $5::bigint[], $6, $7::jsonb, $8::jsonb,
          NOW() + make_interval(hours => $9::int))
  RETURNING id::text AS id`;

export type CreateDraft = { outcome: 'created'; id: string } | { outcome: 'db_error' };

/**
 * Новый черновик чата. Прежний pending этого чата снимается в той же
 * транзакции: старая кнопка «Сохранить» больше не пишет.
 */
export async function createDraft(input: {
  partnerId: string;
  channel: EditChannel;
  chatId: number;
  tourId: string | null;
  candidateIds: string[];
  field: EditField;
  newValue: EditValue;
  /** Что в поле сейчас (null — пусто); у черновика без тура не пишется. */
  liveValue: unknown;
}): Promise<CreateDraft> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logFail('соединение черновика', err);
    return { outcome: 'db_error' };
  }
  try {
    await client.query('BEGIN');
    await client.query(SUPERSEDE_SQL, [input.channel, String(input.chatId)]);
    await client.query(SUPERSEDE_ROLE_SQL, [input.channel, String(input.chatId)]);
    await client.query(SUPERSEDE_DOC_SQL, [input.channel, String(input.chatId)]);
    await client.query(SUPERSEDE_CREATE_SQL, [input.channel, String(input.chatId)]);
    const { rows } = await client.query<{ id: string }>(CREATE_DRAFT_SQL, [
      input.partnerId, input.channel, String(input.chatId), input.tourId, input.candidateIds, input.field,
      JSON.stringify(input.newValue), input.tourId === null ? null : JSON.stringify(input.liveValue ?? null), DRAFT_TTL_HOURS,
    ]);
    await client.query('COMMIT');
    const id = rows[0]?.id;
    return id ? { outcome: 'created', id } : { outcome: 'db_error' };
  } catch (err) {
    await client.query('ROLLBACK').catch((e: unknown) => logFail('откат черновика', e));
    logFail('черновик правки', err);
    return { outcome: 'db_error' };
  } finally {
    client.release();
  }
}

interface DraftRowDb {
  id: string; tour_id: string | null; candidate_ids: string[] | null; field: string; new_value: unknown;
  live_value: unknown; status: string; expired: boolean;
}

const LOCK_DRAFT_SQL = `SELECT id::text AS id, tour_id::text AS tour_id, candidate_ids::text[] AS candidate_ids, field,
         new_value, live_value, status, (expires_at < NOW()) AS expired
    FROM tour_chat_edits
   WHERE id = $1::uuid AND partner_id = $2::uuid AND channel = $3 AND chat_id = $4::bigint
   FOR UPDATE`;

function toDraft(r: DraftRowDb): Draft {
  return {
    id: r.id,
    tourId: r.tour_id,
    candidateIds: r.candidate_ids ?? [],
    field: r.field as EditField,
    newValue: r.new_value as EditValue,
    liveValue: r.live_value,
  };
}

/** Почему кнопка черновика ничего не сделала. */
export type DraftBlocked =
  | { kind: 'not_found' }
  | { kind: 'saved_before' }
  | { kind: 'cancelled_before' }
  | { kind: 'superseded' }
  | { kind: 'expired' }
  | { kind: 'db_error' };

function blockedOf(r: DraftRowDb): DraftBlocked | null {
  if (r.status === 'saved') return { kind: 'saved_before' };
  if (r.status === 'cancelled') return { kind: 'cancelled_before' };
  if (r.status === 'superseded') return { kind: 'superseded' };
  if (r.expired) return { kind: 'expired' };
  return null;
}

interface Who { partnerId: string; channel: EditChannel; chatId: number; draftId: string }

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

export type ChooseTour =
  | { kind: 'chosen'; draft: Draft; tour: ChatTour }
  | { kind: 'stale_button' }
  | DraftBlocked;

/** Кнопка выбора тура у черновика без тура: тур — из кандидатов черновика, свой. */
export async function chooseDraftTour(who: Who, index: number): Promise<ChooseTour> {
  return inTx<ChooseTour>('выбор тура черновика', async (c) => {
    const { rows } = await c.query<DraftRowDb>(LOCK_DRAFT_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked) return blocked;
    if (row.tour_id !== null) {
      // Повтор той же кнопки: тур уже выбран — показать предпросмотр снова.
      const t = await readEditTour(who.partnerId, row.tour_id, c);
      if (t.outcome !== 'ok') return t.outcome === 'db_error' ? { kind: 'db_error' } : { kind: 'not_found' };
      return { kind: 'chosen', draft: toDraft(row), tour: t.tour };
    }
    const tourId = (row.candidate_ids ?? [])[index];
    if (tourId === undefined) return { kind: 'stale_button' };
    const t = await readEditTour(who.partnerId, tourId, c);
    if (t.outcome === 'db_error') throw new Error('тур не прочитан');
    if (t.outcome === 'not_found') return { kind: 'not_found' };
    const live = t.tour.fields[row.field as EditField] ?? null;
    await c.query(
      `UPDATE tour_chat_edits SET tour_id = $2::bigint, live_value = $3::jsonb WHERE id = $1::uuid`,
      [who.draftId, tourId, JSON.stringify(live)],
    );
    return { kind: 'chosen', draft: { ...toDraft(row), tourId, liveValue: live }, tour: t.tour };
  }, { kind: 'db_error' });
}

export type SaveDraft =
  | { kind: 'saved'; draft: Draft; title: string; slug: string | null }
  /** Тур поменяли после предпросмотра: ничего не записано, вот новое «было». */
  | { kind: 'changed'; draft: Draft; tour: ChatTour }
  | { kind: 'need_tour' }
  | { kind: 'tour_gone' }
  | DraftBlocked;

/**
 * «Сохранить»: единственное место, где правка из чата доходит до тура.
 * Черновик и тур — под блокировкой; запись — `writeTourPatch` с владельцем
 * в самом UPDATE; отметка «сохранён» — в той же транзакции.
 */
export async function saveDraft(who: Who): Promise<SaveDraft> {
  const out = await inTx<SaveDraft>('сохранение правки тура', async (c) => {
    const { rows } = await c.query<DraftRowDb>(LOCK_DRAFT_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked) return blocked;
    if (row.tour_id === null) return { kind: 'need_tour' };
    const draft = toDraft(row);
    const locked = await c.query<TourRowDb & { main_place_id: string | null }>(
      `SELECT ${TOUR_COLUMNS}, t.main_place_id
         FROM operator_tours t
        WHERE t.id = $2::bigint AND t.operator_id = $1::uuid AND t.deleted_at IS NULL
        FOR UPDATE`,
      [who.partnerId, row.tour_id],
    );
    const tourRow = locked.rows[0];
    if (!tourRow) return { kind: 'tour_gone' };
    const tour = toTour(tourRow);
    const now = tour.fields[draft.field] ?? null;
    if (!sameValue(now, draft.liveValue)) {
      // «Было» в предпросмотре устарело: тур правили на сайте или другой
      // кнопкой. Черновик живёт дальше с новым «было» — гид видит его и решает.
      await c.query(`UPDATE tour_chat_edits SET live_value = $2::jsonb WHERE id = $1::uuid`, [who.draftId, JSON.stringify(now)]);
      return { kind: 'changed', draft: { ...draft, liveValue: now }, tour };
    }
    const input = { [draft.field]: draft.newValue } as TourPatchInput;
    const written = await writeTourPatch(c, {
      tourId: row.tour_id,
      ownerId: who.partnerId,
      input,
      current: tourRow as unknown as Record<string, unknown>,
    });
    if (written.outcome !== 'written') {
      // Тур проверен под блокировкой строкой выше: сюда не доходит, но
      // «записал» без записи сказать нельзя.
      throw new Error(`тур не записан: ${written.outcome}`);
    }
    await c.query(
      `UPDATE tour_chat_edits SET status = 'saved', decided_at = NOW() WHERE id = $1::uuid AND status = 'pending'`,
      [who.draftId],
    );
    return { kind: 'saved', draft, title: written.row.title, slug: tour.slug };
  }, { kind: 'db_error' });
  if (out.kind === 'saved' && out.draft.tourId) pingTourChanged(out.draft.tourId);
  return out;
}

export type CancelDraft = { kind: 'cancelled' } | DraftBlocked;

export async function cancelDraft(who: Who): Promise<CancelDraft> {
  return inTx<CancelDraft>('отмена правки тура', async (c) => {
    const { rows } = await c.query<DraftRowDb>(LOCK_DRAFT_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked && blocked.kind !== 'expired') return blocked;
    await c.query(`UPDATE tour_chat_edits SET status = 'cancelled', decided_at = NOW() WHERE id = $1::uuid`, [who.draftId]);
    return { kind: 'cancelled' };
  }, { kind: 'db_error' });
}

// ── Даты тура ───────────────────────────────────────────────────────────────

export interface TourDay {
  date: string;
  /** null — строки календаря нет (дата не открыта). */
  slots: number | null;
  closed: boolean;
  taken: number;
}

export type TourDays = { outcome: 'ok'; tour: ChatTour; days: TourDay[] } | { outcome: 'not_found' } | { outcome: 'db_error' };

/** Дни тура с `from` по `to` включительно: места, закрыта ли, сколько записано. */
export async function readTourDays(partnerId: string, tourId: string, from: string, to: string): Promise<TourDays> {
  const t = await readEditTour(partnerId, tourId);
  if (t.outcome !== 'ok') return t;
  try {
    const { rows } = await pool.query<{ date: string; slots: number | null; closed: boolean; taken: number }>(
      `SELECT d.date::text AS date,
              ta.available_slots AS slots,
              COALESCE(ta.is_cancelled, FALSE) AS closed,
              GREATEST(COALESCE(ta.booked_slots, 0), occ.taken)::int AS taken
         FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS d(date)
         LEFT JOIN tour_availability ta
                ON ta.operator_tour_id = $1::bigint AND ta.date = d.date::date AND ta.deleted_at IS NULL
         CROSS JOIN LATERAL (
           ${occupiedOnDaySql({ booking: 'b', day: 'd.date::date', tourId: '$1::bigint' })}
         ) occ
        ORDER BY d.date`,
      [tourId, from, to],
    );
    return {
      outcome: 'ok',
      tour: t.tour,
      days: rows.map((r) => ({ date: r.date.slice(0, 10), slots: r.slots, closed: r.closed === true, taken: Number(r.taken) })),
    };
  } catch (err) {
    logFail('дни тура', err);
    return { outcome: 'db_error' };
  }
}
