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

import { kamchatkaDayStart } from '@/lib/analytics/kamchatka-day';
import { VERIFIED_REGIONAL } from '@/lib/safety/emergency-numbers';

export type TripKind = 'day' | 'multi';

export type EscalationStep = 'soft' | 'hard' | 'mchs';

export interface EscalationDecision {
  step: EscalationStep;
  /** Просрочка от КОНТРОЛЬНОГО времени — правда о том, насколько группа опаздывает. */
  hoursOverdue: number;
  /** Часы с последней отметки «всё в порядке»; null — отметки не было. */
  hoursSinceConfirm: number | null;
}

const STEP_RANK: Record<EscalationStep, number> = { soft: 1, hard: 2, mchs: 3 };

export const BUFFERS: Record<TripKind, { soft: number; hard: number; mchs: number }> = {
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
 * Календарная дата значения колонки DATE. node-pg отдаёт DATE как Date на
 * ЛОКАЛЬНОЙ полуночи процесса, поэтому дата берётся локальными геттерами; строка
 * «YYYY-MM-DD» — как есть.
 */
export function ymdOfDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
}

/**
 * Момент (UTC) для камчатских «даты и часа на стене»: «2026-10-04» + «19:00» →
 * 2026-10-04T07:00Z.
 *
 * Повод (30.09). Регистрация строила срок как `new Date('2026-10-04T19:00:00')`
 * — БЕЗ пояса, то есть по часам Node, а Node на проде живёт в UTC
 * (lib/analytics/kamchatka-day.ts). «Вернусь в 19:00» записывалось как 07:00
 * следующего утра по Камчатке, и первая тревога уходила на 12 часов позже
 * обещанного. Тем же страдал запасной срок «20:00 в день окончания».
 */
export function kamchatkaWallTime(dateYmd: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(kamchatkaDayStart(dateYmd).getTime() + (h * 60 + (m || 0)) * 60_000);
}

/**
 * Вычисляет контрольное время возврата.
 * Если `expectedReturnAt` задано — используем его.
 * Иначе fallback: end_date + 20:00 по Камчатке (консервативно, не полночь).
 */
export function resolveControlTime(
  endDate: Date | string,
  expectedReturnAt: Date | null,
): Date {
  if (expectedReturnAt) return expectedReturnAt;
  return kamchatkaWallTime(ymdOfDate(endDate), '20:00');
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

  // Лестница только вверх. После простоя сторожа догоняющий прогон берёт
  // старшую назревшую ступень; младшие после неё НЕ шлются — иначе дежурный
  // получил бы «МЧС-ТРЕВОГУ», а через час контакт — «это не повод для тревоги»
  // (разбор противником, 30.09).
  const sentRank = Math.max(0, ...alreadySent.map((st) => STEP_RANK[st]));
  const due = (st: EscalationStep, hours: number) =>
    hoursSinceEffective >= hours && STEP_RANK[st] > sentRank;
  const nextStep: EscalationStep | null =
    due('mchs', buf.mchs) ? 'mchs' :
    due('hard', buf.hard) ? 'hard' :
    due('soft', buf.soft) ? 'soft' :
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
  /** Готовый текст позиции: «53.02° N, 158.65° E (телефон, 30.09 14:20 (камч.))» или «неизвестно». */
  positionText: string;
  /** Сколько человек в группе: первый вопрос диспетчера МЧС. null — не указано. */
  groupSize?: number | null;
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

/**
 * Откуда пришла последняя точка. `null` — источник не записан (регистрации
 * до миграции 985); догадываться задним числом нельзя.
 */
export type PositionSource = 'phone' | 'tracker' | null;

/**
 * Позиция словами — с указанием, ЧТО именно её прислало.
 *
 * Источник появился 19.09 вместе с приёмником спутникового трекера, и он не
 * украшение. Для того, кто едет искать человека, две одинаково старые точки
 * значат разное:
 *
 *   телефон — час назад у него БЫЛА СВЯЗЬ (значит место с покрытием, и
 *             молчание после этого — новость);
 *   трекер  — час назад было живо УСТРОЙСТВО (связи могло не быть вовсе,
 *             и молчание телефона ничего не добавляет).
 *
 * Слить их в одну строку значило бы потерять ровно то, ради чего трекер и
 * подключают.
 */
export function formatPositionText(
  lat: string | null,
  lng: string | null,
  source: PositionSource = null,
  at: Date | null = null,
): string {
  if (!lat || !lng) return 'неизвестно';
  const point = `${parseFloat(lat).toFixed(5)}° N, ${parseFloat(lng).toFixed(5)}° E`;
  // Точка без времени — полправды (манифест, правило 6): вчерашняя и
  // пятиминутная точки ведут спасателей в разные места.
  const when = at ? `, ${formatKamchatkaTime(at)}` : ', время не записано';
  if (source === 'tracker') return `${point} (спутниковый трекер${when})`;
  if (source === 'phone') return `${point} (телефон${when})`;
  // Источник не записан — так и молчим. Приписать «телефон» было бы
  // догадкой в сообщении, по которому поднимают спасателей (§4.0).
  return `${point} (источник не записан${when})`;
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
  const groupLine = input.groupSize ? `Людей в группе: ${input.groupSize}.\n` : '';
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
      groupLine +
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
    groupLine +
    confirmLine +
    mchsNote +
    `Экстренный контакт: ${input.emergencyContactName} (${input.emergencyContactPhone}).\n` +
    `Последняя известная позиция: ${input.positionText}.\n` +
    `Отметка о возвращении (если группа нашлась): ${input.returnUrl}\n` +
    // Правило решения, а не «немедленно в МЧС»: тишина — ещё не беда (Cal OES:
    // не дозвонились ни до туриста, ни до контакта или неясно, что с ним, —
    // считать ЧС). Номер — только проверенный (lib/safety/emergency-numbers.ts).
    `Позвоните туристу и контакту. Не дозвонились ни до кого или неясно, что с человеком, — ` +
    `передавайте в МЧС: ${VERIFIED_REGIONAL[0].name} ${VERIFIED_REGIONAL[0].phone} или 112.`
  );
}

/**
 * Первая ступень — самому туристу, в чат, из которого он поставил контроль
 * (манифест, правило 4: сначала человек, потом контакт). Будить его раньше
 * контакта — не вежливость: половина тревог — забытая отметка, и снять её
 * может только он сам, одним словом.
 */
export function buildTouristWakeMessage(input: {
  routeName: string;
  controlTime: Date;
  contactName: string;
  hoursUntilContact: number;
  /** У контакта нет своего канала — следующую ступень несёт дежурный звонком. */
  contactByDuty: boolean;
}): string {
  const h = Math.max(1, Math.round(input.hoursUntilContact));
  const next = input.contactByDuty
    ? `дежурный Ведара позвонит ${input.contactName}`
    : `я сообщу ${input.contactName}`;
  return [
    `Вы не отметились: контроль «${input.routeName}» ждал вас к ${formatKamchatkaTime(input.controlTime)}.`,
    '',
    'Вернулись — напишите «вернулся».',
    // Новый срок — лучший ответ: с ним лестница начинается заново с вопроса
    // туристу, а «задерживаюсь» только отодвигает следующий шаг.
    'Задерживаетесь — напишите новое время: «+2 ч» или «до 21:00».',
    'Всё в порядке, но срок назвать не можете — «задерживаюсь».',
    '',
    `Если не ответите, примерно через ${h} ч ${next}. В беде — 112.`,
  ].join('\n');
}
