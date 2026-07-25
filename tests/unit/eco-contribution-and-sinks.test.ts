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
  MAX_SHARE_OF_CHECK,
  type EcoSink,
} from '@/lib/eco/sinks';
import {
  resolvePayer,
  termsFor,
  maxEcoForCheck,
  ACTIVE_OPERATOR_THRESHOLD,
} from '@/lib/eco/compensation';
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

  const full = 1;
  const forbidden: EcoSink[] = [
    { key: 'skip_mchs', label: 'Пропустить регистрацию МЧС', description: 'Выход без регистрации', maxShareOfCheck: full },
    { key: 'no_guide', label: 'Маршрут без гида', description: 'Снятие требования сопровождения', maxShareOfCheck: full },
    { key: 'closed_route', label: 'Доступ к закрытому маршруту', description: 'Проход на закрытый участок', maxShareOfCheck: full },
    { key: 'boost', label: 'Приоритет в выдаче', description: 'Поднятие оператора без верификации', maxShareOfCheck: full },
    { key: 'hide_alert', label: 'Скрыть предупреждение', description: 'Убрать тревогу о состоянии тропы', maxShareOfCheck: full },
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

  it('доля чека ограничена, и одинаково в обеих фазах', () => {
    const tour = ECO_SINKS.tour_discount;
    expect(maxEcoForCheck(tour, 10_000, 0)).toBe(1_500);   // платит платформа
    expect(maxEcoForCheck(tour, 10_000, 25)).toBe(1_500);  // платят операторы
    expect(maxEcoForCheck(tour, 0, 0)).toBe(0);
    expect(validateSink({ ...tour, maxShareOfCheck: 1.5 }).ok).toBe(false);
    expect(validateSink({ ...tour, maxShareOfCheck: 0 }).ok).toBe(false);
  });

  it('сток не может закрывать чек целиком — эко не средство платежа', () => {
    const greedy = { ...ECO_SINKS.tour_discount, maxShareOfCheck: 0.9 };
    const verdict = validateSink(greedy);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toContain('потолок единый');
  });
});

/**
 * Закон 5 — эмиссия обеспечена стоком. Решение владельца 25.07.2026: пока
 * активных операторов меньше двадцати, скидку несёт платформа из комиссии;
 * с двадцатого обязательство переходит к операторам. Доля чека при этом НЕ
 * меняется — 15% на все стоки в обеих фазах.
 */
describe('Закон 5 — кто платит за скидку', () => {
  it('до порога платит платформа', () => {
    expect(resolvePayer(0)).toBe('platform');
    expect(resolvePayer(ACTIVE_OPERATOR_THRESHOLD - 1)).toBe('platform');
  });

  it('с двадцатого активного оператора платят операторы', () => {
    expect(resolvePayer(ACTIVE_OPERATOR_THRESHOLD)).toBe('operator');
    expect(resolvePayer(100)).toBe('operator');
  });

  /**
   * Главный сторож против обрыва. Первая редакция роняла долю чека вдвое в
   * день появления двадцатого активного оператора: турист копил под одни
   * условия, а тратил под другие. Здесь проверяется, что смена фазы меняет
   * ТОЛЬКО плательщика — витрине нечего пересчитывать, а держателю нечего
   * замечать.
   */
  it('переход обязательства не трогает долю чека — меняется только плательщик', () => {
    for (const sink of Object.values(ECO_SINKS)) {
      const before = termsFor(sink, ACTIVE_OPERATOR_THRESHOLD - 1);
      const after = termsFor(sink, ACTIVE_OPERATOR_THRESHOLD);
      expect(before.payer).toBe('platform');
      expect(after.payer).toBe('operator');
      expect(after.maxShareOfCheck).toBe(before.maxShareOfCheck);
    }
  });

  it('доля чека одинакова у всех стоков и равна решению владельца', () => {
    for (const sink of Object.values(ECO_SINKS)) {
      expect(sink.maxShareOfCheck, `сток ${sink.key}`).toBe(MAX_SHARE_OF_CHECK);
    }
    expect(MAX_SHARE_OF_CHECK).toBe(0.15);
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
