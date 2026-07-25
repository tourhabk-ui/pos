/**
 * Правила эмиссии эко — единственное место, где решается, за что и сколько.
 *
 * Этап 2 токенизации. До него правила жили в ACTIVITY_POINTS внутри системы
 * лояльности, а начисления вызывались из шести мест; ограничений не было
 * никаких — сколько раз позвали, столько и начислили (дедуп по сущности не
 * спасает там, где сущности можно плодить: отзывы, фото, наблюдения).
 *
 * Актив, эмиссию которого можно фармить, ничего не стоит. Поэтому здесь:
 *  - фиксированная ставка на событие, объявленная декларативно;
 *  - квоты (в сутки на пользователя по источнику и общий дневной потолок),
 *    считаемые ПО ЖУРНАЛУ, а не по отдельному счётчику, который разъедется;
 *  - признак «только после модерации» для того, что человек создаёт сам;
 *  - гео-условие для полевых событий: наблюдение с координатами вне Камчатки
 *    эмиссию не порождает.
 *
 * Ставки и квоты — предмет решения владельца, не модели. Здесь они собраны в
 * одну таблицу именно затем, чтобы их можно было менять осознанно и в одном
 * месте, а не искать по коду.
 */
import { pool } from '@/lib/db-pool';
import { emit, userAccount, type PostResult } from '@/lib/eco/ledger';

export interface EmissionRule {
  /** Ключ источника — он же попадает в журнал. */
  source: string;
  /** Сколько эко за одно событие. */
  amount: number;
  /** Человеческое описание — идёт в журнал и на витрину. */
  description: string;
  /** Максимум событий этого вида в сутки на пользователя. */
  perDayLimit: number;
  /** Разовый бонус: один на пользователя за всё время. */
  oncePerUser?: boolean;
  /**
   * Требует ручной модерации: начисление вызывается только из точки, где
   * человек уже одобрил результат. Флаг документирует это и проверяется
   * тестом, чтобы автоматический путь не появился по недосмотру.
   */
  requiresModeration?: boolean;
  /** Полевое событие: координаты обязаны быть в границах Камчатки. */
  requiresKamchatkaGeo?: boolean;
  /** Через сколько дней сгорает. null — не сгорает. */
  expiresInDays: number | null;
}

/** Общий дневной потолок на пользователя по всем источникам сразу. */
export const DAILY_USER_CAP = 600;

const YEAR = 365;

export const EMISSION_RULES: Record<string, EmissionRule> = {
  booking: {
    source: 'booking',
    amount: 0, // считается от суммы заказа, ставка живёт в LoyaltySystem.earnRate
    description: 'Начисление за заказ',
    perDayLimit: 20,
    expiresInDays: YEAR,
  },
  review: {
    source: 'review',
    amount: 50,
    description: 'Отзыв',
    perDayLimit: 3,
    requiresModeration: true,
    expiresInDays: YEAR,
  },
  photo: {
    source: 'photo',
    amount: 20,
    description: 'Фото к отзыву',
    perDayLimit: 3,
    requiresModeration: true,
    expiresInDays: YEAR,
  },
  first_booking: {
    source: 'first_booking',
    amount: 100,
    description: 'Первое бронирование',
    perDayLimit: 1,
    oncePerUser: true,
    expiresInDays: YEAR,
  },
  referral_referrer: {
    source: 'referral_referrer',
    amount: 500,
    description: 'Реферал: друг забронировал тур',
    perDayLimit: 5,
    expiresInDays: YEAR,
  },
  referral_referred: {
    source: 'referral_referred',
    amount: 200,
    description: 'Бонус за регистрацию по приглашению',
    perDayLimit: 1,
    oncePerUser: true,
    expiresInDays: YEAR,
  },
};

export type AwardOutcome =
  | { ok: true; awarded: number; result: PostResult }
  | { ok: false; awarded: 0; reason: 'unknown_source' | 'daily_limit' | 'user_cap' | 'out_of_region' | 'duplicate' | 'error'; message: string };

/** Кандидат на начисление — то, что знает вызывающая сторона. */
export interface AwardRequest {
  userId: string;
  source: string;
  /** Событие-источник: ключ идемпотентности. */
  sourceRef?: string | null;
  /** Переопределение суммы (заказ считается от чека). */
  amount?: number;
  /** Переопределение описания. */
  description?: string;
  /** Координаты полевого события. */
  lat?: number;
  lng?: number;
}

