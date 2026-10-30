/**
 * Роль гида в чате кабинета, этап 2 — база (миграция 1358, `guide_chat_drafts`).
 *
 * Слово владельца 30.10: «гид должен полностью управлять своей ролью из MAX».
 * Ответ на отзыв и поле профиля живут черновиком до кнопки; кнопка в одной
 * транзакции блокирует черновик и то, что он правит (отзыв, карточку гида),
 * сверяет «было» из предпросмотра с тем, что в базе сейчас, и пишет ОБЩЕЙ
 * функцией сайта (`writeGuideReviewReply`, `writeGuideProfilePatch`). Без
 * нажатия не пишется ничего.
 *
 * Чьё: черновик — строка этой карточки И этого чата; отзыв — по
 * `guide_reviews.guide_id` карточки; профиль — карточка гида чата. Чужое —
 * «не найдено», ни строки не тронуто.
 *
 * Отказ базы — свой исход (`db_error`), не «нет отзывов» и не «не найдено»
 * (§4.0): в лог — имя шага и SQLSTATE, без текста.
 */

import type { PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { publicReviewerName } from '@/lib/reviews/public-name';
import { notifyTouristOfReply, writeGuideReviewReply, type RunSql } from '@/lib/guides/review-reply';
import { UpdateGuideProfileSchema, writeGuideProfilePatch, type GuideProfilePatch } from '@/lib/guides/profile-write';
import type { ProfileField, ProfileValue } from './parse';

export type RoleChannel = 'max' | 'telegram';

/** Сколько ждёт текст ответа после «Ответить». */
export const AWAIT_TEXT_MINUTES = 30;
/** Сколько живёт предпросмотр до кнопки. */
export const DRAFT_TTL_HOURS = 2;
/** Отзывов на странице списка. */
export const REVIEWS_PAGE_SIZE = 5;

function sqlstate(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? 'нет SQLSTATE';
}

function logFail(what: string, err: unknown): void {
  console.error(`[guide-chat-role] ${what} — отказ, SQLSTATE ${sqlstate(err)}`);
}

type Db = Pick<PoolClient, 'query'>;

function runOf(c: Db): RunSql {
  return async (text, params) => c.query(text, params);
}

// ── Отзывы ──────────────────────────────────────────────────────────────────

export interface ChatReview {
  id: string;
  rating: number;
  comment: string | null;
  /** Имя автора как на публичной странице («Анна П.»); полного имени здесь нет. */
  author: string;
  isPublic: boolean;
  reply: string | null;
  createdAt: string;
}

interface ReviewRowDb {
  id: string; rating: number; comment: string | null; author_name: string | null; is_public: boolean | null;
  guide_reply: string | null; created_at: string;
}

const REVIEW_COLUMNS = `gr.id::text AS id, gr.rating, gr.comment, u.name AS author_name, gr.is_public,
       gr.guide_reply, to_char(gr.created_at AT TIME ZONE 'Asia/Kamchatka', 'YYYY-MM-DD') AS created_at`;

function toReview(r: ReviewRowDb): ChatReview {
  return {
    id: r.id,
    rating: Number(r.rating),
    comment: r.comment && r.comment.trim() ? r.comment : null,
    // Полное имя наружу не уходит: только подпись публичной страницы.
    author: publicReviewerName(r.author_name),
    isPublic: r.is_public !== false,
    reply: r.guide_reply && r.guide_reply.length > 0 ? r.guide_reply : null,
    createdAt: r.created_at,
  };
}

export type OwnReview = { outcome: 'ok'; review: ChatReview } | { outcome: 'not_found' } | { outcome: 'db_error' };

/** Отзыв о гиде этой карточки. */
export async function readOwnReview(partnerId: string, reviewId: string, db: Db = pool): Promise<OwnReview> {
  try {
    const { rows } = await db.query<ReviewRowDb>(
      `SELECT ${REVIEW_COLUMNS}
         FROM guide_reviews gr
         LEFT JOIN users u ON u.id = gr.tourist_id
        WHERE gr.id = $2::uuid AND gr.guide_id = $1::uuid`,
      [partnerId, reviewId],
    );
    const row = rows[0];
    return row ? { outcome: 'ok', review: toReview(row) } : { outcome: 'not_found' };
  } catch (err) {
    logFail('отзыв', err);
    return { outcome: 'db_error' };
  }
}

export type OwnReviews = { outcome: 'ok'; reviews: ChatReview[]; total: number } | { outcome: 'db_error' };

/** Отзывы о гиде, свежие сверху — те же, что в «Отзывах» кабинета (публичные). */
export async function listOwnReviews(partnerId: string, page: number): Promise<OwnReviews> {
  try {
    const [list, count] = await Promise.all([
      pool.query<ReviewRowDb>(
        `SELECT ${REVIEW_COLUMNS}
           FROM guide_reviews gr
           LEFT JOIN users u ON u.id = gr.tourist_id
          WHERE gr.guide_id = $1::uuid AND gr.is_public = TRUE
          ORDER BY gr.created_at DESC, gr.id
          LIMIT $2 OFFSET $3`,
        [partnerId, REVIEWS_PAGE_SIZE, Math.max(0, page) * REVIEWS_PAGE_SIZE],
      ),
      pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM guide_reviews WHERE guide_id = $1::uuid AND is_public = TRUE`,
        [partnerId],
      ),
    ]);
    return { outcome: 'ok', reviews: list.rows.map(toReview), total: count.rows[0]?.n ?? 0 };
  } catch (err) {
    logFail('отзывы', err);
    return { outcome: 'db_error' };
  }
}

// ── Профиль ─────────────────────────────────────────────────────────────────

export interface ChatProfile {
  name: string;
  profileStatus: string | null;
  /** Текущие значения полей правки — для «было». */
  fields: Record<ProfileField, ProfileValue | null>;
}

interface ProfileRowDb {
  name: string; profile_status: string | null; description: string | null;
  experience_years: number | null; languages: string[] | null;
}

/** Значение поля профиля в одном виде: пусто — null. */
export function normalizeProfile(field: ProfileField, raw: unknown): ProfileValue | null {
  if (raw === null || raw === undefined) return null;
  if (field === 'experience_years') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (field === 'languages') {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map((x) => String(x));
  }
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function toProfile(r: ProfileRowDb): ChatProfile {
  return {
    name: r.name,
    profileStatus: r.profile_status,
    fields: {
      description: normalizeProfile('description', r.description),
      experience_years: normalizeProfile('experience_years', r.experience_years),
      languages: normalizeProfile('languages', r.languages),
    },
  };
}

const PROFILE_SQL = `SELECT name, profile_status, description, experience_years, languages
    FROM partners WHERE id = $1::uuid AND category = 'guide'`;

export type OwnProfile = { outcome: 'ok'; profile: ChatProfile } | { outcome: 'not_found' } | { outcome: 'db_error' };

export async function readOwnProfile(partnerId: string): Promise<OwnProfile> {
  try {
    const { rows } = await pool.query<ProfileRowDb>(PROFILE_SQL, [partnerId]);
    const row = rows[0];
    return row ? { outcome: 'ok', profile: toProfile(row) } : { outcome: 'not_found' };
  } catch (err) {
    logFail('профиль', err);
    return { outcome: 'db_error' };
  }
}

// ── Черновик ────────────────────────────────────────────────────────────────

export type DraftKind = 'reply' | 'reply_delete' | 'profile';

export interface Draft {
  id: string;
  kind: DraftKind;
  reviewId: string | null;
  field: ProfileField | null;
  newValue: unknown;
  liveValue: unknown;
}

/** Открытые черновики чата обеих таблиц снимаются: старая кнопка больше не пишет. */
const SUPERSEDE_DRAFTS_SQL = `UPDATE guide_chat_drafts SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status IN ('awaiting_text', 'pending')`;
const SUPERSEDE_TOUR_EDITS_SQL = `UPDATE tour_chat_edits SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`;
const SUPERSEDE_TOUR_DOCS_SQL = `UPDATE tour_doc_drafts SET status = 'superseded', decided_at = NOW()
  WHERE channel = $1 AND chat_id = $2::bigint AND status = 'pending'`;

/**
 * Ожидания текста этого чата, которые «Ответить» снимает: последняя кнопка
 * главная. Иначе ответ на отзыв ушёл бы туристу причиной отказа брони,
 * клиенту — сообщением по заявке или в поиск клиента.
 */
const SUPERSEDE_WAITS_SQL = [
  `UPDATE chat_cabinet_waits SET status = 'superseded'
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'waiting'`,
  `UPDATE partner_chat_actions SET status = 'superseded'
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'awaiting_reason'`,
  `UPDATE request_chat_waits SET status = 'superseded'
    WHERE channel = $1 AND chat_id = $2::bigint AND status = 'waiting'`,
];

export const CREATE_ROLE_DRAFT_SQL = `INSERT INTO guide_chat_drafts
    (partner_id, channel, chat_id, kind, review_id, field, new_value, live_value, status, expires_at)
  VALUES ($1::uuid, $2, $3::bigint, $4, $5::uuid, $6, $7::jsonb, $8::jsonb, $9,
          NOW() + make_interval(mins => $10::int))
  RETURNING id::text AS id`;

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

export type CreateDraft = { outcome: 'created'; id: string } | { outcome: 'db_error' };

/**
 * Новый черновик чата: прежние открытые черновики (и правка тура 1357)
 * снимаются в той же транзакции. `awaiting` — ждать текст ответа следующим
 * сообщением (тогда снимаются и чужие ожидания текста этого чата).
 */
export async function createRoleDraft(input: {
  partnerId: string;
  channel: RoleChannel;
  chatId: number;
  kind: DraftKind;
  reviewId: string | null;
  field: ProfileField | null;
  newValue: unknown;
  liveValue: unknown;
  awaiting: boolean;
}): Promise<CreateDraft> {
  return inTx<CreateDraft>('черновик гида', async (c) => {
    const chat = [input.channel, String(input.chatId)];
    await c.query(SUPERSEDE_DRAFTS_SQL, chat);
    await c.query(SUPERSEDE_TOUR_EDITS_SQL, chat);
    await c.query(SUPERSEDE_TOUR_DOCS_SQL, chat);
    if (input.awaiting) for (const sql of SUPERSEDE_WAITS_SQL) await c.query(sql, chat);
    const { rows } = await c.query<{ id: string }>(CREATE_ROLE_DRAFT_SQL, [
      input.partnerId, input.channel, String(input.chatId), input.kind, input.reviewId, input.field,
      input.awaiting ? null : JSON.stringify(input.newValue ?? null), JSON.stringify(input.liveValue ?? null),
      input.awaiting ? 'awaiting_text' : 'pending',
      input.awaiting ? AWAIT_TEXT_MINUTES : DRAFT_TTL_HOURS * 60,
    ]);
    const id = rows[0]?.id;
    return id ? { outcome: 'created', id } : { outcome: 'db_error' };
  }, { outcome: 'db_error' });
}

/**
 * Ждёт ли этот чат текст ответа на отзыв. `newer` — после «Ответить» в этом
 * чате нажата кнопка, которая тоже ждёт текст (причина отказа брони, ответ
 * клиенту): последняя кнопка главная, ответ на отзыв уступает.
 */
export const AWAITING_SQL = `
  SELECT d.id::text AS id, d.partner_id::text AS partner_id, d.review_id::text AS review_id, d.live_value,
         (EXISTS (SELECT 1 FROM partner_chat_actions a
                   WHERE a.channel = d.channel AND a.chat_id = d.chat_id AND a.created_at > d.created_at)
          OR EXISTS (SELECT 1 FROM request_chat_waits r
                      WHERE r.channel = d.channel AND r.chat_id = d.chat_id AND r.created_at > d.created_at)) AS newer
    FROM guide_chat_drafts d
   WHERE d.channel = $1 AND d.chat_id = $2::bigint AND d.status = 'awaiting_text' AND d.expires_at > NOW()`;

export interface Awaiting {
  id: string;
  partnerId: string;
  reviewId: string;
  liveValue: unknown;
  newer: boolean;
}

/** Три исхода: ждёт (строка), не ждёт (null), не смог проверить ('db_error'). */
export async function findAwaitingReply(channel: RoleChannel, chatId: number): Promise<Awaiting | null | 'db_error'> {
  try {
    const { rows } = await pool.query<{ id: string; partner_id: string; review_id: string; live_value: unknown; newer: boolean }>(
      AWAITING_SQL, [channel, String(chatId)],
    );
    const r = rows[0];
    return r ? { id: r.id, partnerId: r.partner_id, reviewId: r.review_id, liveValue: r.live_value, newer: r.newer === true } : null;
  } catch (err) {
    logFail('ждёт ли чат ответ на отзыв', err);
    return 'db_error';
  }
}

/** Снять ожидание текста: «cancelled» — гид сказал «отмена», иначе «superseded». */
export async function dropAwaiting(draftId: string, status: 'cancelled' | 'superseded'): Promise<void> {
  try {
    await pool.query(
      `UPDATE guide_chat_drafts SET status = $2, decided_at = NOW() WHERE id = $1::uuid AND status = 'awaiting_text'`,
      [draftId, status],
    );
  } catch (err) {
    logFail('снятие ожидания ответа', err);
  }
}

/**
 * Другая кнопка кабинета снимает ожидание ответа: экран «Напишите ответ»
 * правкой уже заменён, и следующее сообщение — не ответ туристу. Отказ не
 * останавливает нажатие: ожидание истечёт через 30 минут.
 */
export async function dropAwaitingForChat(channel: RoleChannel, chatId: number): Promise<void> {
  try {
    await pool.query(
      `UPDATE guide_chat_drafts SET status = 'superseded', decided_at = NOW()
        WHERE channel = $1 AND chat_id = $2::bigint AND status = 'awaiting_text'`,
      [channel, String(chatId)],
    );
  } catch (err) {
    logFail('снятие ожидания ответа другой кнопкой', err);
  }
}

/** Текст пришёл: ожидание становится предпросмотром. false — его уже забрали (повтор апдейта). */
export async function fillAwaiting(draftId: string, text: string): Promise<boolean | 'db_error'> {
  try {
    const r = await pool.query(
      `UPDATE guide_chat_drafts
          SET new_value = $2::jsonb, status = 'pending', expires_at = NOW() + make_interval(hours => $3::int)
        WHERE id = $1::uuid AND status = 'awaiting_text'`,
      [draftId, JSON.stringify(text), DRAFT_TTL_HOURS],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logFail('текст ответа в черновик', err);
    return 'db_error';
  }
}

interface DraftRowDb {
  id: string; kind: string; review_id: string | null; field: string | null; new_value: unknown;
  live_value: unknown; status: string; expired: boolean;
}

const LOCK_DRAFT_SQL = `SELECT id::text AS id, kind, review_id::text AS review_id, field, new_value, live_value, status,
         (expires_at < NOW()) AS expired
    FROM guide_chat_drafts
   WHERE id = $1::uuid AND partner_id = $2::uuid AND channel = $3 AND chat_id = $4::bigint
   FOR UPDATE`;

function toDraft(r: DraftRowDb): Draft {
  return {
    id: r.id,
    kind: r.kind as DraftKind,
    reviewId: r.review_id,
    field: r.field as ProfileField | null,
    newValue: r.new_value,
    liveValue: r.live_value,
  };
}

export type DraftBlocked =
  | { kind: 'not_found' }
  | { kind: 'saved_before' }
  | { kind: 'cancelled_before' }
  | { kind: 'superseded' }
  | { kind: 'expired' }
  | { kind: 'awaiting_text' }
  | { kind: 'db_error' };

function blockedOf(r: DraftRowDb): DraftBlocked | null {
  if (r.status === 'saved') return { kind: 'saved_before' };
  if (r.status === 'cancelled') return { kind: 'cancelled_before' };
  if (r.status === 'superseded') return { kind: 'superseded' };
  if (r.expired) return { kind: 'expired' };
  if (r.status === 'awaiting_text') return { kind: 'awaiting_text' };
  return null;
}

export interface Who { partnerId: string; channel: RoleChannel; chatId: number; draftId: string }

/** Канонический вид для сравнения «было»: ключи по порядку, пусто — null. */
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

const PROFILE_PATCH_KEY: Readonly<Record<ProfileField, keyof GuideProfilePatch>> = {
  description: 'description',
  experience_years: 'experienceYears',
  languages: 'languages',
};

export type SaveDraft =
  | { kind: 'saved'; draft: Draft }
  /** То, что правит черновик, поменяли после предпросмотра: ничего не записано, вот новое «было». */
  | { kind: 'changed'; draft: Draft }
  /** Отзыв удалён или больше не этой карточки. */
  | { kind: 'target_gone' }
  /** Ответ уже удалён — удалять нечего. */
  | { kind: 'nothing_to_delete' }
  | { kind: 'invalid'; error: string }
  | DraftBlocked;

/**
 * Кнопка черновика («Опубликовать», «Удалить», «Сохранить»): единственное
 * место, где ответ на отзыв и профиль из чата доходят до базы. Пишет общая
 * функция сайта; отметка «сохранён» — в той же транзакции.
 */
export async function saveRoleDraft(who: Who): Promise<SaveDraft> {
  const after: { notify: { review: Record<string, unknown>; reviewId: string } | null } = { notify: null };
  const out = await inTx<SaveDraft>('сохранение черновика гида', async (c) => {
    const { rows } = await c.query<DraftRowDb>(LOCK_DRAFT_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked) return blocked;
    const draft = toDraft(row);
    const markSaved = () => c.query(
      `UPDATE guide_chat_drafts SET status = 'saved', decided_at = NOW() WHERE id = $1::uuid AND status = 'pending'`,
      [who.draftId],
    );
    const refreshLive = async (now: unknown): Promise<SaveDraft> => {
      // «Было» в предпросмотре устарело: правили на сайте или другой кнопкой.
      // Черновик живёт дальше с новым «было» — гид видит его и решает.
      await c.query(`UPDATE guide_chat_drafts SET live_value = $2::jsonb WHERE id = $1::uuid`, [who.draftId, JSON.stringify(now ?? null)]);
      return { kind: 'changed', draft: { ...draft, liveValue: now ?? null } };
    };

    if (draft.kind === 'profile') {
      const field = draft.field as ProfileField;
      const locked = await c.query<ProfileRowDb>(`${PROFILE_SQL} FOR UPDATE`, [who.partnerId]);
      const prow = locked.rows[0];
      if (!prow) return { kind: 'target_gone' };
      const now = toProfile(prow).fields[field];
      if (!sameValue(now, draft.liveValue)) return refreshLive(now);
      const parsed = UpdateGuideProfileSchema.safeParse({ [PROFILE_PATCH_KEY[field]]: draft.newValue });
      if (!parsed.success) return { kind: 'invalid', error: parsed.error.issues[0]?.message ?? 'Некорректное значение' };
      const written = await writeGuideProfilePatch(c, { partnerId: who.partnerId, userId: null, patch: parsed.data });
      if (!written) return { kind: 'target_gone' };
      await markSaved();
      return { kind: 'saved', draft };
    }

    const reviewId = draft.reviewId as string;
    const locked = await c.query<{ guide_reply: string | null }>(
      `SELECT guide_reply FROM guide_reviews WHERE id = $1::uuid AND guide_id = $2::uuid FOR UPDATE`,
      [reviewId, who.partnerId],
    );
    const rrow = locked.rows[0];
    if (!rrow) return { kind: 'target_gone' };
    const now = rrow.guide_reply && rrow.guide_reply.length > 0 ? rrow.guide_reply : null;
    if (!sameValue(now, draft.liveValue)) return refreshLive(now);
    if (draft.kind === 'reply_delete' && now === null) return { kind: 'nothing_to_delete' };
    const action = draft.kind === 'reply_delete' ? 'delete' : now === null ? 'post' : 'update';
    const written = await writeGuideReviewReply(runOf(c), {
      owner: { partnerId: who.partnerId },
      reviewId,
      action,
      reply: typeof draft.newValue === 'string' ? draft.newValue : null,
    });
    if (written.outcome === 'invalid') return { kind: 'invalid', error: written.error };
    if (written.outcome === 'not_found') return { kind: 'target_gone' };
    await markSaved();
    if (action === 'post') after.notify = { review: written.review, reviewId };
    return { kind: 'saved', draft };
  }, { kind: 'db_error' });
  // Уведомление туристу — после фиксации: его отказ не отменяет ответ.
  if (out.kind === 'saved' && after.notify) await notifyTouristOfReply(runOf(pool), after.notify.review, after.notify.reviewId);
  return out;
}

export type CancelDraft = { kind: 'cancelled' } | DraftBlocked;

export async function cancelRoleDraft(who: Who): Promise<CancelDraft> {
  return inTx<CancelDraft>('отмена черновика гида', async (c) => {
    const { rows } = await c.query<DraftRowDb>(LOCK_DRAFT_SQL, [who.draftId, who.partnerId, who.channel, String(who.chatId)]);
    const row = rows[0];
    if (!row) return { kind: 'not_found' };
    const blocked = blockedOf(row);
    if (blocked && blocked.kind !== 'expired' && blocked.kind !== 'awaiting_text') return blocked;
    await c.query(`UPDATE guide_chat_drafts SET status = 'cancelled', decided_at = NOW() WHERE id = $1::uuid`, [who.draftId]);
    return { kind: 'cancelled' };
  }, { kind: 'db_error' });
}
