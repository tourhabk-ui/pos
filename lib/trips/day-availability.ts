/**
 * lib/trips/day-availability.ts — что страница плана поездки (/trip/[token])
 * говорит о местах тура на дату дня. Производитель — share-API
 * (app/api/trips/share/[token]/route.ts), потребитель — страница
 * (app/trip/[token]/_TripShareClient.tsx) и её строка `dayAvailabilityLine`.
 *
 * Четыре исхода (§4.0): места есть; мест нет (тур ведёт расписание) и, если
 * нашлась, ближайшая свободная дата; расписания нет — дату подтвердит оператор;
 * проверить не смогли. До пруфа с прода 06.11 страница знала только первый, а
 * остальные три молча превращались в «от … ₽ · оставить заявку».
 */
import { kamchatkaStamp } from '@/lib/safety/place-day-status';

export type TripDayAvailabilityState = 'open' | 'none' | 'on_request' | 'unread';

export interface TripDayAvailability {
  date: string;
  remaining: number;
  /** Нет поля — старый ответ API: только «места есть». */
  state?: TripDayAvailabilityState;
  /** Только у `none`: ближайшая свободная дата в окне поиска. */
  next?: string;
  /**
   * Когда share-API прочитал места (ISO). Дата, ответ наличия и время
   * проверки — доказательство (совет, пересланный владельцем 07.11,
   * принцип 2): страница называет время у «места есть» и «мест нет».
   */
  checkedAt?: string;
}

/** «12.08» из YYYY-MM-DD. */
export function ddmmOf(iso: string): string {
  const [, m, d] = iso.split('-');
  return d && m ? `${d}.${m}` : iso;
}

function seatsWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'место';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'места';
  return 'мест';
}

export interface DayAvailabilityView {
  tone: 'ok' | 'warn' | 'muted';
  text: string;
  /** Подпись действия у тура дня. */
  cta: string;
  /** Дата, на которую вести заявку (`?date=`), или null — без даты. */
  ctaDate: string | null;
}

/** « · проверено 07.11, 14:05 по Камчатке»; нет времени — пусто (старый ответ API). */
function checkedWords(a: TripDayAvailability): string {
  return a.checkedAt && Number.isFinite(Date.parse(a.checkedAt))
    ? ` · проверено ${kamchatkaStamp(a.checkedAt)} по Камчатке`
    : '';
}

/** Строка мест и подпись действия у тура дня — чистая, под тестом. */
export function dayAvailabilityLine(a: TripDayAvailability): DayAvailabilityView {
  const state = a.state ?? 'open';
  if (state === 'open') {
    return { tone: 'ok', text: `на ${ddmmOf(a.date)} — ${a.remaining} ${seatsWord(a.remaining)}${checkedWords(a)}`, cta: 'оставить заявку', ctaDate: a.date };
  }
  if (state === 'none') {
    return {
      tone: 'warn',
      text: `на ${ddmmOf(a.date)} свободных мест нет${a.next ? `; ближайшая свободная дата — ${ddmmOf(a.next)}` : '; в ближайшие два месяца свободных дат не нашли'}${checkedWords(a)}`,
      cta: a.next ? `заявка на ${ddmmOf(a.next)}` : 'другие даты',
      ctaDate: a.next ?? null,
    };
  }
  if (state === 'on_request') {
    return {
      tone: 'muted',
      text: `расписания в системе нет — дату ${ddmmOf(a.date)} подтвердит оператор по заявке`,
      cta: 'оставить заявку',
      ctaDate: a.date,
    };
  }
  return {
    tone: 'muted',
    text: `места на ${ddmmOf(a.date)} проверить не удалось — уточните на странице тура`,
    cta: 'проверить даты',
    ctaDate: null,
  };
}
