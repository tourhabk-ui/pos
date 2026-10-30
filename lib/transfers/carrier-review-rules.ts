/**
 * Отзывы о перевозчике — правила без базы и сети (слово владельца 13.10:
 * «делай блок отзывов но логично»; CLAUDE.md §14, миграция 1235).
 *
 * «Логично» значит одно: отзыв оставляет только тот, кто ехал, и каждый отзыв
 * называет, чем это доказано. Машину заказывают целиком (владелец 13.10:
 * «бронируют целую машину а не место в ней»), и заявка — не поездка: машина
 * ею не закрепляется, и состоялась ли поездка, система не знает. Право даёт
 * подтверждение менеджера Ведара «поездка состоялась» и одноразовая ссылка,
 * которую он отправляет заказчику ('charter').
 *
 * Род 'seat' (место в поездке) в схеме 1235 остался: продажа мест спрятана
 * вместе со своим модулем, и путь отзыва по месту снят с нею. Читатель
 * обязан понимать любое значение, которое допускает база, поэтому тип и
 * строка доказательства его знают.
 *
 * Род 'charter_carrier' (1353, #2862 этап B): поездку подтвердил САМ
 * перевозчик — кнопкой «Поездка состоялась» на следующий день после
 * поездки, по заявке, на которую он ответил «Беру». Отдельный род, а не
 * переиспользование «подтвердил менеджер»: читатель отзыва должен видеть,
 * чьё это слово.
 *
 * Анонимного пути нет. Рейтинг — из видимых отзывов при чтении.
 */

import { carrierPagePath } from '@/lib/transfers/charter-format';
import { plural } from '@/lib/home/data-freshness';

export type CarrierReviewProof = 'seat' | 'charter' | 'charter_carrier';

/** Кто подтвердил поездку по заявке (carrier_review_invites.confirmed_by_kind, 1353). */
export type RideConfirmedBy = 'manager' | 'carrier';

/** Род доказательства отзыва — по тому, кто подтвердил поездку. */
export function proofOfConfirmation(by: RideConfirmedBy): CarrierReviewProof {
  return by === 'carrier' ? 'charter_carrier' : 'charter';
}

/** Сколько живёт ссылка на отзыв по заявке на машину. */
export const CARRIER_REVIEW_INVITE_DAYS = 30;

/** Якорь блока отзывов на странице перевозчика. */
export const CARRIER_REVIEWS_ANCHOR = 'reviews';

/** Страница отзыва по ссылке менеджера. */
export function carrierReviewPath(slug: string): string {
  return `${carrierPagePath(slug)}/review`;
}

/**
 * Ссылка по заявке на машину. Ключ — во фрагменте (#): фрагмент не уходит на
 * сервер ни запросом страницы, ни заголовком Referer, и не оседает в логах.
 */
export function carrierReviewInviteUrl(baseUrl: string, slug: string, key: string): string {
  return `${baseUrl}${carrierReviewPath(slug)}#${key}`;
}

/** Ключ ссылки: 24 байта base64url — ровно 32 знака. */
export function isInviteKeyShape(key: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(key);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата в форме ГГГГ-ММ-ДД или null — чтобы мусор из JSON не уронил ::date. */
export function isoDateOrNull(v: unknown): string | null {
  return typeof v === 'string' && ISO_DATE.test(v) ? v : null;
}

// ── Машина под заказ ──────────────────────────────────────────────────────

export type InviteIssueVerdict =
  | { ok: true }
  | { ok: false; reason: 'no_date' | 'not_yet' | 'already_reviewed' };

/**
 * Можно ли подтвердить поездку по заявке и выдать ссылку: дата выезда уже
 * наступила (по Камчатке) и отзыва по заявке ещё нет. Подтвердить поездку,
 * которая впереди, нельзя — это было бы не подтверждение, а обещание.
 */
export function inviteIssueVerdict(f: { dateFrom: string | null; reviewed: boolean }, today: string): InviteIssueVerdict {
  if (f.reviewed) return { ok: false, reason: 'already_reviewed' };
  if (!f.dateFrom) return { ok: false, reason: 'no_date' };
  if (f.dateFrom > today) return { ok: false, reason: 'not_yet' };
  return { ok: true };
}

export type InviteKeyVerdict = { ok: true } | { ok: false; reason: 'expired' | 'used' };

export function inviteKeyVerdict(row: { expiresAt: Date | string; usedAt: Date | string | null }, now: number = Date.now()): InviteKeyVerdict {
  if (row.usedAt !== null) return { ok: false, reason: 'used' };
  if (new Date(row.expiresAt).getTime() <= now) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/** Что сказать человеку по ключу ссылки — словами, а не кодом. */
export function inviteProblemText(reason: 'unknown' | 'expired' | 'used'): string {
  switch (reason) {
    case 'used': return 'По этой ссылке отзыв уже оставлен. Одна поездка — один отзыв.';
    case 'expired': return `Ссылка устарела: она действует ${CARRIER_REVIEW_INVITE_DAYS} дней. Попросите менеджера Ведара прислать новую.`;
    case 'unknown': return 'Ссылка не найдена: возможно, она скопирована не целиком или менеджер уже прислал новую вместо неё.';
  }
}

/**
 * Подпись под отзывом по ссылке — то, что человек написал сам. Только буквы,
 * пробел, точка, дефис и апостроф, 2–60 знаков: в подписи не место телефону и
 * почте, а отзыв увидят все. null — подпись не годится.
 */
export function normalizeAuthorName(raw: string): string | null {
  const s = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) return null;
  return /^\p{L}[\p{L}\p{M} .'’-]*$/u.test(s) ? s : null;
}

// ── Показ ─────────────────────────────────────────────────────────────────

/** «12 октября»; дата не разобралась — как есть. */
export function rideDateWords(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export interface ReviewRideFacts {
  proof: CarrierReviewProof;
  rideDate: string | null;
  rideFrom: string | null;
  rideTo: string | null;
}

/**
 * Чем доказано, что автор ехал, — строка под отзывом. Её видит каждый, кто
 * читает отзыв: «логично» должно быть видно, а не только верно.
 */
export function reviewProofLine(r: ReviewRideFacts): string {
  const when = r.rideDate ? `, ${rideDateWords(r.rideDate)}` : '';
  if (r.proof === 'seat') {
    const way = r.rideFrom && r.rideTo ? ` ${r.rideFrom} — ${r.rideTo}` : '';
    return `Место в поездке${way}${when}: заказ через Ведар, перевозчик подтвердил`;
  }
  const where = r.rideTo ? `: ${r.rideTo}` : '';
  const who = r.proof === 'charter_carrier' ? 'перевозчик' : 'менеджер Ведара';
  return `Машина под заказ${where}${when}: поездку подтвердил ${who}`;
}

/**
 * Средняя по видимым отзывам с одним знаком; отзывов нет — null, а не ноль:
 * «0,0» читалось бы как оценка, которой никто не ставил.
 */
export function roundedAverage(count: number, avg: string | number | null): number | null {
  if (count <= 0 || avg === null) return null;
  const n = Number(avg);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** «4,7» — средняя по-русски. */
export function ratingWords(avg: number): string {
  return avg.toFixed(1).replace('.', ',');
}

export function reviewsCountWords(n: number): string {
  return `${n} ${plural(n, 'отзыв', 'отзыва', 'отзывов')}`;
}
