/**
 * lib/planner/night-check.ts — ГДЕ НОЧУЕТ ТУРИСТ (аудит дорог 22.11, п. 3).
 *
 * Вопрос владельца 22.11: «не везде есть дороги и ночёвки». До этой правки
 * план ставил ночь в зону дня (`nightZoneOf`), а жильё искал уже после сборки
 * и только по зоне; не нашлось — строка в подборе жилья, план не знал.
 *
 * Правило: ночь вне Авачинской зоны, которую не покрывает тур с проживанием,
 * — только там, где на платформе есть жильё этой зоны. Нет ни одного объекта
 * — план говорит это словами на дни этих ночей. Счёт — живым запросом к БД на
 * каждый план (наличие не кэшируется). Отказ запроса — «не проверено», а не
 * «жилья нет».
 *
 * Авачинская зона здесь не проверяется: база поездки — Петропавловск, и
 * однодневные выезды дальше порога в неё больше не ставятся (road-reach),
 * то есть ночь там — у жилья города и Паратунки, которое подбирается по датам.
 */
import { nightZoneOf, ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import { nightLodgingIncluded } from '@/lib/planner/lodging-included';

export interface NightDay {
  day: number;
  type: string;
  zone: ZoneId;
  title: string;
  dayWarnings: string[];
  realTour?: { tourId: string; lodgingIncluded: boolean | null } | null;
  realPrice?: number;
  priceMissing?: string;
}

/** Сколько объектов жилья зоны на витрине. `null` — не прочиталось. */
export type CountLodging = (zone: ZoneId) => Promise<number | null>;

export interface NightGap {
  zone: ZoneId;
  days: number[];
  /** `none` — объектов нет; `unread` — не проверено. */
  kind: 'none' | 'unread';
}

/** «13.07», «13.07, 14.07». */
function nightDates(arrival: string | null | undefined, days: readonly number[]): string {
  if (!arrival) return days.map((d) => `после дня ${d}`).join(', ');
  return days.map((d) => {
    const iso = dateOfTripDay(arrival, d);
    return iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : `после дня ${d}`;
  }).join(', ');
}

export function nightGapLine(g: NightGap, arrival?: string | null): string {
  const zone = ZONE_NAMES[g.zone] ?? g.zone;
  const when = nightDates(arrival, g.days);
  return g.kind === 'none'
    ? `Ночёвка: ${zone}, ночи ${when} — жилья этой зоны на платформе нет, а тур дня ночлег не включает. Где ночевать, план не знает: спросите оператора о ночлеге или выберите тур с проживанием.`
    : `Ночёвка: ${zone}, ночи ${when} — проверить жильё этой зоны не вышло. Где ночевать, уточните до поездки.`;
}

/**
 * Ночи вне Авачинской зоны без тура с проживанием — и есть ли там жильё.
 * Мутирует `dayWarnings` дней этих ночей; возвращает разрывы для общей строки.
 */
export async function checkNights(days: NightDay[], countLodging: CountLodging, arrival?: string | null): Promise<NightGap[]> {
  const sorted = [...days].sort((a, b) => a.day - b.day);
  const byZone = new Map<ZoneId, number[]>();
  for (const [i, d] of sorted.entries()) {
    if (d.type === 'departure') continue;
    // Тур на N дней покрывает N−1 ночь: ночь после последнего дня — уже не
    // его (то же правило, что у сметы и подбора жилья, Bugbot #3716).
    if (nightLodgingIncluded(d, sorted[i + 1]) === true) continue;
    const zone = nightZoneOf(d, sorted[i + 1]);
    if (zone === 'avachinsky') continue;
    byZone.set(zone, [...(byZone.get(zone) ?? []), d.day]);
  }
  const gaps: NightGap[] = [];
  for (const [zone, nights] of byZone) {
    const n = await countLodging(zone).catch(() => null);
    if (n !== null && n > 0) continue;
    const gap: NightGap = { zone, days: nights, kind: n === null ? 'unread' : 'none' };
    gaps.push(gap);
    const line = nightGapLine(gap, arrival);
    for (const d of sorted) if (nights.includes(d.day)) d.dayWarnings = [...d.dayWarnings, line];
  }
  return gaps;
}

/** SQL: объекты жилья зоны на витрине (тот же отбор, что у подбора жилья). */
export function zoneLodgingCountSql(publicSql: string): string {
  return `SELECT COUNT(*)::int AS n FROM accommodations a WHERE ${publicSql} AND a.planner_zone = $1::varchar`;
}
