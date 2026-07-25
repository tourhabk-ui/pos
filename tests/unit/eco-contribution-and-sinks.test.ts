/**
 * Философия эко в машине (docs/ECO.md).
 *
 * Два закона переведены из «держится на слове» в «держит машина»:
 *
 *  Закон 8 — вклад не отчуждается. Свидетельство теряет смысл, как только
 *  становится передаваемым: если вклад можно продать, человек с большим
 *  вкладом и человек с деньгами выглядят одинаково.
 *
 *  Закон 6 — безопасность не продаётся. Тот случай, когда токеномика способна
 *  убить человека: за накопленные эко нельзя получить снятие требования гида,
 *  обход регистрации в МЧС, доступ к закрытому маршруту или подъём
 *  непроверенного оператора в выдаче.
 *
 * Оба проверяются здесь, а не в документе.
 */
import { describe, it, expect } from 'vitest';
import {
  SYSTEM_ACCOUNTS,
  userAccount,
  contribAccount,
  isContributionAccount,
  violatesContributionRule,
  validateEntry,
  applyToBalances,
  invariantSum,
  type LedgerEntry,
} from '@/lib/eco/ledger';
import {
  ECO_SINKS,
  validateSink,
  resolveSink,
  maxEcoForCheck,
  type EcoSink,
} from '@/lib/eco/sinks';
import { readFileSync } from 'fs';
import { join } from 'path';

const ALICE = 'a1';
const BOB = 'b2';

function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    debitAccount: SYSTEM_ACCOUNTS.contribution,
    creditAccount: contribAccount(ALICE),
    amount: 100,
    operation: 'emit',
    source: 'review',
    sourceRef: 'r1:c',
    description: 'Отзыв',
    ...over,
  };
}

describe('Закон 8 — вклад не отчуждается', () => {
  it('счета двух слоёв различимы', () => {
    expect(isContributionAccount(contribAccount(ALICE))).toBe(true);
    expect(isContributionAccount(userAccount(ALICE))).toBe(false);
  });

  it('начисление вклада за поступок проходит', () => {
    expect(violatesContributionRule(entry())).toBeNull();
    expect(validateEntry(entry()).ok).toBe(true);
  });

  it('потратить вклад нельзя', () => {
    const spend = entry({
      debitAccount: contribAccount(ALICE),
      creditAccount: SYSTEM_ACCOUNTS.burn,
      operation: 'redeem',
    });
    expect(violatesContributionRule(spend)).toContain('не отчуждается');
    expect(validateEntry(spend).ok).toBe(false);
  });

  it('передать вклад другому человеку нельзя', () => {
    const gift = entry({
      debitAccount: contribAccount(ALICE),
      creditAccount: contribAccount(BOB),
      operation: 'transfer',
    });
    expect(validateEntry(gift).ok).toBe(false);
  });

  it('вклад не сгорает по сроку', () => {
    const burn = entry({
      debitAccount: contribAccount(ALICE),
      creditAccount: SYSTEM_ACCOUNTS.burn,
      operation: 'expire',
    });
    expect(validateEntry(burn).ok).toBe(false);
  });

  it('зачислить вклад переводом от другого держателя нельзя', () => {
    const laundered = entry({
      debitAccount: userAccount(BOB),
      creditAccount: contribAccount(ALICE),
      operation: 'transfer',
    });
    expect(validateEntry(laundered).ok).toBe(false);
  });

  it('видимое исправление владельца — единственное исключение', () => {
    const fix = entry({
      debitAccount: contribAccount(ALICE),
      creditAccount: SYSTEM_ACCOUNTS.correction,
      operation: 'adjust',
      description: 'Отмена ошибочного начисления',
    });
    expect(violatesContributionRule(fix)).toBeNull();
    expect(validateEntry(fix).ok).toBe(true);
  });

  it('потратив пользу, вклад не теряют — и сумма по слоям сходится', () => {
    // Одно действие: 100 в пользу и 100 в вклад.
    let balances: Record<string, number> = {};
    const utility = applyToBalances(balances, entry({
      debitAccount: SYSTEM_ACCOUNTS.emission,
      creditAccount: userAccount(ALICE),
      sourceRef: 'r1',
    }));
    expect(utility.ok).toBe(true);
    if (!utility.ok) return;
    balances = utility.balances;

    const contribution = applyToBalances(balances, entry());
    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;
    balances = contribution.balances;

    // Тратим всю пользу.
    const spent = applyToBalances(balances, entry({
      debitAccount: userAccount(ALICE),
      creditAccount: SYSTEM_ACCOUNTS.burn,
      operation: 'redeem',
      source: 'tour_discount',
      sourceRef: 'chk1',
    }));
    expect(spent.ok).toBe(true);
    if (!spent.ok) return;
    balances = spent.balances;

    expect(balances[userAccount(ALICE)]).toBe(0);   // польза потрачена
    expect(balances[contribAccount(ALICE)]).toBe(100); // вклад остался
    expect(invariantSum(balances)).toBe(0);
  });
});

