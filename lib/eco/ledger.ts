/**
 * Реестр «эко» — двойная запись.
 *
 * Единица платформы называется «эко». Правило одно: баланс меняется ТОЛЬКО
 * проводкой в журнале, и у каждой проводки есть счёт-источник и счёт-получатель.
 * Отсюда инвариант сохранения — SUM(balance) по всем счетам всегда 0, — который
 * сторож проверяет одной строкой. Не сошлось значит где-то эко родились или
 * исчезли, и это надо чинить, а не прятать.
 *
 * Системные счета — контр-счета: их отрицательный баланс и есть объём того,
 * что выпущено в обращение. Пользовательский счёт в минус уйти не может: это
 * запрещено CHECK в БД, а списание делается одним UPDATE ... WHERE balance >=
 * amount внутри транзакции. Прежняя схема (прочитать баланс, потом отдельно
 * вставить списание) допускала гонку и уводила баланс в минус, который затем
 * прятался через Math.max(0, ...).
 *
 * Ядро решений — чистые функции ниже; они же под тестами. SQL лишь исполняет
 * ту же логику средствами БД.
 */
import { pool } from '@/lib/db-pool';
import type { PoolClient } from 'pg';

export const SYSTEM_ACCOUNTS = {
  /** Выпуск за полезные действия. */
  emission: 'system:emission',
  /** Сжигание при трате. */
  burn: 'system:burn',
  /** Открывающие проводки переноса (миграция 772). */
  opening: 'system:opening',
  /** Ручные корректировки владельца — всегда видны в журнале. */
  correction: 'system:correction',
} as const;

export type EcoOperation = 'opening' | 'emit' | 'redeem' | 'transfer' | 'expire' | 'refund' | 'adjust';

export interface LedgerEntry {
  debitAccount: string;
  creditAccount: string;
  amount: number;
  operation: EcoOperation;
  source: string;
  /** Идентификатор события-источника: дедуп на уровне БД. */
  sourceRef?: string | null;
  description: string;
  expiresAt?: Date | null;
}

export type PostResult =
  | { ok: true; applied: true; id: string }
  /** Проводка по этому событию уже была — повтор безопасен. */
  | { ok: true; applied: false; reason: 'duplicate' }
  | { ok: false; reason: 'insufficient_funds' | 'invalid' | 'error'; message: string };

/** `user:<uuid>` — счёт держателя. */
export function userAccount(userId: string): string {
  return `user:${userId}`;
}

export function isSystemAccount(account: string): boolean {
  return account.startsWith('system:');
}

// ── Чистое ядро (под тестами) ────────────────────────────────────────────────

/** Проверка формы проводки до всякой БД. */
export function validateEntry(entry: LedgerEntry): { ok: true } | { ok: false; message: string } {
  if (!Number.isInteger(entry.amount)) return { ok: false, message: 'Сумма эко должна быть целым числом' };
  if (entry.amount <= 0) return { ok: false, message: 'Сумма эко должна быть положительной' };
  if (entry.debitAccount === entry.creditAccount) return { ok: false, message: 'Счёт списания и счёт зачисления совпадают' };
  if (!entry.debitAccount || !entry.creditAccount) return { ok: false, message: 'Не указан счёт операции' };
  if (!entry.description.trim()) return { ok: false, message: 'Проводка без описания недопустима' };
  return { ok: true };
}

/**
 * Применение проводки к балансам — та же логика, что исполняет SQL.
 * Держатель в минус не уходит; системный контр-счёт — уходит по определению.
 */
export function applyToBalances(
  balances: Readonly<Record<string, number>>,
  entry: LedgerEntry,
): { ok: true; balances: Record<string, number> } | { ok: false; reason: 'insufficient_funds' | 'invalid'; message: string } {
  const valid = validateEntry(entry);
  if (!valid.ok) return { ok: false, reason: 'invalid', message: valid.message };

  const next = { ...balances };
  const debitBefore = next[entry.debitAccount] ?? 0;

  if (!isSystemAccount(entry.debitAccount) && debitBefore < entry.amount) {
    return { ok: false, reason: 'insufficient_funds', message: 'Недостаточно эко на счёте' };
  }

  next[entry.debitAccount] = debitBefore - entry.amount;
  next[entry.creditAccount] = (next[entry.creditAccount] ?? 0) + entry.amount;
  return { ok: true, balances: next };
}

