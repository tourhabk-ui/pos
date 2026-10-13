/**
 * Отзывы о перевозчике — чтение и запись (миграция 1235; правила —
 * lib/transfers/carrier-review-rules; слово владельца 13.10 «делай блок
 * отзывов но логично»).
 *
 * Путь записи один — машина под заказ: ключ одноразовой ссылки, выданной
 * менеджером Ведара после подтверждения «поездка состоялась». Пути «место в
 * поездке» нет: машину заказывают целиком (владелец 13.10). Один отзыв на
 * заявку держит UNIQUE в базе: повтор — «уже есть», а не второй отзыв.
 *
 * Чтение для страницы — с тремя исходами: отзывы / пусто / не смогли
 * проверить. Пустой список при отказе базы читался бы как «отзывов нет».
 */

import { createHash, randomBytes } from 'crypto';
import { query, transaction } from '@/lib/database';
import { publicReviewerName } from '@/lib/reviews/public-name';
import { logText } from '@/lib/log/log-text';
import {
  CARRIER_REVIEW_INVITE_DAYS,
  inviteIssueVerdict,
  inviteKeyVerdict,
  isoDateOrNull,
  roundedAverage,
  type CarrierReviewProof,
} from '@/lib/transfers/carrier-review-rules';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function logFailure(what: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[transfers/carrier-reviews] ${what}: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
    logText(err instanceof Error ? err.message : err, 200),
  );
}

export function hashInviteKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Адрес перевозчика в адресной строке — тот же образец, что у его страницы. */
export const CARRIER_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export interface ReviewedCarrier {
  partnerId: string;
  slug: string;
  name: string;
}

/**
 * Перевозчик для отзыва — тот же отбор, что у его страницы (публичный, род
 * transfer), но без прайса и парка. null — такого нет; отказ базы — исключение.
 */
export async function findPublicCarrier(slug: string): Promise<ReviewedCarrier | null> {
  if (!CARRIER_SLUG_RE.test(slug)) return null;
  const { rows } = await query<{ id: string; slug: string; name: string }>(
    `SELECT id::text, slug, name FROM partners
      WHERE slug = $1 AND is_public = TRUE AND category = 'transfer'
      LIMIT 1`,
    [slug],
  );
  const r = rows[0];
  return r ? { partnerId: r.id, slug: r.slug, name: r.name } : null;
}

// ── Публичный блок ────────────────────────────────────────────────────────

export interface PublicCarrierReview {
  id: string;
  /** «Имя Ф.» — publicReviewerName. */
  authorName: string;
  rating: number;
  comment: string;
  createdAt: string;
  proof: CarrierReviewProof;
  rideDate: string | null;
  rideFrom: string | null;
  rideTo: string | null;
}

export type CarrierReviewsBlock =
  | { state: 'ok'; items: PublicCarrierReview[]; count: number; average: number | null }
  | { state: 'failed' };

/** Сколько последних отзывов показывает страница. */
export const CARRIER_REVIEWS_SHOWN = 20;

export async function loadCarrierReviews(partnerId: string): Promise<CarrierReviewsBlock> {
  try {
    const [list, summary] = await Promise.all([
      query<{
        id: string; author_name: string; rating: number; comment: string; created_at: string;
        proof: CarrierReviewProof; ride_date: string | null; ride_from: string | null; ride_to: string | null;
      }>(
        `SELECT id::text, author_name, rating, comment, created_at::text AS created_at, proof,
                to_char(ride_date, 'YYYY-MM-DD') AS ride_date, ride_from, ride_to
           FROM carrier_reviews
          WHERE partner_id = $1 AND is_hidden = FALSE
          ORDER BY created_at DESC
          LIMIT $2`,
        [partnerId, CARRIER_REVIEWS_SHOWN],
      ),
      // Сводка — по ВСЕМ видимым, а не по показанным двадцати: иначе средняя
      // менялась бы от того, сколько строк влезло на страницу.
      query<{ n: number; avg: string | null }>(
        `SELECT COUNT(*)::int AS n, AVG(rating)::text AS avg
           FROM carrier_reviews
          WHERE partner_id = $1 AND is_hidden = FALSE`,
        [partnerId],
      ),
    ]);
    const count = summary.rows[0]?.n ?? 0;
    return {
      state: 'ok',
      count,
      average: roundedAverage(count, summary.rows[0]?.avg ?? null),
      items: list.rows.map((r) => ({
        id: r.id,
        authorName: publicReviewerName(r.author_name),
        rating: Number(r.rating),
        comment: r.comment,
        createdAt: r.created_at,
        proof: r.proof,
        rideDate: r.ride_date,
        rideFrom: r.ride_from,
        rideTo: r.ride_to,
      })),
    };
  } catch (err) {
    logFailure('отзывы не прочитаны', err);
    return { state: 'failed' };
  }
}

export type WriteReviewResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'used' };


