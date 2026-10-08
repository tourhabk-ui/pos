/**
 * Какая модель Open-Meteo лучше предсказывает «сухо / осадки» на побережье
 * Камчатки — замером, а не по памяти (#2249).
 *
 * ПОВОД. 06.10 прогноз `get_weather` сказал «сильный ливень, 19 мм» — была
 * морось; 08.10 — «снегопад, 3,8 мм» — было ясно и сухо. Посты канала
 * @kamchatka_real (№444, №454) правили руками. Прогноз берётся без `models=`,
 * то есть моделью, которую Open-Meteo выбирает сам (`best_match`). Задача
 * просила сравнить модели высокого разрешения и выбрать лучшую.
 *
 * ЧЕМ МЕРИТСЯ. Прогноз на сутки вперёд (`precipitation_previous_day1`
 * Previous Runs API: значение каждого часа из прогона, выпущенного за сутки
 * до него) против фактических суточных осадков метеостанции. Критерий —
 * тот, что записан в задаче как критерий готовности: совпадение «сухо /
 * осадки» по дням. Рядом — ложные «ливни» (прогноз большой суммы на сухой
 * день — ровно случай 06.10) и смещение в миллиметрах.
 *
 * ЗДЕСЬ ТОЛЬКО СЧЁТ. Сеть — в `scripts/weather-model-skill.ts`, который
 * гоняется с раннера: песочница агента до Open-Meteo и NOAA не достаёт.
 *
 * ТРЕТЬЕ СОСТОЯНИЕ (§4.0). Сутки, в которых не хватает часов, в счёт не
 * идут: «данных нет» — не «сухо». Доля без знаменателя — `null`, а не 0 или
 * 1. Модель, сравненная по слишком малому числу дней, в рейтинг не попадает
 * и названа отдельно.
 */

/** Asia/Kamchatka: UTC+12 круглый год (летнего времени нет с 2011). */
export const KAMCHATKA_UTC_OFFSET_H = 12;

/** Меньше стольких сравненных дней — модель не ранжируется: случайность. */
export const MIN_COMPARED_DAYS = 20;

/**
 * Суммы часовых значений по суткам. `times` — часы Open-Meteo в UTC
 * (`timezone=GMT`, вид `2026-10-05T03:00`), сутки считаются в поясе со
 * сдвигом `offsetHours`. В счёт идут только сутки, где есть все 24 часа и ни
 * одного пустого значения.
 */
export function dailySums(
  times: readonly string[],
  values: ReadonlyArray<number | null | undefined>,
  offsetHours: number,
): Map<string, number> {
  const acc = new Map<string, { sum: number; hours: number; gaps: number }>();
  for (let i = 0; i < times.length; i++) {
    const t = Date.parse(`${times[i]}Z`);
    if (!Number.isFinite(t)) continue;
    const day = new Date(t + offsetHours * 3_600_000).toISOString().slice(0, 10);
    const cell = acc.get(day) ?? { sum: 0, hours: 0, gaps: 0 };
    const v = values[i];
    if (typeof v === 'number' && Number.isFinite(v)) {
      cell.sum += v;
      cell.hours++;
    } else {
      cell.gaps++;
    }
    acc.set(day, cell);
  }
  const out = new Map<string, number>();
  for (const [day, c] of acc) {
    if (c.hours === 24 && c.gaps === 0) out.set(day, Math.round(c.sum * 100) / 100);
  }
  return out;
}

