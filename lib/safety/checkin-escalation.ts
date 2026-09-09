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
 *
 * Отметка «я в порядке» ОТОДВИГАЕТ следующий шаг на буфер, но не отменяет
 * лестницу: свежая отметка знает о настоящем, вчерашняя — нет.
 */

export type TripKind = 'day' | 'multi';

export type EscalationStep = 'soft' | 'hard' | 'mchs';

export interface EscalationDecision {
  step: EscalationStep;
  /** Просрочка от КОНТРОЛЬНОГО времени — правда о том, насколько группа опаздывает. */
  hoursOverdue: number;
  /** Часы с последней отметки «всё в порядке»; null — отметки не было. */
  hoursSinceConfirm: number | null;
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
  // Подтверждение «я в порядке» ОТОДВИГАЕТ отсчёт, а не отменяет его.
  //
  // Раньше здесь стоял `return null`: одно подтверждение снимало тревогу
  // НАВСЕГДА, включая шаг МЧС. Писать `checkin_confirmed_at` было некому,
  // поэтому ветка была мёртвой и цены не имела; в тот день, когда появился
  // писатель (кнопка «я в порядке»), она стала бы дырой ровно в том месте,
  // ради которого платформа существует: группа отмечается в 14:00 «идём,
  // задерживаемся», в 15:00 с ней случается беда — и сторож молчит до
  // конца времён.
  //
  // Свежая отметка знает о настоящем, вчерашняя — нет. Поэтому подтверждение
  // сдвигает точку отсчёта на себя: следующий шаг лестницы наступит через
  // тот же буфер уже от отметки. Пройденные шаги остаются пройденными —
  // лестница не начинается заново и повторных сообщений не шлёт.
  const confirmedAfterControl = confirmedAt && confirmedAt > controlTime ? confirmedAt : null;
  const effectiveControl = confirmedAfterControl ?? controlTime;

  const hoursOverdue = (now.getTime() - controlTime.getTime()) / 3_600_000;
  const hoursSinceEffective = (now.getTime() - effectiveControl.getTime()) / 3_600_000;
  if (hoursOverdue <= 0) return null;

  const buf = BUFFERS[tripKind];

  const nextStep: EscalationStep | null =
    hoursSinceEffective >= buf.mchs && !alreadySent.includes('mchs')  ? 'mchs'  :
    hoursSinceEffective >= buf.hard && !alreadySent.includes('hard')  ? 'hard'  :
    hoursSinceEffective >= buf.soft && !alreadySent.includes('soft')  ? 'soft'  :
    null;

  if (!nextStep) return null;
  return {
    step: nextStep,
    hoursOverdue,
    hoursSinceConfirm: confirmedAfterControl ? hoursSinceEffective : null,
  };
}

// ── Тексты уведомлений ───────────────────────────────────────────────────────
// Все шаги реально уходят экстренному контакту (телеграм-канала к самому
// туристу у нас нет), поэтому и обращение — к контакту, а не «Вы
// зарегистрировали маршрут». В каждом сообщении — ссылка «Я вернулся»:
// контакт связывается с группой и закрывает регистрацию сам (для
// подтверждения без входа достаточно номера руководителя — поле для него
// есть на самой странице отметки).

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
  /** Ссылка «Мы в порядке, ещё в пути» — vedarai.ru/checkin-ok?id=<регистрация>. */
  checkinUrl?: string;
  /** Часы с последней отметки «в порядке»; null/undefined — отметки не было. */
  hoursSinceConfirm?: number | null;
  /**
   * Готовый текст времени, когда контакт отметил «я сам сообщил в МЧС».
   * Не гасит шаг МЧС: самоотчёт — не подтверждение приёма заявки. Он только
   * предупреждает дежурного о возможном дубле.
   */
  mchsInformedText?: string | null;
}

export function formatPositionText(lat: string | null, lng: string | null): string {
  if (!lat || !lng) return 'неизвестно';
  return `${parseFloat(lat).toFixed(5)}° N, ${parseFloat(lng).toFixed(5)}° E`;
}

/**
 * Камчатское время (UTC+12, круглый год) в виде «19.07 20:00».
 *
 * Считаем сдвигом, а не `toLocaleString`: набор часовых поясов в рантайме
 * зависит от сборки ICU, и на урезанной сборке локализация молча отдаёт UTC —
 * то есть время звонка в 112 уехало бы на двенадцать часов, и никто бы не
 * заметил.
 */
export function formatKamchatkaTime(date: Date): string {
  const shifted = new Date(date.getTime() + 12 * 3_600_000);
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi} (камч.)`;
}

export function buildEscalationMessage(
  input: EscalationMessageInput,
  step: EscalationStep,
  hoursOverdue: number,
): string {
  const hours = hoursOverdue.toFixed(1);
  const confirmLine =
    typeof input.hoursSinceConfirm === 'number'
      ? `Последняя отметка «всё в порядке» — ${input.hoursSinceConfirm.toFixed(1)} ч назад.\n`
      : '';
  // Две отметки — два разных события, и путать их нельзя: «вернулись» закрывает
  // маршрут, «в порядке» только отодвигает следующий шаг. Обе просят номер
  // руководителя, и об этом сказано один раз, отдельной строкой.
  const marksBlock =
    `Если группа вернулась — отметьте возвращение:\n${input.returnUrl}\n` +
    (input.checkinUrl
      ? `Если группа ещё в пути и всё в порядке — отметьте это:\n${input.checkinUrl}\n`
      : '') +
    `Для отметки понадобится номер телефона руководителя.`;

  if (step === 'soft') {
    return (
      `Напоминание от Ведара: группа «${input.routeName}» под руководством ` +
      `${input.leaderName} должна была вернуться ${hours} ч назад и ещё не отметилась.\n` +
      confirmLine +
      `Свяжитесь с руководителем: ${input.leaderPhone}. На маршруте часто нет связи — ` +
      `это само по себе не повод для тревоги.\n` +
      marksBlock
    );
  }
  if (step === 'hard') {
    return (
      `ВНИМАНИЕ: турист ${input.leaderName} (${input.leaderPhone}) не вернулся с маршрута ` +
      `«${input.routeName}» уже ${hours} ч.\n` +
      confirmLine +
      `Последняя известная позиция: ${input.positionText}.\n` +
      `Пожалуйста, свяжитесь с туристом.\n` +
      marksBlock + `\n` +
      `Если контакт не удался — звоните 112.`
    );
  }
  const mchsNote = input.mchsInformedText
    ? `В МЧС уже сообщили сами (отмечено ${input.mchsInformedText}) — проверьте, не дублируйте обращение.\n`
    : '';
  return (
    `ЭКСТРЕННАЯ СИТУАЦИЯ: турист ${input.leaderName} (${input.leaderPhone}) не вернулся с маршрута ` +
    `«${input.routeName}» уже ${hours} ч.\n` +
    confirmLine +
    mchsNote +
    `Экстренный контакт: ${input.emergencyContactName} (${input.emergencyContactPhone}).\n` +
    `Последняя известная позиция: ${input.positionText}.\n` +
    `Отметка о возвращении (если группа нашлась): ${input.returnUrl}\n` +
    `Рекомендуем немедленно сообщить в МЧС: 112.`
  );
}
