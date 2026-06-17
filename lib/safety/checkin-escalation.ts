/**
 * lib/safety/checkin-escalation.ts
 *
 * Ядро логики эскалации: «какой шаг нужен для этой регистрации прямо сейчас».
 * Чистые функции — без БД, без сети. Покрыты тестами.
 *
 * БУФЕРЫ (стартовые дефолты из логики гипотермии и автономности,
 * НЕ из полевой статистики — калибровать после накопления реальных данных):
 *
 *   Однодневка (trip_kind='day'):
 *     soft  = 1ч после expected_return_at
 *     hard  = 3ч после expected_return_at
 *
 *   Многодневка (trip_kind='multi'):
 *     soft  = 3ч после expected_return_at
 *     hard  = 6ч после expected_return_at
 *
 * Лестница: none → soft (спросить туриста) → hard (экстренный контакт) → mchs
 * МЧС беспокоим последними.
 */

export type TripKind = 'day' | 'multi';

export type EscalationStep = 'soft' | 'hard' | 'mchs';

export interface EscalationDecision {
  step: EscalationStep;
  hoursOverdue: number;
}

const BUFFERS: Record<TripKind, { soft: number; hard: number; mchs: number }> = {
  day:   { soft: 1, hard: 3,  mchs: 8  },
  multi: { soft: 3, hard: 6,  mchs: 18 },
};

/** Определяет тип похода по датам. */
export function tripKindFromDates(startDate: Date, endDate: Date): TripKind {
  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth()    === endDate.getMonth() &&
    startDate.getDate()     === endDate.getDate();
  return sameDay ? 'day' : 'multi';
}

/**
 * Вычисляет контрольное время возврата.
 * Если `expectedReturnAt` задано — используем его.
 * Иначе fallback: end_date + 20:00 местного времени (консервативно, не полночь).
 */
export function resolveControlTime(
  endDate: Date,
  expectedReturnAt: Date | null,
): Date {
  if (expectedReturnAt) return expectedReturnAt;
  const fallback = new Date(endDate);
  fallback.setHours(20, 0, 0, 0);
  return fallback;
}

/**
 * Главная функция: решает, нужна ли эскалация и на каком уровне.
 *
 * @param controlTime  - когда должны были вернуться
 * @param tripKind     - тип похода
 * @param alreadySent  - шаги, уже отправленные ранее (идемпотентность)
 * @param confirmedAt  - когда турист подтвердил «я в порядке» (null если не было)
 * @param now          - текущее время (инжектируется для тестируемости)
 */
export function decideEscalation(
  controlTime: Date,
  tripKind: TripKind,
  alreadySent: EscalationStep[],
  confirmedAt: Date | null,
  now: Date = new Date(),
): EscalationDecision | null {
  // Подтверждение гасит тревогу, только если оно пришло ПОСЛЕ контрольного времени
  // (старые подтверждения не должны блокировать будущие просрочки)
  if (confirmedAt && confirmedAt > controlTime) return null;

  const hoursOverdue = (now.getTime() - controlTime.getTime()) / 3_600_000;
  if (hoursOverdue <= 0) return null;

  const buf = BUFFERS[tripKind];

  const nextStep: EscalationStep | null =
    hoursOverdue >= buf.mchs && !alreadySent.includes('mchs')  ? 'mchs'  :
    hoursOverdue >= buf.hard && !alreadySent.includes('hard')  ? 'hard'  :
    hoursOverdue >= buf.soft && !alreadySent.includes('soft')  ? 'soft'  :
    null;

  if (!nextStep) return null;
  return { step: nextStep, hoursOverdue };
}