// ── Машина под заказ: ссылка ──────────────────────────────────────────────

export type InviteCheck =
  | { state: 'ok'; destination: string | null; dateFrom: string | null; dateTo: string | null }
  | { state: 'unknown' | 'expired' | 'used' };

interface InviteRow {
  lead_id: string;
  expires_at: string;
  used_at: string | null;
  destination: string | null;
  date_from: string | null;
  date_to: string | null;
}

const INVITE_SQL = `
  SELECT i.lead_id::text, i.expires_at::text AS expires_at, i.used_at::text AS used_at,
         l.source_data->>'destination' AS destination,
         l.source_data->>'date_from' AS date_from,
         l.source_data->>'date_to' AS date_to
    FROM carrier_review_invites i
    JOIN leads l ON l.id = i.lead_id
   WHERE i.key_hash = $1 AND i.partner_id = $2`;

/** Что за поездка по ключу ссылки — без имени и телефона заказчика. */
export async function checkInvite(partnerId: string, key: string, now: number = Date.now()): Promise<InviteCheck> {
  const { rows } = await query<InviteRow>(INVITE_SQL, [hashInviteKey(key), partnerId]);
  const row = rows[0];
  if (!row) return { state: 'unknown' };
  const v = inviteKeyVerdict({ expiresAt: row.expires_at, usedAt: row.used_at }, now);
  if (!v.ok) return { state: v.reason };
  return {
    state: 'ok',
    destination: row.destination,
    dateFrom: isoDateOrNull(row.date_from),
    dateTo: isoDateOrNull(row.date_to),
  };
}

export async function writeInviteReview(p: {
  partnerId: string;
  key: string;
  authorName: string;
  rating: number;
  comment: string;
  now?: number;
}): Promise<WriteReviewResult> {
  return transaction<WriteReviewResult>(async (client) => {
    // FOR UPDATE: два отправления формы одной ссылкой не должны оба пройти
    // проверку «не использована» до того, как первое её погасит.
    const { rows } = await client.query<InviteRow>(`${INVITE_SQL} FOR UPDATE OF i`, [hashInviteKey(p.key), p.partnerId]);
    const row = rows[0];
    if (!row) return { ok: false, reason: 'unknown' } as const;
    const v = inviteKeyVerdict({ expiresAt: row.expires_at, usedAt: row.used_at }, p.now ?? Date.now());
    if (!v.ok) return { ok: false, reason: v.reason } as const;

    const ins = await client.query<{ id: string }>(
      `INSERT INTO carrier_reviews
         (partner_id, proof, lead_id, author_name, rating, comment, ride_date, ride_to)
       VALUES ($1, 'charter', $2, $3, $4, $5, $6::date, $7)
       ON CONFLICT (lead_id) DO NOTHING
       RETURNING id::text`,
      [p.partnerId, row.lead_id, p.authorName, p.rating, p.comment, isoDateOrNull(row.date_from), row.destination],
    );
    await client.query(`UPDATE carrier_review_invites SET used_at = NOW() WHERE lead_id = $1`, [row.lead_id]);
    return ins.rows[0] ? ({ ok: true, id: ins.rows[0].id } as const) : ({ ok: false, reason: 'used' } as const);
  });
}

export type IssueInviteResult =
  | { ok: true; key: string; slug: string; expiresAt: string }
  | { ok: false; reason: 'not_found' | 'no_date' | 'not_yet' | 'already_reviewed' };

/**
 * Менеджер подтверждает, что поездка по заявке состоялась, и получает ссылку
 * для заказчика. Ключ показывается один раз; в базе — хэш. Повторная выдача
 * по той же заявке заменяет ключ: прежняя ссылка перестаёт работать, а
 * первое подтверждение (кто и когда) остаётся.
 */
export async function issueCharterInvite(p: {
  leadId: string;
  confirmedBy: string | null;
  today: string;
  now?: number;
}): Promise<IssueInviteResult> {
  if (!UUID_RE.test(p.leadId)) return { ok: false, reason: 'not_found' };
  const { rows } = await query<{ partner_id: string; slug: string; date_from: string | null; reviewed: boolean }>(
    `SELECT p.id::text AS partner_id, p.slug, l.source_data->>'date_from' AS date_from,
            EXISTS (SELECT 1 FROM carrier_reviews cr WHERE cr.lead_id = l.id) AS reviewed
       FROM leads l
       JOIN partners p ON p.id = l.operator_id
      WHERE l.id = $1 AND l.source_data->>'kind' = 'charter' AND p.category = 'transfer'`,
    [p.leadId],
  );
  const lead = rows[0];
  if (!lead) return { ok: false, reason: 'not_found' };
  const v = inviteIssueVerdict({ dateFrom: isoDateOrNull(lead.date_from), reviewed: lead.reviewed }, p.today);
  if (!v.ok) return { ok: false, reason: v.reason };

  const key = randomBytes(24).toString('base64url');
  const expiresAt = new Date((p.now ?? Date.now()) + CARRIER_REVIEW_INVITE_DAYS * 86_400_000).toISOString();
  const confirmedBy = p.confirmedBy && UUID_RE.test(p.confirmedBy) ? p.confirmedBy : null;
  const up = await query<{ lead_id: string }>(
    `INSERT INTO carrier_review_invites (lead_id, partner_id, key_hash, ride_confirmed_by, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (lead_id) DO UPDATE
        SET key_hash = EXCLUDED.key_hash, expires_at = EXCLUDED.expires_at, issued_at = NOW()
      WHERE carrier_review_invites.used_at IS NULL
     RETURNING lead_id::text`,
    [p.leadId, lead.partner_id, hashInviteKey(key), confirmedBy, expiresAt],
  );
  if (!up.rows[0]) return { ok: false, reason: 'already_reviewed' };
  return { ok: true, key, slug: lead.slug, expiresAt };
}

