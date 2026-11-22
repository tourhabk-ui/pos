/**
 * lib/planner/weather-plan-b.ts — «План Б» для дней, которые решает погода
 * (супер-планер, 22.11): вертолёт, море, восхождение на вулкан.
 *
 * Что делает:
 *  - узнаёт такой день по виду занятия (и по названию тура для облёта и моря:
 *    операторы пишут вид по-разному);
 *  - показывает прогноз дня фактами, без вердикта «полетите / не полетите»:
 *    решение о выезде принимает оператор в день выезда;
 *  - предлагает обмен с другим днём той же зоны в пределах прогноза и говорит,
 *    лучше ли там погода по прогнозу — и чем; дня без прогноза в обмене нет;
 *  - меняет дни местами так, что прогноз остаётся у своей даты.
 *
 * Пределы ветра и осадков из `operator_tours` (max_wind_kmh,
 * max_precipitation_mm) сюда сознательно не взяты: у столбцов есть DEFAULT в
 * схеме, и «предел оператора» нельзя отличить от значения по умолчанию (§4.0).
 *
 * Чистый модуль: его читают экран и тесты.
 */
import { renumberByPosition, type CalendarDayLike, type NewNumbers } from './calendar-days';
import { MOVABLE_TYPES, orderProblem, tourGroup } from './plan-ops';
import { normalizeActivity } from './constants';
import { weatherKitLine } from './weather-kit';

export type WeatherKind = 'air' | 'sea' | 'volcano';

/** Слова оператора (`operator_tours.activity_type`), которые решает погода. */
export const WEATHER_SENSITIVE_TYPES: readonly string[] = ['helicopter', 'geyser', 'volcano', 'boat_trip', 'sea'];

export const WEATHER_KIND_LABEL: Record<WeatherKind, string> = {
  air: 'вертолёт',
  sea: 'выход в море',
  volcano: 'восхождение',
};

export const WEATHER_KIND_SHORT: Record<WeatherKind, string> = {
  air: 'вертолёт не летает в туман, низкую облачность и сильный ветер',
  sea: 'выход в море отменяют при волне и ветре',
  volcano: 'на склоне всё решают видимость и ветер',
};

const AIR_TITLE = /вертол|облёт|облет/i;
const SEA_TITLE = /морск|катер|яхт|бухт|в море/i;
const CLIMB_TITLE = /восхожден/i;

/** Какую погоду решает занятие; null — от лётной и морской погоды не зависит. */
export function weatherKindOfActivity(activityType: string | null | undefined, title?: string | null): WeatherKind | null {
  const t = normalizeActivity(activityType ?? '');
  const name = title ?? '';
  if (t === 'helicopter' || t === 'geyser' || AIR_TITLE.test(name)) return 'air';
  if (t === 'boat_trip' || t === 'sea' || SEA_TITLE.test(name)) return 'sea';
  if (t === 'volcano' || CLIMB_TITLE.test(name)) return 'volcano';
  return null;
}

export interface ForecastLike {
  tempMin: number;
  tempMax: number;
  precipMm: number;
  windKmh: number;
  code: number;
  description: string;
}

export interface PlanBDay {
  day: number;
  type: string;
  zone: string;
  title: string;
  activityType: string;
  realTour?: { tourId: string } | null;
  weatherForecast?: ForecastLike;
  weatherKit?: string;
}

/** День, который решает погода; null — не такой день. */
export function weatherDayKind(d: Pick<PlanBDay, 'type' | 'activityType' | 'title'>): WeatherKind | null {
  if (d.type !== 'activity') return null;
  return weatherKindOfActivity(d.activityType, d.title);
}

/**
 * Насколько тяжёл код погоды WMO для выезда: 0 — ясно/облачно, 1 — слабые
 * осадки, 2 — умеренные, 3 — туман или сильные осадки, 4 — гроза.
 * Незнакомый код — как слабые осадки: хуже ясного, не лучше.
 */
export function codeRank(code: number): number {
  if (code >= 0 && code <= 3) return 0;
  if ([95, 96, 99].includes(code)) return 4;
  if ([45, 48, 65, 67, 75, 82, 86].includes(code)) return 3;
  if ([57, 63, 66, 73, 81].includes(code)) return 2;
  return 1;
}

const ms = (kmh: number) => Math.round(kmh / 3.6);
const mm = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

function usable(f: ForecastLike | undefined): f is ForecastLike {
  return !!f && [f.precipMm, f.windKmh, f.code].every((v) => typeof v === 'number' && Number.isFinite(v));
}

/** Прогноз дня фактами: «снегопад, осадки 5,8 мм, ветер до 4 м/с». */
export function forecastFacts(f: ForecastLike): string {
  const parts = [
    f.description?.trim().toLowerCase() || null,
    f.precipMm > 0 ? `осадки ${mm(f.precipMm)} мм` : 'без осадков',
    `ветер до ${ms(f.windKmh)} м/с`,
  ].filter(Boolean);
  return parts.join(', ');
}

export type Comparison = 'better' | 'worse' | 'mixed' | 'same';

/**
 * Лучше ли погода дня `b` для выезда, чем дня `a`. «Лучше» — не хуже по коду
 * погоды, осадкам и ветру и лучше хотя бы по одному (осадки — на 1 мм и
 * больше, ветер — на 2 м/с и больше). Иначе — хуже, вперемешку или так же.
 */
