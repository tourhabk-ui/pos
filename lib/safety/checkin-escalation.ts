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

// ── Тексты уведомлений ───────────────────────────────────────────────────────
// Все шаги реально уходят экстренному контакту (телеграм-канала к самому
// туристу у нас нет), поэтому и обращение — к контакту, а не «Вы
// зарегистрировали маршрут». В каждом сообщении — ссылка «Я вернулся»:
// контакт связывается с группой и закрывает регистрацию сам (для
// подтверждения без входа достаточно номера руководителя).

export interface EscalationMessageInput {
  routeName: string;
  leaderName: string;
  leaderPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  /** Готовый текст позиции: «53.02° N, 158.65° E» или «неизвестно». */
  positionText: string;
  /** Ссылка «Я вернулся» — vedarai.ru/return?id=<регистрация>. */
  returnUrl: string;
}

export function formatPositionText(lat: string | null, lng: string | null): string {
  if (!lat || !lng) return 'неизвестно';
  return `${parseFloat(lat).toFixed(5)}° N, ${parseFloat(lng).toFixed(5)}° E`;
}

export function buildEscalationMessage(
  input: EscalationMessageInput,
  step: EscalationStep,
  hoursOverdue: number,
): string {
  const hours = hoursOverdue.toFixed(1);

  if (step === 'soft') {
    return (
      `Напоминание от Ведара: группа «${input.routeName}» под руководством ` +
      `${input.leaderName} должна была вернуться ${hours} ч назад и ещё не отметилась.\n` +
      `Свяжитесь с руководителем: ${input.leaderPhone}. На маршруте часто нет связи — ` +
      `это само по себе не повод для тревоги.\n` +
      `Если группа вернулась — отметьте возвращение (понадобится номер руководителя):\n` +
      `${input.returnUrl}`
    );
  }
  if (step === 'hard') {
    return (
      `ВНИМАНИЕ: турист ${input.leaderName} (${input.leaderPhone}) не вернулся с маршрута ` +
      `«${input.routeName}» уже ${hours} ч.\n` +
      `Последняя известная позиция: ${input.positionText}.\n` +
      `Пожалуйста, свяжитесь с туристом. Если группа вернулась — отметьте: ${input.returnUrl}\n` +
      `Если контакт не удался — звоните 112.`
    );
  }
  return (
    `ЭКСТРЕННАЯ СИТУАЦИЯ: турист ${input.leaderName} (${input.leaderPhone}) не вернулся с маршрута ` +
    `«${input.routeName}» уже ${hours} ч.\n` +
    `Экстренный контакт: ${input.emergencyContactName} (${input.emergencyContactPhone}).\n` +
    `Последняя известная позиция: ${input.positionText}.\n` +
    `Отметка о возвращении (если группа нашлась): ${input.returnUrl}\n` +
    `Рекомендуем немедленно сообщить в МЧС: 112.`
  );
}
