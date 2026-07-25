/**
 * Реестр «эко» — Этап 1 токенизации.
 *
 * Проверяется то, чем токен и является: сохранение количества. Прежний учёт
 * этого свойства не имел — баланс был SUM(earn) - SUM(redeem) при каждом
 * чтении, списание шло без транзакции (прочитать баланс → отдельным запросом
 * вставить), минус прятался через Math.max(0, ...), а expire/refund были
 * декоративными типами, не влиявшими ни на что.
 *
 * Ядро решений — чистые функции; SQL исполняет ту же логику, поэтому здесь же
 * зафиксирована форма запросов, отвечающих за атомарность и дедуп.
 */
import { describe, it, expect } from 'vitest';
import {
  SYSTEM_ACCOUNTS,
  userAccount,
  isSystemAccount,
  validateEntry,
  applyToBalances,
  invariantSum,
  circulatingSupply,
  type LedgerEntry,
} from '@/lib/eco/ledger';
import { readFileSync } from 'fs';
import { join } from 'path';

const ALICE = userAccount('a1');
const BOB = userAccount('b2');

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    debitAccount: SYSTEM_ACCOUNTS.emission,
    creditAccount: ALICE,
    amount: 100,
    operation: 'emit',
    source: 'review',
    sourceRef: 'r1',
    description: 'Отзыв',
    ...over,
  };
}

describe('счета', () => {
  it('счёт держателя строится из id, системные отличимы', () => {
    expect(userAccount('a1')).toBe('user:a1');
    expect(isSystemAccount(SYSTEM_ACCOUNTS.emission)).toBe(true);
    expect(isSystemAccount(ALICE)).toBe(false);
  });
});

describe('validateEntry — форма проводки', () => {
  it('дробная сумма отвергается: эко неделимы', () => {
    expect(validateEntry(entry({ amount: 1.5 })).ok).toBe(false);
  });

  it('ноль и минус отвергаются — знак несёт направление, а не сумма', () => {
    expect(validateEntry(entry({ amount: 0 })).ok).toBe(false);
    expect(validateEntry(entry({ amount: -5 })).ok).toBe(false);
  });

  it('перевод самому себе отвергается', () => {
    expect(validateEntry(entry({ debitAccount: ALICE, creditAccount: ALICE })).ok).toBe(false);
  });

  it('проводка без описания отвергается: журнал должен быть читаемым', () => {
    expect(validateEntry(entry({ description: '   ' })).ok).toBe(false);
  });

  it('корректная проводка проходит', () => {
    expect(validateEntry(entry()).ok).toBe(true);
  });
});

describe('applyToBalances — сохранение количества', () => {
  it('выпуск: у держателя плюс, у контр-счёта эмиссии минус', () => {
    const res = applyToBalances({}, entry({ amount: 100 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.balances[ALICE]).toBe(100);
    expect(res.balances[SYSTEM_ACCOUNTS.emission]).toBe(-100);
    expect(invariantSum(res.balances)).toBe(0);
  });

  it('держатель не уходит в минус — списание отклоняется, а не прячется', () => {
    const balances = { [ALICE]: 30 };
    const res = applyToBalances(balances, entry({
      debitAccount: ALICE, creditAccount: SYSTEM_ACCOUNTS.burn, amount: 50, operation: 'redeem',
    }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('insufficient_funds');
  });

  it('трата сжигает: в обращении становится меньше, инвариант держится', () => {
    const after = applyToBalances({ [ALICE]: 100, [SYSTEM_ACCOUNTS.emission]: -100 }, entry({
      debitAccount: ALICE, creditAccount: SYSTEM_ACCOUNTS.burn, amount: 40, operation: 'redeem',
    }));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(circulatingSupply(after.balances)).toBe(60);
    expect(invariantSum(after.balances)).toBe(0);
  });

  it('возврат восстанавливает ровно списанное', () => {
    const spent = applyToBalances({ [ALICE]: 100, [SYSTEM_ACCOUNTS.emission]: -100 }, entry({
      debitAccount: ALICE, creditAccount: SYSTEM_ACCOUNTS.burn, amount: 40, operation: 'redeem',
    }));
    expect(spent.ok).toBe(true);
    if (!spent.ok) return;
    const back = applyToBalances(spent.balances, entry({
      debitAccount: SYSTEM_ACCOUNTS.burn, creditAccount: ALICE, amount: 40, operation: 'refund',
    }));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.balances[ALICE]).toBe(100);
    expect(invariantSum(back.balances)).toBe(0);
  });

  it('перевод между держателями не меняет обращение', () => {
    const res = applyToBalances({ [ALICE]: 100, [BOB]: 0, [SYSTEM_ACCOUNTS.emission]: -100 }, entry({
      debitAccount: ALICE, creditAccount: BOB, amount: 60, operation: 'transfer',
    }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.balances[ALICE]).toBe(40);
    expect(res.balances[BOB]).toBe(60);
    expect(circulatingSupply(res.balances)).toBe(100);
    expect(invariantSum(res.balances)).toBe(0);
  });

  it('инвариант держится на длинной случайной последовательности', () => {
    let balances: Record<string, number> = {};
    const holders = [userAccount('u1'), userAccount('u2'), userAccount('u3')];
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    for (let i = 0; i < 2000; i++) {
      const who = holders[rnd(holders.length)];
      const amount = 1 + rnd(50);
      const kind = rnd(4);
      const e =
        kind === 0 ? entry({ creditAccount: who, amount, sourceRef: `e${i}` })
        : kind === 1 ? entry({ debitAccount: who, creditAccount: SYSTEM_ACCOUNTS.burn, amount, operation: 'redeem', sourceRef: `e${i}` })
        : kind === 2 ? entry({ debitAccount: SYSTEM_ACCOUNTS.burn, creditAccount: who, amount, operation: 'refund', sourceRef: `e${i}` })
        : entry({ debitAccount: who, creditAccount: holders[rnd(holders.length)], amount, operation: 'transfer', sourceRef: `e${i}` });

      const res = applyToBalances(balances, e);
      if (res.ok) balances = res.balances;
      // Отказ — тоже корректный исход: баланса не хватило либо перевод себе.
      expect(invariantSum(balances)).toBe(0);
    }

    // Ни один держатель не ушёл в минус за всю последовательность.
    for (const h of holders) expect(balances[h] ?? 0).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Свойства, которые обеспечивает не код, а схема. Проверяются по тексту
 * миграции: именно они закрывают гонку списания и двойное начисление,
 * которые в прежней схеме были открыты.
 */
describe('миграция 772 — гарантии на уровне БД', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '772_eco_ledger.sql'), 'utf-8');

  it('журнал только на дозапись: UPDATE/DELETE запрещены триггером', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON eco_ledger/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it('дедуп событий — UNIQUE в БД, а не SELECT перед INSERT', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*eco_ledger \(source, source_ref\)/);
  });

  it('овердрафт держателя запрещён схемой, системным счетам разрешён', () => {
    expect(sql).toMatch(/CHECK \(balance >= 0 OR account LIKE 'system:%'\)/);
  });

  it('перенос берёт баланс, который пользователь реально видел', () => {
    expect(sql).toContain("operation = 'opening'");
    expect(sql).toMatch(/GREATEST\(\s*0,/);
  });

  it('повторный прогон не создаёт вторых проводок', () => {
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });
});