describe('Закон 6 — безопасность не продаётся', () => {
  it('весь реестр стоков проходит гвард', () => {
    for (const sink of Object.values(ECO_SINKS)) {
      const verdict = validateSink(sink);
      expect(verdict.ok, `сток ${sink.key}: ${verdict.ok ? '' : verdict.reason}`).toBe(true);
    }
  });

  const forbidden: EcoSink[] = [
    { key: 'skip_mchs', label: 'Пропустить регистрацию МЧС', description: 'Выход без регистрации', maxShareOfCheck: 1 },
    { key: 'no_guide', label: 'Маршрут без гида', description: 'Снятие требования сопровождения', maxShareOfCheck: 1 },
    { key: 'closed_route', label: 'Доступ к закрытому маршруту', description: 'Проход на закрытый участок', maxShareOfCheck: 1 },
    { key: 'boost', label: 'Приоритет в выдаче', description: 'Поднятие оператора без верификации', maxShareOfCheck: 1 },
    { key: 'hide_alert', label: 'Скрыть предупреждение', description: 'Убрать тревогу о состоянии тропы', maxShareOfCheck: 1 },
  ];

  it.each(forbidden)('сток «$label» отвергается гвардом', (sink) => {
    const verdict = validateSink(sink);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('безопасность не продаётся');
  });

  it('списание мимо реестра стоков невозможно', () => {
    expect(resolveSink('skip_mchs').ok).toBe(false);
    expect(resolveSink('произвольная_строка').ok).toBe(false);
    expect(resolveSink('tour_discount').ok).toBe(true);
  });

  it('доля чека ограничена: скидка не съедает маржу того, кто её обеспечивает', () => {
    const tour = ECO_SINKS.tour_discount;
    expect(maxEcoForCheck(tour, 10_000)).toBe(3_000);
    expect(maxEcoForCheck(tour, 0)).toBe(0);
    expect(validateSink({ ...tour, maxShareOfCheck: 1.5 }).ok).toBe(false);
  });
});

describe('миграция 773 — гарантии слоёв на уровне БД', () => {
  const sql = readFileSync(join(process.cwd(), 'migrations', '773_eco_contribution_layer.sql'), 'utf-8');

  it('списание со счёта вклада запрещено триггером, а не только кодом', () => {
    expect(sql).toMatch(/BEFORE INSERT ON eco_ledger/);
    expect(sql).toMatch(/debit_account LIKE 'contrib:%'/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
  });

  it("исключение только для 'adjust' — видимого исправления", () => {
    expect(sql).toContain("NEW.operation <> 'adjust'");
  });

  it('у слоя вклада свой контр-счёт: инвариант остаётся нулевым', () => {
    expect(sql).toContain('system:contribution');
  });

  it('перенос берёт всё заработанное, а не текущий баланс', () => {
    expect(sql).toMatch(/operation IN \('emit', 'opening', 'refund'\)/);
  });
});