/** Инвариант сохранения: сумма по всем счетам обязана быть нулём. */
export function invariantSum(balances: Readonly<Record<string, number>>): number {
  return Object.values(balances).reduce((sum, v) => sum + v, 0);
}

/** Эко в обращении — это ровно минус системных контр-счетов. */
export function circulatingSupply(balances: Readonly<Record<string, number>>): number {
  return Object.entries(balances)
    .filter(([account]) => !isSystemAccount(account))
    .reduce((sum, [, v]) => sum + v, 0);
}

// ── Исполнение в БД ──────────────────────────────────────────────────────────

async function ensureAccount(client: PoolClient, account: string): Promise<void> {
  await client.query(
    `INSERT INTO eco_balances (account, balance) VALUES ($1, 0) ON CONFLICT (account) DO NOTHING`,
    [account],
  );
}

/**
 * Единственный способ изменить баланс. Всё в одной транзакции:
 * запись в журнал → списание с проверкой → зачисление.
 */
export async function post(entry: LedgerEntry): Promise<PostResult> {
  const valid = validateEntry(entry);
  if (!valid.ok) return { ok: false, reason: 'invalid', message: valid.message };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Дедуп по (source, source_ref) обеспечивает БД, а не проверка в коде.
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO eco_ledger
         (debit_account, credit_account, amount, operation, source, source_ref, description, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        entry.debitAccount, entry.creditAccount, entry.amount, entry.operation,
        entry.source, entry.sourceRef ?? null, entry.description, entry.expiresAt ?? null,
      ],
    );

    if (inserted.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: true, applied: false, reason: 'duplicate' };
    }

    await ensureAccount(client, entry.debitAccount);
    await ensureAccount(client, entry.creditAccount);

    // Счета блокируются в порядке имени: встречные переводы иначе дают дедлок.
    const ordered = [entry.debitAccount, entry.creditAccount].sort();
    await client.query(
      `SELECT account FROM eco_balances WHERE account = ANY($1::text[]) ORDER BY account FOR UPDATE`,
      [ordered],
    );

    // Держателю — только при достаточном балансе; ноль обновлённых строк = отказ.
    const debited = isSystemAccount(entry.debitAccount)
      ? await client.query(
          `UPDATE eco_balances SET balance = balance - $2, updated_at = NOW() WHERE account = $1`,
          [entry.debitAccount, entry.amount],
        )
      : await client.query(
          `UPDATE eco_balances SET balance = balance - $2, updated_at = NOW()
           WHERE account = $1 AND balance >= $2`,
          [entry.debitAccount, entry.amount],
        );

    if (debited.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'insufficient_funds', message: 'Недостаточно эко на счёте' };
    }

    await client.query(
      `UPDATE eco_balances SET balance = balance + $2, updated_at = NOW() WHERE account = $1`,
      [entry.creditAccount, entry.amount],
    );

    await client.query('COMMIT');
    return { ok: true, applied: true, id: inserted.rows[0].id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return {
      ok: false,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Ошибка проводки эко',
    };
  } finally {
    client.release();
  }
}

/** Выпуск эко держателю за полезное действие. */
export function emit(args: {
  userId: string; amount: number; source: string; sourceRef?: string | null;
  description: string; expiresAt?: Date | null;
}): Promise<PostResult> {
  return post({
    debitAccount: SYSTEM_ACCOUNTS.emission,
    creditAccount: userAccount(args.userId),
    amount: args.amount,
    operation: 'emit',
    source: args.source,
    sourceRef: args.sourceRef,
    description: args.description,
    expiresAt: args.expiresAt,
  });
}

/** Трата: эко сжигаются, а не «переходят платформе». */
export function redeem(args: {
  userId: string; amount: number; source: string; sourceRef?: string | null; description: string;
}): Promise<PostResult> {
  return post({
    debitAccount: userAccount(args.userId),
    creditAccount: SYSTEM_ACCOUNTS.burn,
    amount: args.amount,
    operation: 'redeem',
    source: args.source,
    sourceRef: args.sourceRef,
    description: args.description,
  });
}