// ── Модерация ─────────────────────────────────────────────────────────────

export interface AdminCarrierReview {
  id: string;
  carrier_name: string;
  carrier_slug: string;
  author_name: string;
  rating: number;
  comment: string;
  proof: CarrierReviewProof;
  ride_date: string | null;
  ride_from: string | null;
  ride_to: string | null;
  is_hidden: boolean;
  hidden_reason: string | null;
  created_at: string;
}

export async function listCarrierReviewsForAdmin(filter: 'all' | 'visible' | 'hidden'): Promise<AdminCarrierReview[]> {
  const where = filter === 'visible' ? 'WHERE r.is_hidden = FALSE' : filter === 'hidden' ? 'WHERE r.is_hidden = TRUE' : '';
  const { rows } = await query<AdminCarrierReview>(
    `SELECT r.id::text, p.name AS carrier_name, p.slug AS carrier_slug, r.author_name, r.rating, r.comment,
            r.proof, to_char(r.ride_date, 'YYYY-MM-DD') AS ride_date, r.ride_from, r.ride_to,
            r.is_hidden, r.hidden_reason, r.created_at::text AS created_at
       FROM carrier_reviews r
       JOIN partners p ON p.id = r.partner_id
       ${where}
      ORDER BY r.created_at DESC
      LIMIT 200`,
  );
  return rows;
}

export interface AdminCharterLead {
  lead_id: string;
  carrier_name: string;
  carrier_slug: string;
  customer_name: string | null;
  customer_phone: string | null;
  destination: string | null;
  date_from: string | null;
  date_to: string | null;
  passengers: string | null;
  created_at: string;
  is_self: boolean;
  ride_confirmed_at: string | null;
  link_issued_at: string | null;
  link_expires_at: string | null;
  review_id: string | null;
}

/**
 * Заявки на машину глазами менеджера: что подтвердить и кому выдать ссылку.
 * Имя и телефон заказчика — администратору: ссылку отправляет он.
 */
export async function listCharterLeadsForAdmin(): Promise<AdminCharterLead[]> {
  const { rows } = await query<AdminCharterLead>(
    `SELECT l.id::text AS lead_id, p.name AS carrier_name, p.slug AS carrier_slug,
            l.name AS customer_name, l.phone AS customer_phone,
            l.source_data->>'destination' AS destination,
            l.source_data->>'date_from' AS date_from,
            l.source_data->>'date_to' AS date_to,
            l.source_data->>'passengers' AS passengers,
            l.created_at::text AS created_at,
            COALESCE(l.is_self, FALSE) AS is_self,
            i.ride_confirmed_at::text AS ride_confirmed_at,
            i.issued_at::text AS link_issued_at,
            i.expires_at::text AS link_expires_at,
            cr.id::text AS review_id
       FROM leads l
       JOIN partners p ON p.id = l.operator_id AND p.category = 'transfer'
       LEFT JOIN carrier_review_invites i ON i.lead_id = l.id
       LEFT JOIN carrier_reviews cr ON cr.lead_id = l.id
      WHERE l.source_data->>'kind' = 'charter'
      ORDER BY COALESCE(l.source_data->>'date_from', '') DESC, l.created_at DESC
      LIMIT 100`,
  );
  return rows;
}

/** Скрыть с причиной или вернуть. null — такого отзыва нет. */
export async function setCarrierReviewHidden(id: string, hidden: boolean, reason: string | null): Promise<{ id: string } | null> {
  const { rows } = await query<{ id: string }>(
    `UPDATE carrier_reviews
        SET is_hidden = $2::boolean,
            hidden_reason = CASE WHEN $2::boolean THEN $3::text ELSE NULL END,
            hidden_at = CASE WHEN $2::boolean THEN NOW() ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1::bigint
      RETURNING id::text`,
    [id, hidden, reason],
  );
  return rows[0] ?? null;
}