export interface SkillScore {
  /** Сколько дней сравнено: есть и факт, и полный прогноз. */
  n: number;
  /** Осадки предсказаны и были. */
  hits: number;
  /** Были, но не предсказаны. */
  misses: number;
  /** Предсказаны, но не было. */
  falseAlarms: number;
  /** Сухо и было сухо. */
  correctDry: number;
  /** Доля верных «сухо / осадки». null — не с чем сравнить. */
  accuracy: number | null;
  /** Доля пойманных дождливых дней. null — дождливых дней не было. */
  pod: number | null;
  /** Доля ложных среди предсказанных осадков. null — осадков не предсказывалось. */
  far: number | null;
  /** Среднее (прогноз − факт), мм/сутки. */
  biasMm: number | null;
  /** Средняя абсолютная ошибка, мм/сутки. */
  maeMm: number | null;
  /** Прогноз ≥ heavyMm при факте < heavyDryMm: «ливень» на почти сухой день. */
  falseHeavy: number;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Сравнить прогноз с фактом по общим дням. Порог `wetMm`: сутки с суммой не
 * меньше порога — «осадки», иначе «сухо», одинаково для факта и прогноза.
 */
export function scoreForecast(
  obs: ReadonlyMap<string, number>,
  fc: ReadonlyMap<string, number>,
  opts: { wetMm: number; heavyMm?: number; heavyDryMm?: number },
): SkillScore {
  const heavyMm = opts.heavyMm ?? 10;
  const heavyDryMm = opts.heavyDryMm ?? 2;
  let n = 0, hits = 0, misses = 0, falseAlarms = 0, correctDry = 0, falseHeavy = 0;
  let errSum = 0, absSum = 0;
  for (const [day, o] of obs) {
    const f = fc.get(day);
    if (f === undefined) continue;
    n++;
    const ow = o >= opts.wetMm;
    const fw = f >= opts.wetMm;
    if (ow && fw) hits++;
    else if (ow) misses++;
    else if (fw) falseAlarms++;
    else correctDry++;
    if (f >= heavyMm && o < heavyDryMm) falseHeavy++;
    errSum += f - o;
    absSum += Math.abs(f - o);
  }
  return {
    n, hits, misses, falseAlarms, correctDry, falseHeavy,
    accuracy: n ? round3((hits + correctDry) / n) : null,
    pod: hits + misses ? round3(hits / (hits + misses)) : null,
    far: hits + falseAlarms ? round3(falseAlarms / (hits + falseAlarms)) : null,
    biasMm: n ? Math.round((errSum / n) * 100) / 100 : null,
    maeMm: n ? Math.round((absSum / n) * 100) / 100 : null,
  };
}

export interface RankedModel {
  model: string;
  score: SkillScore;
}

/**
 * Рейтинг: больше верных «сухо / осадки», при равенстве — меньше ложных
 * «ливней», затем меньше средняя ошибка. Модели с n < MIN_COMPARED_DAYS — в
 * `insufficient`, не в рейтинге: по десятку дней «лучшая» — это удача.
 */
export function rankModels(
  scores: ReadonlyArray<RankedModel>,
  minDays: number = MIN_COMPARED_DAYS,
): { ranked: RankedModel[]; insufficient: RankedModel[] } {
  const ranked = scores.filter((s) => s.score.n >= minDays && s.score.accuracy !== null);
  const insufficient = scores.filter((s) => !(s.score.n >= minDays && s.score.accuracy !== null));
  ranked.sort((a, b) =>
    (b.score.accuracy as number) - (a.score.accuracy as number)
    || a.score.falseHeavy - b.score.falseHeavy
    || (a.score.maeMm ?? Infinity) - (b.score.maeMm ?? Infinity));
  return { ranked, insufficient };
}

/**
 * В какие сутки станция пишет осадки — по местным или по UTC. GHCN-Daily для
 * российских станций собирается из сводок, и граница суток там не записана
 * явно. Ответ даёт сам замер: при верном сдвиге прогноз совпадает с фактом
 * лучше у большинства моделей. Разница меньше `margin` — «не решено», и
 * тогда считается по местным суткам (о них говорит пост) с оговоркой.
 */
export function pickDayConvention(
  local: ReadonlyArray<SkillScore>,
  utc: ReadonlyArray<SkillScore>,
  margin = 0.02,
): 'local' | 'utc' | 'undecided' {
  const mean = (xs: ReadonlyArray<SkillScore>) => {
    const acc = xs.map((s) => s.accuracy).filter((a): a is number => a !== null);
    return acc.length ? acc.reduce((p, c) => p + c, 0) / acc.length : null;
  };
  const l = mean(local);
  const u = mean(utc);
  if (l === null || u === null) return 'undecided';
  if (l - u > margin) return 'local';
  if (u - l > margin) return 'utc';
  return 'undecided';
}
