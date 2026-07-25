/**
 * Система лояльности поверх реестра «эко» (миграция 772).
 *
 * Внешний контракт класса не менялся — 6 мест вызова снаружи трогать не надо.
 * Изменилось то, ЧЕМ он считает: раньше баланс был SUM(earn) - SUM(redeem) на
 * лету, списание — прочитать-потом-вставить без транзакции, а отрицательный
 * баланс прятался через Math.max(0, ...). Теперь любое движение проходит
 * проводкой lib/eco/ledger: минус физически невозможен, дедуп начислений
 * держит UNIQUE в БД, а сходимость проверяется инвариантом.
 *
 * loyalty_transactions остаётся архивом: из него сделан перенос, писать туда
 * больше нельзя — иначе снова появятся два расходящихся источника правды.
 */
import { query } from '@/lib/database';
import crypto from 'crypto';
import * as ledger from '@/lib/eco/ledger';
import { award, EMISSION_RULES } from '@/lib/eco/emission';

interface UserLevel {
  name: string;
  minSpent: number;
  discount: number;
  earnMultiplier: number;
  benefits: string[];
  color: string;
}

interface BonusTransaction {
  id: string;
  userId: string;
  type: 'earn' | 'redeem' | 'expire' | 'refund';
  source: string;
  amount: number;
  description: string;
  bookingId?: string;
  createdAt: Date;
  expiresAt?: Date;
}

interface LoyaltyStats {
  totalPoints: number;
  availablePoints: number;
  currentLevel: UserLevel;
  nextLevel: UserLevel | null;
  pointsToNextLevel: number;
  totalEarned: number;
  totalRedeemed: number;
  totalSpent: number;
  transactions: BonusTransaction[];
  referral: {
    code: string | null;
    invited: number;
    completed: number;
    totalEarned: number;
  };
}

/** Операция реестра → тип, который витрина знает исторически. */
const LEDGER_OP_TO_TYPE: Record<ledger.EcoOperation, BonusTransaction['type']> = {
  opening:  'earn',
  emit:     'earn',
  transfer: 'earn',
  redeem:   'redeem',
  expire:   'expire',
  refund:   'refund',
  adjust:   'earn',
};

/**
 * Ставки активностей переехали в lib/eco/emission.ts (Этап 2): там же квоты,
 * анти-фарм и срок сгорания. Дубля таблицы здесь больше нет — иначе два
 * источника правды разъедутся, как уже было со схемой лояльности.
 */

export class LoyaltySystem {
  private levels: UserLevel[] = [
    { name: 'Новичок', minSpent: 0, discount: 0, earnMultiplier: 1.0, benefits: ['Базовые уведомления'], color: '#6B7280' },
    { name: 'Бронза', minSpent: 5000, discount: 0.02, earnMultiplier: 1.2, benefits: ['2% скидка', 'Приоритетная поддержка'], color: '#CD7F32' },
    { name: 'Серебро', minSpent: 15000, discount: 0.05, earnMultiplier: 1.5, benefits: ['5% скидка', 'Ранний доступ к турам'], color: '#C0C0C0' },
    { name: 'Золото', minSpent: 50000, discount: 0.10, earnMultiplier: 2.0, benefits: ['10% скидка', 'VIP поддержка', 'Персональный менеджер'], color: '#FFD700' },
    { name: 'Платина', minSpent: 100000, discount: 0.15, earnMultiplier: 3.0, benefits: ['15% скидка', 'Максимальный приоритет', 'Эксклюзивные туры'], color: '#E5E4E2' },
  ];

  private earnRate = 0.01;
  private expirationDays = 365;

  async getUserLoyaltyStats(userId: string): Promise<LoyaltyStats> {
    // Total spent from users table (incrementally updated)
    const spentResult = await query<{ total_spent: string }>(
      'SELECT COALESCE(total_spent, 0) as total_spent FROM users WHERE id = $1',
      [userId]
    );
    const totalSpent = parseFloat(spentResult.rows[0]?.total_spent ?? '0');

    const currentLevel = this.getUserLevel(totalSpent);
    const nextLevel = this.getNextLevel(totalSpent);

    // Баланс — зафиксированное состояние счёта, а не сумма, пересчитанная
    // при каждом чтении. Итоги — из журнала.
    const [availablePoints, totals, history] = await Promise.all([
      ledger.getBalance(userId),
      ledger.getUserTotals(userId),
      ledger.getHistory(userId, 20),
    ]);

    const totalEarned = totals.earned;
    const totalRedeemed = totals.redeemed;

    const transactions: BonusTransaction[] = history.map(r => ({
      id: r.id,
      userId,
      type: LEDGER_OP_TO_TYPE[r.operation],
      source: r.source,
      amount: r.amount,
      description: r.description,
      bookingId: r.sourceRef ?? undefined,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt ?? undefined,
    }));

    // Referral stats
    const refResult = await query<{ referral_code: string | null }>(
      'SELECT referral_code FROM users WHERE id = $1',
      [userId]
    );
    const refCode = refResult.rows[0]?.referral_code ?? null;

    let refStats = { invited: 0, completed: 0, totalEarned: 0 };
    if (refCode) {
      const refCountResult = await query<{ invited: string; completed: string; total_earned: string }>(
        `SELECT
          COUNT(*) as invited,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
          COALESCE(SUM(CASE WHEN status = 'completed' THEN reward_amount ELSE 0 END), 0) as total_earned
        FROM referrals WHERE referrer_id = $1`,
        [userId]
      );
      if (refCountResult.rows[0]) {
        refStats = {
          invited: parseInt(refCountResult.rows[0].invited),
          completed: parseInt(refCountResult.rows[0].completed),
          totalEarned: parseInt(refCountResult.rows[0].total_earned),
        };
      }
    }

    return {
      totalPoints: totalEarned,
      // Без Math.max(0, ...): минус теперь невозможен на уровне БД, а не
      // замазан на витрине.
      availablePoints,
      currentLevel,
      nextLevel,
      pointsToNextLevel: nextLevel ? nextLevel.minSpent - totalSpent : 0,
      totalEarned,
      totalRedeemed,
      totalSpent,
      transactions,
      referral: { code: refCode, ...refStats },
    };
  }

