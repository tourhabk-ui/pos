/**
 * Сводка перевозчика — чистая часть (#2862 этап D): форма чисел и текст для
 * чата и сайта. Базу читает carrier-summary-store.
 *
 * Числа за 30 дней по Камчатке: заявки на машину (всего / отвечено / без
 * ответа), медиана первого ответа, поездки «состоялась» / «не состоялась» по
 * слову перевозчика, отзывы (видимые) и средняя по ним.
 *
 * §4.0: у каждого блока свой исход «не прочитался» (null блок), а внутри —
 * «нет данных» (null число) отличается от нуля: медиана без ответов — «ответов
 * не было», средняя без отзывов — «отзывов нет», не 0. Имён и телефонов здесь
 * нет — текст уходит в мессенджер.
 */

import { escapeHtml } from '@/lib/text/escape-html';

export const SUMMARY_WINDOW_DAYS = 30;

export interface CharterRequestsSummary {
  total: number;
  answered: number;
  /** Ждут ответа сейчас (как «Входящие»): без ответа, дата выезда не прошла. */
  waiting: number;
  /** Медиана минут от заявки до первого ответа; null — ответов не было. */
  medianMinutes: number | null;
}

export interface RidesSummary {
  held: number;
  notHeld: number;
  /** Вопрос «Поездка состоялась?» ждёт ответа сейчас. */
  awaiting: number;
}

export interface ReviewsSummary {
  visible: number;
  /** Средняя по видимым, один знак; null — отзывов нет. */
  average: number | null;
}

/** null у блока — не прочитался: это не «ноль». */
export interface CarrierSummary {
  windowDays: number;
  requests: CharterRequestsSummary | null;
  rides: RidesSummary | null;
  reviews: ReviewsSummary | null;
}

/** Медиана: нечётное — середина, чётное — среднее двух средних; пусто — null. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function durationWords(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  return `${Math.floor(h / 24)} дн`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const SUMMARY_NOT_READ = 'не прочиталось';

/** Строки сводки без HTML — для сайта; чат оборачивает заголовок сам. */
export function carrierSummaryLines(s: CarrierSummary): string[] {
  const lines: string[] = [];
  if (s.requests === null) {
    lines.push(`Заявки на машину за ${s.windowDays} дней: ${SUMMARY_NOT_READ}.`);
  } else {
    const r = s.requests;
    lines.push(`Заявки на машину за ${s.windowDays} дней: ${r.total} · отвечено ${r.answered} · ждут ответа сейчас ${r.waiting}.`);
    lines.push(r.medianMinutes === null
      ? 'Время первого ответа: ответов за этот срок не было.'
      : `Время первого ответа (медиана): ${durationWords(r.medianMinutes)}.`);
  }
  if (s.rides === null) {
    lines.push(`Поездки за ${s.windowDays} дней: ${SUMMARY_NOT_READ}.`);
  } else {
    const r = s.rides;
    lines.push(`Поездки по вашему слову: состоялись ${r.held} · не состоялись ${r.notHeld}${r.awaiting > 0 ? ` · ждут ответа «Поездка состоялась?» ${r.awaiting}` : ''}.`);
  }
  if (s.reviews === null) {
    lines.push(`Отзывы: ${SUMMARY_NOT_READ}.`);
  } else if (s.reviews.visible === 0) {
    lines.push('Отзывы: пока нет — средней нет.');
  } else {
    const n = s.reviews.visible;
    lines.push(`Отзывы: ${n} ${plural(n, 'видимый', 'видимых', 'видимых')} · средняя ${s.reviews.average === null ? 'не посчитана' : s.reviews.average.toFixed(1)} из 5.`);
  }
  return lines;
}

/** Текст для чата (HTML MAX/Telegram): ПД нет по построению — числа и слова. */
export function carrierSummaryText(s: CarrierSummary): string {
  return ['<b>Сводка перевозчика</b>', ...carrierSummaryLines(s).map((l) => escapeHtml(l)), 'Время — Камчатка.'].join('\n');
}
