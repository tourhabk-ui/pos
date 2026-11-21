/**
 * Покрывает ли сезон тура месяц поездки — по полям `season_start` /
 * `season_end` (тест планировщика владельца 21.11).
 *
 * В план на январь вставал день «Медведи — Курильское озеро», а в ответ на
 * «рыбалка в сентябре» — «Осенняя рыбалка (октябрь–ноябрь)»: туры без
 * календаря открывали своё занятие во ВСЕ месяцы, а список туров месяц не
 * спрашивал. Здесь одно детерминированное правило до модели.
 *
 * Сезон записан датами с годом («2026-10-01»…«2026-11-30»), а поездка может
 * быть в другом году — сезон читается как ежегодный: месяцы от месяца начала
 * до месяца конца (через Новый год — с переходом). Сезон на 12+ месяцев —
 * круглый год. Сезона в данных нет — `null`: судить нечем, решает
 * вызывающий (§4.0: «не знаем» не равно «в сезоне»).
 */
import { seasonDates } from '@/lib/tours/season';

/** Месяцы сезона 1..12 по порядку; `null` — сезона в данных нет. */
export function seasonMonths(start: unknown, end: unknown): number[] | null {
  const s = seasonDates(start, end);
  if (!s) return null;
  const [sy, sm] = s.start.split('-').map(Number);
  const [ey, em] = s.end.split('-').map(Number);
  const span = (ey - sy) * 12 + (em - sm);
  if (span >= 11) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const out: number[] = [];
  for (let k = 0; k <= span; k++) out.push(((sm - 1 + k) % 12) + 1);
  return out;
}

/** true/false — по сезону тура; `null` — сезона нет. */
export function seasonCoversMonth(start: unknown, end: unknown, month: number): boolean | null {
  const months = seasonMonths(start, end);
  return months === null ? null : months.includes(month);
}

const MONTH_STEMS: ReadonlyArray<[RegExp, number]> = [
  [/январ/, 1], [/феврал/, 2], [/(?<![а-яё])март/, 3], [/апрел/, 4], [/(?<![а-яё])ма[йяею](?![а-яё])/, 5],
  [/(?<![а-яё])июн/, 6], [/(?<![а-яё])июл/, 7], [/август/, 8], [/сентябр/, 9], [/октябр/, 10],
  [/ноябр/, 11], [/декабр/, 12],
];

/** Месяцы, названные в тексте человека («в январе», «сентябрь»). Пусто — не назван. */
export function monthsNamedIn(text: string | null | undefined): number[] {
  const t = (text ?? '').toLowerCase().replace(/ё/g, 'е');
  return MONTH_STEMS.filter(([re]) => re.test(t)).map(([, m]) => m);
}