  async earnPoints(
    userId: string,
    bookingId: string,
    amount: number,
    source: string = 'booking'
  ): Promise<{ success: boolean; pointsEarned: number; message: string }> {
    try {
      // Множитель уровня: уровни обещают ×1.2–×3.0 (benefits в levels),
      // раньше он нигде не применялся — Золото получало столько же, сколько Новичок.
      const spentResult = await query<{ total_spent: string }>(
        'SELECT COALESCE(total_spent, 0) as total_spent FROM users WHERE id = $1',
        [userId]
      );
      const level = this.getUserLevel(parseFloat(spentResult.rows[0]?.total_spent ?? '0'));

      const pointsEarned = Math.floor(amount * this.earnRate * level.earnMultiplier);
      if (pointsEarned <= 0) return { success: true, pointsEarned: 0, message: 'Сумма слишком мала для начисления' };

      const multiplierNote = level.earnMultiplier > 1
        ? ` (уровень «${level.name}», ×${level.earnMultiplier})`
        : '';

      // Через ту же дверь, что и активности: сумма считается от чека, но
      // квоты, срок сгорания и дедуп — общие для всей эмиссии.
      const outcome = await award({
        userId,
        source,
        sourceRef: bookingId,
        amount: pointsEarned,
        description: `Начислено ${pointsEarned} эко за заказ на сумму ${amount} руб.${multiplierNote}`,
      });

      if (!outcome.ok) {
        // Повтор за ту же бронь — не ошибка вызывающего, а ожидаемый исход.
        const success = outcome.reason === 'duplicate';
        return { success, pointsEarned: 0, message: outcome.message };
      }

      return { success: true, pointsEarned: outcome.awarded, message: `Начислено ${outcome.awarded} эко` };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, pointsEarned: 0, message: `Ошибка начисления: ${msg}` };
    }
  }

  async earnActivityPoints(
    userId: string,
    source: string,
    entityId?: string
  ): Promise<{ success: boolean; pointsEarned: number; message: string }> {
    const rule = EMISSION_RULES[source];
    if (!rule) return { success: false, pointsEarned: 0, message: 'Неизвестный тип активности' };

    // Ключ идемпотентности. Для разовых бонусов вроде первого бронирования
    // сущность-источник роли не играет — «одно на пользователя» и есть ключ.
    const sourceRef = rule.oncePerUser ? userId : (entityId ?? null);

    // Единственная дверь эмиссии: квоты, срок сгорания и гео — внутри award.
    const outcome = await award({ userId, source, sourceRef });

    if (!outcome.ok) {
      return { success: false, pointsEarned: 0, message: outcome.message };
    }

    return {
      success: true,
      pointsEarned: outcome.awarded,
      message: `+${outcome.awarded} эко: ${rule.description}`,
    };
  }

  /**
   * Фото-бонус (+20) — только после модерации: отзыв одобрен (is_verified)
   * И к нему реально приложены фото (review_assets). Вызывается из точек
   * одобрения отзыва; дедуп по (user, 'photo', reviewId) внутри
   * earnActivityPoints — повторное одобрение не начислит дважды.
   */
  async awardPhotoBonusIfEligible(reviewId: string): Promise<void> {
    const result = await query<{ user_id: string }>(
      `SELECT r.user_id
       FROM reviews r
       WHERE r.id::text = $1
         AND r.is_verified = true
         AND r.user_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM review_assets ra WHERE ra.review_id = r.id)`,
      [reviewId]
    );
    const userId = result.rows[0]?.user_id;
    if (!userId) return;

    await this.earnActivityPoints(userId, 'photo', reviewId);
  }

  /**
   * Списание эко. `sink` — ключ из реестра стоков (lib/eco/sinks): списание
   * мимо реестра невозможно, потому что там живёт Закон 6 «безопасность не
   * продаётся». По умолчанию — скидка на тур, исторический единственный сток.
   */
  async redeemPoints(
    userId: string,
    pointsToRedeem: number,
    description: string,
    sink: string = 'tour_discount'
  ): Promise<{ success: boolean; pointsRedeemed: number; discountAmount: number; message: string }> {
    // Проверка достаточности и само списание — одна атомарная операция.
    // Раньше между чтением баланса и вставкой был зазор, в который проходило
    // параллельное списание, и баланс уходил в минус.
    const result = await ledger.redeem({
      userId,
      amount: pointsToRedeem,
      source: sink,
      sourceRef: `redeem_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      description,
    });

    if (!result.ok) {
      const message = result.reason === 'insufficient_funds'
        ? 'Недостаточно эко'
        : `Ошибка списания эко: ${result.message}`;
      return { success: false, pointsRedeemed: 0, discountAmount: 0, message };
    }

    return {
      success: true,
      pointsRedeemed: pointsToRedeem,
      discountAmount: pointsToRedeem,
      message: `Списано ${pointsToRedeem} эко`,
    };
  }

  async generateReferralCode(userId: string): Promise<string> {
    // Check if already has one
    const existing = await query<{ referral_code: string | null }>(
      'SELECT referral_code FROM users WHERE id = $1',
      [userId]
    );
    if (existing.rows[0]?.referral_code) return existing.rows[0].referral_code;

    // Generate unique code KH-XXXXXX
    let code: string;
    let attempts = 0;
    do {
      const rand = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6);
      code = `KH-${rand}`;
      const dup = await query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
      if (dup.rows.length === 0) break;
      attempts++;
    } while (attempts < 10);

    await query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, userId]);
    return code;
  }

  async completeReferral(referredUserId: string): Promise<void> {
    // Find referrer
    const userResult = await query<{ referred_by: string | null }>(
      'SELECT referred_by FROM users WHERE id = $1',
      [referredUserId]
    );
    const referrerId = userResult.rows[0]?.referred_by;
    if (!referrerId) return;

    // Check if already completed
    const existing = await query<{ status: string }>(
      `SELECT status FROM referrals WHERE referrer_id = $1 AND referred_id = $2`,
      [referrerId, referredUserId]
    );
    if (existing.rows[0]?.status === 'completed') return;

    // Complete referral
    await query(
      `UPDATE referrals SET status = 'completed', reward_amount = 500, completed_at = NOW()
       WHERE referrer_id = $1 AND referred_id = $2`,
      [referrerId, referredUserId]
    );

    // Award points to referrer
    await this.earnActivityPoints(referrerId, 'referral_referrer', referredUserId);
    // Award points to referred
    await this.earnActivityPoints(referredUserId, 'referral_referred', referrerId);
  }

  getUserLevel(totalSpent: number): UserLevel {
    for (let i = this.levels.length - 1; i >= 0; i--) {
      if (totalSpent >= this.levels[i].minSpent) return this.levels[i];
    }
    return this.levels[0];
  }

  getNextLevel(totalSpent: number): UserLevel | null {
    for (const level of this.levels) {
      if (totalSpent < level.minSpent) return level;
    }
    return null;
  }

  getLevelDiscount(totalSpent: number): number {
    return this.getUserLevel(totalSpent).discount;
  }

  getAllLevels(): UserLevel[] {
    return this.levels;
  }

  async applyPromoCode(
    code: string,
    _userId: string,
    orderAmount: number
  ): Promise<{ success: boolean; discountAmount: number; message: string }> {
    try {
      const promoResult = await query<{
        id: string; discount_type: string; discount_value: string;
        max_uses: number; current_uses: number;
      }>(
        `SELECT id, discount_type, discount_value, max_uses, current_uses FROM promo_codes WHERE code = $1 AND is_active = true AND (expires_at IS NULL OR expires_at > NOW())`,
        [code]
      );

      if (promoResult.rows.length === 0) {
        return { success: false, discountAmount: 0, message: 'Промокод не найден или истёк' };
      }

      const promo = promoResult.rows[0];
      if (promo.current_uses >= promo.max_uses) {
        return { success: false, discountAmount: 0, message: 'Промокод исчерпан' };
      }

      const discountAmount = promo.discount_type === 'percentage'
        ? orderAmount * (parseFloat(promo.discount_value) / 100)
        : Math.min(parseFloat(promo.discount_value), orderAmount);

      await query('UPDATE promo_codes SET current_uses = current_uses + 1 WHERE id = $1', [promo.id]);

      return { success: true, discountAmount, message: `Скидка: ${Math.round(discountAmount)} руб.` };
    } catch {
      return { success: false, discountAmount: 0, message: 'Ошибка применения промокода' };
    }
  }
}

export const loyaltySystem = new LoyaltySystem();
export type { UserLevel, BonusTransaction, LoyaltyStats };
