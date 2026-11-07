/**
 * lib/planner/calendar-days.ts — номер дня плана = день поездки по календарю
 * (аудит планировщика 07.11, волна 2, H2–H4). Чистый модуль: его читает
 * браузер (/planner), ни базы, ни движка.
 *
 * ── Что было до 07.11 ─────────────────────────────────────────────────────
 *
 * В веб-планере номер дня был ключом карточки и не пересчитывался, а дата
 * дня считалась двумя правилами. По месту на экране — кружок дня, «Уточнить
 * места», ссылка из дня в форму тура, «Что ещё нужно» (жильё на ночи). По
 * номеру — смета, заявка оператору, сохранение (а за ним GPX и страница по
 * ссылке). Пока план не трогали, правила совпадали. Удалили, переставили или
 * вставили день — расходились: тур в заявке на одну дату, в форме тура — на
 * другую; ночь выбранного жилья считалась дважды или пропадала.
 *
 * Движок добавлял третье: день отъезда он нумерует датой, а недобор
 * («наполнили 4 из 6») оставляет дырой в номерах (engine.ts). По месту на
 * экране отъезд съезжал на день раньше рейса.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * Дни плана идут подряд с первого: номер дня = место в плане = день поездки,
 * дата — прилёт + номер − 1 (`dateOfTripDay`). Его держат четыре операции:
 *
 * - пропуск движка и хвост поездки — свободные дни (`fillCalendarGaps`);
 * - удалённый день становится свободным: поездка не короче, даты остальных
 *   дней прежние (`freeDaysInstead`);
 * - перестановка меняет содержимое дней, а не их даты (`renumberByPosition`):
 *   что сменило место, то сменило и дату, и места тура от прежней даты с
 *   него сняты — на новую дату их никто не проверял (§4.0);
 * - новый день занимает свободный; свободного нет — поездка становится на
 *   день длиннее, отъезд сдвигается (`extendTrip`), и это говорится.
 */
import type { ZoneId } from './constants';
import { insertIndex } from './plan-ops';

/** Минимум дня, с которым работают правила: день движка и день экрана подходят. */
export interface CalendarDayLike {
  day: number;
  type: string;
  zone: ZoneId;
  zoneShown?: string | null;
  title: string;
}

export const FREE_DAY_TITLE = 'Свободный день';
export const FREE_DAY_TEXT = 'В плане на этот день ничего нет: отдых или маршрут, выбранный на карте.';

/**
 * Точка свободного дня — та же, что у дня отдыха движка (`requestedRestDay`):
 * в Авачинской зоне — Петропавловск, в остальных — центр зоны. Своего места
 * свободному дню не выдумывается: где человек его проведёт, план не знает.
 * Совпадение с движком держит сторож (tests/unit/planner-calendar-days.test.ts).
 */
export const FREE_DAY_POINT: Readonly<Record<ZoneId, readonly [number, number]>> = {
  avachinsky: [53.01, 158.65],
  western: [52.50, 156.50],
  eastern: [54.80, 160.50],
  northern: [54.50, 160.27],
};

export interface FreeDay {
  day: number;
  type: 'rest';
  zone: ZoneId;
  zoneShown?: string | null;
  title: string;
  description: string;
  /** Не активность: проверка плана (/api/planner/validate) и смета его не считают. */
  activityType: 'rest';
  priceFrom: number;
  priceTo: number;
  coords: [number, number];
  defaultTransport: 'walking';
  allowedTransports: Array<'walking'>;
  difficulty: 'easy';
  childFriendly: boolean;
  minChildAge: number;
  dayWarnings: string[];
}

/**
 * Свободный день с этим номером. Зона — того дня, рядом с которым он стоит
 * (или который заменяет): человек ночует там же, и смета, и проверка плана
 * не видят переезда, которого нет.
 */
