/**
 * Эко за отзыв о туре следуют за видимостью отзыва (решение владельца 24.09:
 * «списывай при скрытии»).
 *
 * За отзыв начисляется +50 и ещё +20 за свои фото (POST
 * /api/reviews/tour/[tourId]). Скрыт модератором — всё начисленное за него
 * возвращается: и польза (user:), и вклад (contrib:) — скрытый за нарушение
 * отзыв не поступок, а злоупотребление. Отзыв вернули — начисление
 * восстанавливается.
 *
 * Устроено как СВЕДЕНИЕ к цели, а не «списать N»: из журнала считается,
 * сколько по этому отзыву у человека сейчас, и проводится только разница.
 * Повторное скрытие того же отзыва ничего не спишет второй раз, цикл
 * «скрыли — вернули — скрыли» сходится к тому же итогу.
 *
 * Проводки — operation 'adjust' через system:correction: «ручные корректировки,
 * всегда видны в журнале» (ledger.ts). Закон 8 (вклад не отчуждается) прямо
 * допускает adjust со счёта вклада — это и есть видимое исправление.
 *
 * Если человек уже потратил эко, списывается то, что есть, а недостача
 * возвращается вызывающему словами — не глушится (§4.0).
 */
import { randomUUID } from 'node:crypto';
import { query } from '@/lib/database';
import { EMISSION_RULES } from '@/lib/eco/emission';
import { post, userAccount, contribAccount, SYSTEM_ACCOUNTS } from '@/lib/eco/ledger';

export function tourReviewRef(reviewId: string | number): string {
  return `tour_review:${String(reviewId)}`;
}

/** Сколько эко положено за отзыв в его текущем состоянии. */
export function reviewEcoTarget(r: { isHidden: boolean; hasPhotos: boolean }): number {
  if (r.isHidden) return 0;
  return EMISSION_RULES.review.amount + (r.hasPhotos ? EMISSION_RULES.photo.amount : 0);
}

export interface ReviewEcoOutcome {
  /** + начислено, − списано этим вызовом. */
  changedUser: number;
  changedContribution: number;
  /** Сколько списать не удалось: эко уже потрачены. 0 — всё сведено. */
  shortfall: number;
  errors: string[];
}

/**
 * Держатель счёта по отзыву сейчас: проводки с ref самого отзыва и его
 * корректировок. `emittedOnly` — было ли начисление вообще (иначе отзыв,
 * написанный до 24.09, «восстановлением» получил бы то, чего не получал).
 */
async function heldFor(account: string, refs: { exact: string; adjPrefix: string }): Promise<{ held: number; everEmitted: boolean }> {
  const { rows } = await query<{ held: string; emitted: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN credit_account = $1 THEN amount ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN debit_account = $1 THEN amount ELSE 0 END), 0) AS held,
       COUNT(*) FILTER (WHERE source_ref = $2 AND operation = 'emit') AS emitted
     FROM eco_ledger
     WHERE (credit_account = $1 OR debit_account = $1)
       AND (source_ref = $2 OR source_ref LIKE $3)`,
    [account, refs.exact, `${refs.adjPrefix}%`],
  );
  return { held: Number(rows[0]?.held ?? 0), everEmitted: Number(rows[0]?.emitted ?? 0) > 0 };
}

async function settleAccount(
  account: string,
  target: number,
  refs: { exact: string; adjPrefix: string },
  what: string,
  errors: string[],
): Promise<{ changed: number; shortfall: number }> {
  const { held, everEmitted } = await heldFor(account, refs);
  // Не начисляли вовсе — нечего ни списывать, ни «восстанавливать».
  if (!everEmitted) return { changed: 0, shortfall: 0 };
  const diff = target - held;
  if (diff === 0) return { changed: 0, shortfall: 0 };

  const credit = diff > 0;
  let amount = Math.abs(diff);
  const entry = () => ({
    debitAccount: credit ? SYSTEM_ACCOUNTS.correction : account,
    creditAccount: credit ? account : SYSTEM_ACCOUNTS.correction,
    amount,
    operation: 'adjust' as const,
    source: credit ? 'review_restore' : 'review_revoke',
    sourceRef: `${refs.adjPrefix}${randomUUID()}`,
    description: credit ? `Отзыв снова виден — ${what} возвращены` : `Отзыв скрыт модерацией — ${what} списаны`,
  });

  let res = await post(entry());
  if (!res.ok && res.reason === 'insufficient_funds' && !credit) {
    // Часть уже потрачена: списываем остаток счёта, недостачу называем.
    const { rows } = await query<{ balance: string }>(
      `SELECT balance::text FROM eco_balances WHERE account = $1`, [account],
    );
    const available = Math.max(0, Math.floor(Number(rows[0]?.balance ?? 0)));
    if (available === 0) return { changed: 0, shortfall: Math.abs(diff) };
    const short = amount - available;
    amount = available;
    res = await post(entry());
    if (res.ok) return { changed: -available, shortfall: short };
  }
  if (!res.ok) {
    errors.push(`${what}: ${res.message}`);
    return { changed: 0, shortfall: credit ? 0 : Math.abs(diff) };
  }
  return { changed: credit ? amount : -amount, shortfall: 0 };
}

export async function settleTourReviewEco(review: {
  id: string | number;
  userId: string | null;
  isHidden: boolean;
  hasPhotos: boolean;
}): Promise<ReviewEcoOutcome> {
  const out: ReviewEcoOutcome = { changedUser: 0, changedContribution: 0, shortfall: 0, errors: [] };
  if (!review.userId) return out;
  const ref = tourReviewRef(review.id);
  const target = reviewEcoTarget(review);

  const u = await settleAccount(userAccount(review.userId), target, { exact: ref, adjPrefix: `${ref}:adj:` }, 'эко', out.errors);
  const c = await settleAccount(contribAccount(review.userId), target, { exact: `${ref}:c`, adjPrefix: `${ref}:cadj:` }, 'вклад', out.errors);
  out.changedUser = u.changed;
  out.changedContribution = c.changed;
  out.shortfall = u.shortfall;
  if (out.errors.length > 0 || out.shortfall > 0) {
    console.error('[review-eco] сведение неполное', ref, { shortfall: out.shortfall, errors: out.errors });
  }
  return out;
}