/** Возврат ранее списанного (отмена брони и подобное). */
export function refund(args: {
  userId: string; amount: number; source: string; sourceRef?: string | null; description: string;
}): Promise<PostResult> {
  return post({
    debitAccount: SYSTEM_ACCOUNTS.burn,
    creditAccount: userAccount(args.userId),
    amount: args.amount,
    operation: 'refund',
    source: args.source,
    sourceRef: args.sourceRef,
    description: args.description,
  });
}

/**
 * Сгорание по сроку. Операция существует и работает; крон, который её
 * вызывает, — Этап 2. До него эко не сгорают, и это честнее, чем прежнее
 * молчаливое исчезновение по фильтру expires_at в запросе баланса.
 */
export function expire(args: {
  userId: string; amount: number; sourceRef?: string | null; description: string;
}): Promise<PostResult> {
  return post({
    debitAccount: userAccount(args.userId),
    creditAccount: SYSTEM_ACCOUNTS.burn,
    amount: args.amount,
    operation: 'expire',
    source: 'expire',
    sourceRef: args.sourceRef,
    description: args.description,
  });
}

export async function getBalance(userId: string): Promise<number> {
  const { rows } = await pool.query<{ balance: string }>(
    `SELECT balance FROM eco_balances WHERE account = $1`,
    [userAccount(userId)],
  );
  return rows[0] ? Number(rows[0].balance) : 0;
}

export interface LedgerRow {
  id: string;
  operation: EcoOperation;
  amount: number;
  source: string;
  sourceRef: string | null;
  description: string;
  incoming: boolean;
  createdAt: Date;
  expiresAt: Date | null;
}

export async function getHistory(userId: string, limit = 20): Promise<LedgerRow[]> {
  const account = userAccount(userId);
  const { rows } = await pool.query<{
    id: string; operation: EcoOperation; amount: string; source: string;
    source_ref: string | null; description: string; credit_account: string;
    created_at: Date; expires_at: Date | null;
  }>(
    `SELECT id, operation, amount, source, source_ref, description, credit_account, created_at, expires_at
     FROM eco_ledger
     WHERE debit_account = $1 OR credit_account = $1
     ORDER BY id DESC
     LIMIT $2`,
    [account, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    operation: r.operation,
    amount: Number(r.amount),
    source: r.source,
    sourceRef: r.source_ref,
    description: r.description,
    incoming: r.credit_account === account,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/** Сколько выпущено и сколько потрачено — по журналу, не по памяти. */
export async function getUserTotals(userId: string): Promise<{ earned: number; redeemed: number }> {
  const account = userAccount(userId);
  const { rows } = await pool.query<{ earned: string; redeemed: string }>(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE credit_account = $1), 0) AS earned,
       COALESCE(SUM(amount) FILTER (WHERE debit_account  = $1), 0) AS redeemed
     FROM eco_ledger
     WHERE debit_account = $1 OR credit_account = $1`,
    [account],
  );
  return {
    earned: Number(rows[0]?.earned ?? 0),
    redeemed: Number(rows[0]?.redeemed ?? 0),
  };
}

/**
 * Сверка инварианта. Ноль значит эко не появлялись из воздуха и не исчезали.
 * Гоняется сторожем ежечасно; расхождение — crit.
 */
export async function checkInvariant(): Promise<{ ok: boolean; sum: number; circulating: number; accounts: number }> {
  const { rows } = await pool.query<{ sum: string; circulating: string; accounts: string }>(
    `SELECT
       COALESCE(SUM(balance), 0)                                          AS sum,
       COALESCE(SUM(balance) FILTER (WHERE account NOT LIKE 'system:%'), 0) AS circulating,
       COUNT(*)                                                           AS accounts
     FROM eco_balances`,
  );
  const sum = Number(rows[0]?.sum ?? 0);
  return {
    ok: sum === 0,
    sum,
    circulating: Number(rows[0]?.circulating ?? 0),
    accounts: Number(rows[0]?.accounts ?? 0),
  };
}