/**
 * Границы Камчатского края с запасом. Полевое событие за их пределами эко не
 * приносит: это дешёвый детерминированный фильтр против начислений «с дивана».
 */
export function withinKamchatka(lat: number, lng: number): boolean {
  return lat >= 50.5 && lat <= 65.5 && lng >= 155.0 && lng <= 174.0;
}

/** Решение о квотах по уже известным фактам — чистая функция, под тестом. */
export function checkQuota(
  rule: EmissionRule,
  facts: { todayFromSource: number; todayTotal: number; everFromSource: number; amount: number },
): { ok: true } | { ok: false; reason: 'daily_limit' | 'user_cap'; message: string } {
  if (rule.oncePerUser && facts.everFromSource > 0) {
    return { ok: false, reason: 'daily_limit', message: 'Этот бонус выдаётся один раз' };
  }
  if (facts.todayFromSource >= rule.perDayLimit) {
    return { ok: false, reason: 'daily_limit', message: 'Дневной лимит по этому виду активности исчерпан' };
  }
  if (facts.todayTotal + facts.amount > DAILY_USER_CAP) {
    return { ok: false, reason: 'user_cap', message: 'Дневной лимит начислений исчерпан' };
  }
  return { ok: true };
}

/** Факты по журналу: сколько уже начислено сегодня и было ли когда-либо. */
async function loadFacts(userId: string, source: string): Promise<{ todayFromSource: number; todayTotal: number; everFromSource: number }> {
  const account = userAccount(userId);
  const { rows } = await pool.query<{ today_from_source: string; today_total: string; ever_from_source: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE source = $2 AND created_at >= NOW() - INTERVAL '1 day')            AS today_from_source,
       COALESCE(SUM(amount) FILTER (WHERE created_at >= NOW() - INTERVAL '1 day'), 0)            AS today_total,
       COUNT(*) FILTER (WHERE source = $2)                                                       AS ever_from_source
     FROM eco_ledger
     WHERE credit_account = $1 AND operation = 'emit'`,
    [account, source],
  );
  return {
    todayFromSource: Number(rows[0]?.today_from_source ?? 0),
    todayTotal: Number(rows[0]?.today_total ?? 0),
    everFromSource: Number(rows[0]?.ever_from_source ?? 0),
  };
}

/**
 * Начисление по правилу. Единственная дверь эмиссии за активность: квоты,
 * гео и срок сгорания применяются здесь, а не в шести местах вызова.
 */
export async function award(req: AwardRequest): Promise<AwardOutcome> {
  const rule = EMISSION_RULES[req.source];
  if (!rule) {
    return { ok: false, awarded: 0, reason: 'unknown_source', message: 'Неизвестный источник начисления' };
  }

  const amount = req.amount ?? rule.amount;
  if (amount <= 0) {
    return { ok: false, awarded: 0, reason: 'error', message: 'Сумма начисления не задана' };
  }

  if (rule.requiresKamchatkaGeo) {
    if (req.lat === undefined || req.lng === undefined || !withinKamchatka(req.lat, req.lng)) {
      return { ok: false, awarded: 0, reason: 'out_of_region', message: 'Событие вне Камчатки — эко не начисляются' };
    }
  }

  const facts = await loadFacts(req.userId, req.source);
  const quota = checkQuota(rule, { ...facts, amount });
  if (!quota.ok) {
    return { ok: false, awarded: 0, reason: quota.reason, message: quota.message };
  }

  const expiresAt = rule.expiresInDays === null
    ? null
    : new Date(Date.now() + rule.expiresInDays * 86_400_000);

  const result = await emit({
    userId: req.userId,
    amount,
    source: rule.source,
    sourceRef: req.sourceRef ?? null,
    description: req.description ?? rule.description,
    expiresAt,
  });

  if (!result.ok) {
    return { ok: false, awarded: 0, reason: 'error', message: result.message };
  }
  if (!result.applied) {
    return { ok: false, awarded: 0, reason: 'duplicate', message: 'Эко за это событие уже начислены' };
  }

  return { ok: true, awarded: amount, result };
}
