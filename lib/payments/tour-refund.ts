/**
 * Сколько вернуть туристу при отмене тура — одно правило на все двери.
 *
 * Решение владельца 24.09: «как у оператора». Условия отмены тура — его
 * собственные (`operator_tours.cancellation_policy`, текст для человека), а
 * для счёта — два числа рядом (миграция 1012):
 *
 *   cancellation_free_days            — за сколько календарных дней до тура
 *                                       отмена ещё бесплатна;
 *   cancellation_late_refund_percent  — сколько процентов вернуть при отмене
 *                                       позже этого срока.
 *
 * Исходы:
 *   - отменил оператор (или администратор) — 100%, всегда: турист не
 *     отказывался от поездки, у него её забрали;
 *   - условий нет (хоть одно из чисел NULL) — 100% (решение владельца 24.09):
 *     пробел в данных оператора не должен стоить туристу денег;
 *   - до срока — 100%, позже — `late_refund_percent`.
 *
 * Дни календарные, по времени Камчатки (решение владельца 24.09): «за 3 дня
 * до тура» при туре 10-го значит, что отмена 7-го (за три дня) ещё бесплатна,
 * а 8-го — уже нет. Час отмены внутри дня не важен — важна дата на Камчатке,
 * а не на сервере в UTC: полночь по UTC на Камчатке уже полдень.
 *
 * Модуль чистый — без БД. Сумма здесь — ОБЯЗАННОСТЬ платформы вернуть, а не
 * факт перевода: платёжного API возврата нет, деньги переводит администратор
 * и отмечает это в /api/admin/finance/refunds.
 */

export const KAMCHATKA_TZ = 'Asia/Kamchatka';

export type TourRefundBasis = 'operator_cancel' | 'no_terms' | 'free_window' | 'late';

export interface TourRefundTerms {
  freeDays: number | null;
  lateRefundPercent: number | null;
}

export interface TourRefundInput {
  /** Сколько турист заплатил. */
  paidAmount: number;
  /** Дата тура (YYYY-MM-DD или Date — берётся календарная дата). */
  tourDate: string | Date;
  /** Момент отмены. */
  cancelledAt: Date;
  terms: TourRefundTerms;
  byOperator: boolean;
}

export interface TourRefund {
  percent: number;
  amount: number;
  basis: TourRefundBasis;
  /** Для туриста: почему столько. */
  reason: string;
}

/** Календарная дата момента на Камчатке, YYYY-MM-DD. */
export function kamchatkaDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KAMCHATKA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

function tourDay(d: string | Date): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

/** Сколько календарных дней от даты отмены до даты тура (может быть < 0). */
export function daysBeforeTour(tourDate: string | Date, cancelledAt: Date): number {
  const tour = Date.parse(`${tourDay(tourDate)}T00:00:00Z`);
  const cancel = Date.parse(`${kamchatkaDate(cancelledAt)}T00:00:00Z`);
  return Math.round((tour - cancel) / 86_400_000);
}

function validPercent(p: number | null): p is number {
  return p !== null && Number.isFinite(p) && p >= 0 && p <= 100;
}

function validDays(d: number | null): d is number {
  return d !== null && Number.isInteger(d) && d >= 0;
}

function money(n: number): number {
  return Math.round(n * 100) / 100;
}

function daysWord(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'день';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'дня';
  return 'дней';
}

export function computeTourRefund(input: TourRefundInput): TourRefund {
  const paid = Number.isFinite(input.paidAmount) && input.paidAmount > 0 ? input.paidAmount : 0;

  if (input.byOperator) {
    return { percent: 100, amount: money(paid), basis: 'operator_cancel', reason: 'Тур отменил оператор — полный возврат.' };
  }

  const { freeDays, lateRefundPercent } = input.terms;
  if (!validDays(freeDays) || !validPercent(lateRefundPercent)) {
    return {
      percent: 100, amount: money(paid), basis: 'no_terms',
      reason: 'У тура не записаны условия отмены — полный возврат.',
    };
  }

  const left = daysBeforeTour(input.tourDate, input.cancelledAt);
  if (left >= freeDays) {
    return {
      percent: 100, amount: money(paid), basis: 'free_window',
      reason: `Отмена не позднее чем за ${freeDays} ${daysWord(freeDays)} до тура — полный возврат по условиям оператора.`,
    };
  }
  return {
    percent: lateRefundPercent,
    amount: money((paid * lateRefundPercent) / 100),
    basis: 'late',
    reason: lateRefundPercent === 0
      ? `Отмена позже чем за ${freeDays} ${daysWord(freeDays)} до тура — по условиям оператора возврата нет.`
      : `Отмена позже чем за ${freeDays} ${daysWord(freeDays)} до тура — по условиям оператора возвращается ${lateRefundPercent}%.`,
  };
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «7 октября» из YYYY-MM-DD, минус `days` календарных дней. */
function dayMinus(tourDate: string, days: number): string {
  const t = new Date(`${tourDate.slice(0, 10)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - days);
  return `${t.getUTCDate()} ${MONTHS_GEN[t.getUTCMonth()]}`;
}

/** Родительный падеж после «меньше»: меньше 1 дня, меньше 3 дней, меньше 21 дня. */
function daysGen(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'дня' : 'дней';
}

function lateTail(percent: number): string {
  return percent === 0 ? 'позже возврата нет' : `позже возвращается ${percent}%`;
}

/**
 * Условия отмены одной строкой — для туриста ДО отправки заявки (27.09).
 *
 * Модуль бронирования отеля показывает условия отмены у каждого тарифа до
 * брони; у нас они были только текстом в карточке, а в форме — нигде. Строка
 * считается ТЕМ ЖЕ правилом, что и настоящий возврат (`computeTourRefund`):
 * граница «не позднее чем за N дней» включительно, календарь Камчатки, пустые
 * условия — полный возврат. Разойдись они — форма обещала бы одно, а при
 * отмене вернулось бы другое.
 *
 * `tourDate` не выбрана — правило без даты. `now` — для тестов.
 */
export function cancellationTermsLine(
  terms: TourRefundTerms,
  tourDate: string | null,
  now: Date = new Date(),
): string {
  const { freeDays, lateRefundPercent } = terms;
  if (!validDays(freeDays) || !validPercent(lateRefundPercent)) {
    return 'Условия отмены оператор не записал — при отмене вернём всю сумму.';
  }
  if (!tourDate) {
    return `Бесплатная отмена не позднее чем за ${freeDays} ${daysWord(freeDays)} до тура, ${lateTail(lateRefundPercent)}.`;
  }
  const left = daysBeforeTour(tourDate, now);
  if (left >= freeDays) {
    return `Бесплатная отмена до ${dayMinus(tourDate, freeDays)} включительно, ${lateTail(lateRefundPercent)}.`;
  }
  return lateRefundPercent === 0
    ? `До тура меньше ${freeDays} ${daysGen(freeDays)}: по условиям оператора при отмене возврата нет.`
    : `До тура меньше ${freeDays} ${daysGen(freeDays)}: по условиям оператора при отмене возвращается ${lateRefundPercent}%.`;
}
