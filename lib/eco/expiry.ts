/**
 * Сгорание эко по сроку.
 *
 * До реестра «сгорание» было побочным эффектом того, как написан SELECT:
 * запрос баланса фильтровал `expires_at > NOW()`, и эко просто переставали
 * учитываться. Пользователь ничего не видел, в журнале ничего не оставалось,
 * а сумма по системе не сходилась ни с чем.
 *
 * Теперь сгорание — обычная проводка: со счёта держателя на счёт сжигания.
 * Она видна в истории, участвует в инварианте и обратима только новой
 * проводкой, а не правкой строки.
 *
 * Порядок трат — FIFO, но лоты для этого не нужны. Достаточно двух чисел по
 * журналу: сколько начислено с уже прошедшим сроком и сколько всего ушло со
 * счёта. Если человек потратил больше, чем начислено «срочного», сгорать
 * нечему — он потратил именно его.
 */
import { pool } from '@/lib/db-pool';
import { SYSTEM_ACCOUNTS, post, userAccount } from '@/lib/eco/ledger';

export interface ExpiryCandidate {
  account: string;
  /** Сумма начислений, срок которых уже прошёл. */
  expiredEmitted: number;
  /** Всё, что когда-либо уходило со счёта: траты, сгорания, переводы. */
  totalOutgoing: number;
  /** Текущий баланс. */
  balance: number;
}

/**
 * Сколько сгорает у одного держателя. Чистая функция — под тестом.
 *
 * to_expire = max(0, min(balance, expiredEmitted - totalOutgoing))
 *
 * Уже сгоревшее входит в totalOutgoing, поэтому повторно не сгорит.
 */
export function amountToExpire(c: Pick<ExpiryCandidate, 'expiredEmitted' | 'totalOutgoing' | 'balance'>): number {
  const unspentExpired = c.expiredEmitted - c.totalOutgoing;
  if (unspentExpired <= 0) return 0;
  return Math.max(0, Math.min(c.balance, unspentExpired));
}

/** Держатели, у которых есть что сжигать. */
export async function findExpiryCandidates(limit = 500): Promise<ExpiryCandidate[]> {
  const { rows } = await pool.query<{
    account: string; expired_emitted: string; total_outgoing: string; balance: string;
  }>(
    `SELECT
       b.account,
       COALESCE(e.expired_emitted, 0) AS expired_emitted,
       COALESCE(o.total_outgoing, 0)  AS total_outgoing,
       b.balance
     FROM eco_balances b
     LEFT JOIN (
       SELECT credit_account AS account, SUM(amount) AS expired_emitted
       FROM eco_ledger
       WHERE expires_at IS NOT NULL AND expires_at <= NOW()
       GROUP BY credit_account
     ) e ON e.account = b.account
     LEFT JOIN (
       SELECT debit_account AS account, SUM(amount) AS total_outgoing
       FROM eco_ledger
       GROUP BY debit_account
     ) o ON o.account = b.account
     WHERE b.account NOT LIKE 'system:%'
       AND b.balance > 0
       AND COALESCE(e.expired_emitted, 0) > COALESCE(o.total_outgoing, 0)
     ORDER BY b.account
     LIMIT $1`,
    [limit],
  );

  return rows.map((r) => ({
    account: r.account,
    expiredEmitted: Number(r.expired_emitted),
    totalOutgoing: Number(r.total_outgoing),
    balance: Number(r.balance),
  }));
}

export interface ExpiryRunResult {
  checked: number;
  expired: number;
  totalBurned: number;
  failures: number;
}

/**
 * Прогон сгорания. Идемпотентен в пределах суток: ключ проводки —
 * счёт плюс дата, поэтому повторный запуск в тот же день ничего не спишет
 * второй раз даже при наложении расписаний.
 */
export async function runEcoExpiry(now: Date = new Date()): Promise<ExpiryRunResult> {
  const candidates = await findExpiryCandidates();
  const day = now.toISOString().slice(0, 10);

  let expired = 0;
  let totalBurned = 0;
  let failures = 0;

  for (const c of candidates) {
    const amount = amountToExpire(c);
    if (amount <= 0) continue;

    const userId = c.account.replace(/^user:/, '');
    const result = await post({
      debitAccount: userAccount(userId),
      creditAccount: SYSTEM_ACCOUNTS.burn,
      amount,
      operation: 'expire',
      source: 'expire',
      sourceRef: `${c.account}:${day}`,
      description: `Сгорание ${amount} эко по истечении срока`,
    });

    if (result.ok && result.applied) {
      expired += 1;
      totalBurned += amount;
    } else if (!result.ok) {
      failures += 1;
    }
  }

  return { checked: candidates.length, expired, totalBurned, failures };
}