export function freeDay(num: number, near: Pick<CalendarDayLike, 'zone' | 'zoneShown'>): FreeDay {
  const [lat, lng] = FREE_DAY_POINT[near.zone];
  return {
    day: num, type: 'rest', zone: near.zone,
    ...(near.zoneShown !== undefined ? { zoneShown: near.zoneShown } : {}),
    title: FREE_DAY_TITLE, description: FREE_DAY_TEXT,
    activityType: 'rest', priceFrom: 0, priceTo: 0, coords: [lat, lng],
    defaultTransport: 'walking', allowedTransports: ['walking'],
    difficulty: 'easy', childFriendly: true, minChildAge: 0, dayWarnings: [],
  };
}

export function isFreeDay(d: Pick<CalendarDayLike, 'type' | 'title'>): boolean {
  return d.type === 'rest' && d.title === FREE_DAY_TITLE;
}

/** Первый свободный день; с зоной — первый свободный в этой зоне. */
export function firstFreeDay<T extends CalendarDayLike>(days: readonly T[], zone?: ZoneId): T | undefined {
  return days.find((d) => isFreeDay(d) && (zone === undefined || d.zone === zone));
}

/** Дни идут подряд с первого: номер = место в плане + 1. */
export function inCalendarOrder(days: readonly Pick<CalendarDayLike, 'day'>[]): boolean {
  return days.every((d, i) => d.day === i + 1);
}

/**
 * Поля дня, верные только для его прежней даты: места и дата слота тура,
 * время проверки, предупреждение о местах, прогноз. День, сменивший дату,
 * их теряет — «не проверено на эту дату», а не чужой ответ.
 */
const DATE_BOUND = [
  'availableDate', 'slotsRemaining', 'availability', 'availabilityCheckedAt', 'capacityWarning', 'weatherForecast',
] as const;

function movedToAnotherDate<T extends { day: number }>(d: T, day: number): T {
  const copy = { ...d } as T & Record<string, unknown>;
  for (const k of DATE_BOUND) delete copy[k];
  copy.day = day;
  return copy;
}

/** Куда ушёл каждый день: прежний номер → новый (у всех дней, и у оставшихся на месте). */
export type NewNumbers = ReadonlyMap<number, number>;

/**
 * Номера по местам — после перестановки. Содержимое, сменившее место, сменило
 * и дату: места тура и прогноз прежней даты с него сняты. `newNumbers` —
 * чтобы состояние экрана, привязанное к номеру (транспорт дня, отметки,
 * открытый день), ушло вслед за днём.
 */
export function renumberByPosition<T extends CalendarDayLike>(days: readonly T[]): { days: T[]; newNumbers: NewNumbers } {
  const newNumbers = new Map<number, number>();
  const out = days.map((d, i) => {
    newNumbers.set(d.day, i + 1);
    return d.day === i + 1 ? d : movedToAnotherDate(d, i + 1);
  });
  return { days: out, newNumbers };
}

/**
 * Дни плана от движка — подряд с первого по последний день поездки. Пропуск в
 * номерах (недобор, день отъезда с номером-датой) и незаполненный хвост (у
 * местного дня отъезда нет) — свободные дни там, где человек был накануне.
 * `tripDays` — дни поездки по датам (`tripCalendarDays`); нет дат — хвост не
 * достраивается. После дня отъезда дней не бывает: он и есть конец поездки.
 */
export function fillCalendarGaps<T extends CalendarDayLike>(days: readonly T[], tripDays: number | null): Array<T | FreeDay> {
  const sorted = [...days].sort((a, b) => a.day - b.day);
  const out: Array<T | FreeDay> = [];
  let next = 1;
  for (const d of sorted) {
    const near = out[out.length - 1] ?? d;
    while (next < d.day) out.push(freeDay(next++, near));
    out.push(d);
    next = Math.max(next, d.day + 1);
  }
  const last = out[out.length - 1];
  if (last && last.type !== 'departure' && tripDays !== null) {
    while (next <= tripDays) out.push(freeDay(next++, last));
  }
  // Два дня с одним номером — сбой раскладки; номер по месту хотя бы не
  // даёт двум карточкам одну дату.
  return inCalendarOrder(out) ? out : renumberByPosition(out).days;
}