export function compareForecast(a: ForecastLike, b: ForecastLike): Comparison {
  const d = [
    Math.sign(codeRank(a.code) - codeRank(b.code)),
    Math.abs(a.precipMm - b.precipMm) >= 1 ? Math.sign(a.precipMm - b.precipMm) : 0,
    Math.abs(ms(a.windKmh) - ms(b.windKmh)) >= 2 ? Math.sign(ms(a.windKmh) - ms(b.windKmh)) : 0,
  ];
  const up = d.some((x) => x > 0);
  const down = d.some((x) => x < 0);
  if (up && !down) return 'better';
  if (down && !up) return 'worse';
  if (up && down) return 'mixed';
  return 'same';
}

export interface SwapOption {
  /** Номер дня, с которым меняемся. */
  day: number;
  title: string;
  type: string;
  comparison: Comparison;
  /** Прогноз дня-напарника фактами. */
  facts: string;
  /** Чего обмен лишит: «после облёта не останется резервного дня». */
  note: string | null;
}

/** Почему обмена нет: дня нет в прогнозе, день держит каркас, день тура на несколько дней. */
export interface SwapPlan {
  options: SwapOption[];
  /** Причина, по которой обмен не предлагается; null — предлагается. */
  refusal: string | null;
}

/** С кем день погоды может поменяться местами в пределах прогноза. */
export function swapPlan<T extends PlanBDay>(days: readonly T[], dayNum: number, limit = 2): SwapPlan {
  const me = days.find((d) => d.day === dayNum);
  if (!me) return { options: [], refusal: 'Дня нет в плане' };
  if (!usable(me.weatherForecast)) {
    return { options: [], refusal: 'Прогноза на эту дату ещё нет — менять дни по погоде можно, когда дата войдёт в прогноз' };
  }
  if (tourGroup(days, me).length > 1) return { options: [], refusal: 'Тур на несколько дней — двигается целиком' };
  const mine = me.weatherForecast;
  const candidates = days.filter((d) => d.day !== dayNum
    && MOVABLE_TYPES.has(d.type)
    && d.zone === me.zone
    && usable(d.weatherForecast)
    && tourGroup(days, d).length === 1
    && weatherDayKind(d) === null
    && orderProblem(swappedOrder(days, dayNum, d.day)) === null);
  const rankOf = (c: Comparison) => ({ better: 0, mixed: 1, same: 2, worse: 3 }[c]);
  const options = candidates.map((d) => {
    const comparison = compareForecast(mine, d.weatherForecast!);
    return {
      day: d.day, title: d.title, type: d.type, comparison,
      facts: forecastFacts(d.weatherForecast!),
      note: reserveNote(days, me, d),
    };
  }).sort((x, y) => (x.type === 'buffer' ? -1 : 0) - (y.type === 'buffer' ? -1 : 0)
    || rankOf(x.comparison) - rankOf(y.comparison)
    || Math.abs(x.day - dayNum) - Math.abs(y.day - dayNum));
  if (options.length === 0) {
    return { options: [], refusal: 'В пределах прогноза в той же зоне нет дня, с которым можно поменяться' };
  }
  return { options: options.slice(0, limit), refusal: null };
}

/** После обмена у дня погоды не остаётся резервного дня позже него. */
function reserveNote(days: readonly PlanBDay[], me: PlanBDay, other: PlanBDay): string | null {
  // До обмена: есть ли резервный день позже выезда.
  if (!days.some((d) => d.type === 'buffer' && d.day > me.day)) return null;
  // После обмена выезд стоит на месте напарника, напарник — на месте выезда.
  const keeps = days.some((d) => d.type === 'buffer' && d !== other && d.day > other.day)
    || (other.type === 'buffer' && me.day > other.day);
  return keeps ? null : 'После обмена резервного дня позже этого выезда не останется — если отменят, перенести будет некуда.';
}

function swappedOrder<T extends { day: number }>(days: readonly T[], a: number, b: number): T[] {
  const ia = days.findIndex((d) => d.day === a);
  const ib = days.findIndex((d) => d.day === b);
  const out = [...days];
  if (ia < 0 || ib < 0) return out;
  [out[ia], out[ib]] = [out[ib], out[ia]];
  return out;
}

/**
 * Дни `a` и `b` меняются местами. Номера и даты встают по местам
 * (renumberByPosition): места и цена тура, сменившего дату, — «ещё не
 * перечитали». Прогноз принадлежит дате и зоне, а не занятию: дни одной зоны
 * получают прогноз своей новой даты, строка «что взять» — заново.
 */
export function swapDays<T extends PlanBDay & CalendarDayLike>(
  days: readonly T[], a: number, b: number,
): { days: T[]; newNumbers: NewNumbers } {
  const byNum = new Map(days.map((d) => [d.day, d]));
  const { days: out, newNumbers } = renumberByPosition(swappedOrder(days, a, b));
  const fixed = out.map((d) => {
    const was = byNum.get(d.day);
    if (!was || was === d || was.zone !== d.zone || !usable(was.weatherForecast)) return d;
    const fc = was.weatherForecast;
    const next = { ...d, weatherForecast: fc } as T;
    const kit = weatherKitLine(fc, d.type === 'activity' ? d.activityType : null);
    if (kit) next.weatherKit = kit; else delete next.weatherKit;
    return next;
  });
  return { days: fixed, newNumbers };
}