/**
 * Убранные дни → свободные дни с теми же номерами и в той же зоне: поездка не
 * короче, даты остальных дней прежние, ночь человек проводит там же.
 */
export function freeDaysInstead<T extends CalendarDayLike>(days: readonly T[], gone: ReadonlySet<number>): Array<T | FreeDay> {
  return days.map((d) => (gone.has(d.day) ? freeDay(d.day, d) : d));
}

/**
 * Новый день там, где свободного нет: перед отъездом (у местного — в конце),
 * дни после него — на день позже. Поездка становится на день длиннее:
 * вызывающий сдвигает дату отъезда и говорит об этом. Дни на входе — подряд
 * с первого (`inCalendarOrder`): номера считаются по местам.
 */
export function extendTrip<T extends CalendarDayLike, N extends CalendarDayLike>(
  days: readonly T[],
  make: (num: number, near: T) => N,
): { days: Array<T | N>; added: number; newNumbers: NewNumbers } {
  const at = insertIndex(days);
  const added = at + 1;
  const near = days[at - 1] ?? days[at];
  const newNumbers = new Map<number, number>();
  days.forEach((d, i) => newNumbers.set(d.day, i < at ? i + 1 : i + 2));
  const out: Array<T | N> = [
    ...days.slice(0, at),
    ...(near ? [make(added, near)] : []),
    ...days.slice(at).map((d, k) => movedToAnotherDate(d, at + k + 2)),
  ];
  return { days: out, added, newNumbers };
}

/** Состояние экрана, привязанное к номеру дня, — вслед за днями; ушедшие выпадают. */
export function followDays<V>(byDay: Readonly<Record<number, V>>, newNumbers: NewNumbers): Record<number, V> {
  const out: Record<number, V> = {};
  for (const [k, v] of Object.entries(byDay)) {
    const to = newNumbers.get(Number(k));
    if (to !== undefined) out[to] = v;
  }
  return out;
}

export function followDaySet(set: ReadonlySet<number>, newNumbers: NewNumbers): Set<number> {
  const out = new Set<number>();
  for (const k of set) {
    const to = newNumbers.get(k);
    if (to !== undefined) out.add(to);
  }
  return out;
}

// ── Даты формы ───────────────────────────────────────────────────────────────

function plural(n: number, one: string, few: string, many: string): string {
  const m100 = n % 100;
  if (m100 >= 11 && m100 <= 14) return many;
  const m10 = n % 10;
  if (m10 === 1) return one;
  if (m10 >= 2 && m10 <= 4) return few;
  return many;
}

/**
 * Длина поездки словами: «5 дней (4 ночи)», «1 день, без ночёвки». Дни — по
 * календарю, как у движка: 10→14 июля — пять дней, а не четыре (H3).
 */
export function tripLengthWords(days: number): string {
  if (days <= 1) return '1 день, без ночёвки';
  const nights = days - 1;
  return `${days} ${plural(days, 'день', 'дня', 'дней')} (${nights} ${plural(nights, 'ночь', 'ночи', 'ночей')})`;
}

/**
 * Что не так с датами формы; null — годятся. Житель края может уложиться в
 * один день: выехал утром, вернулся вечером (H4). У прилетающего прилёт и
 * отъезд в один день — не поездка.
 */
export function tripDatesProblem(arrival: string, departure: string, local: boolean): string | null {
  if (local) {
    return departure < arrival ? 'Последний день поездки не может быть раньше первого.' : null;
  }
  return departure <= arrival ? 'Дата отъезда должна быть позже даты прилёта.' : null;
}

/** Сегодня по Камчатке, YYYY-MM-DD: даты поездки — местные (H5). */
export function kamchatkaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kamchatka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}
