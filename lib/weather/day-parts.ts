/**
 * lib/weather/day-parts.ts — сутки прогноза по частям: ночь, утро, день, вечер.
 *
 * ── Зачем (#2249, 08.10) ───────────────────────────────────────────────────
 *
 * Суточный `weather_code` Open-Meteo описывает САМОЕ СИЛЬНОЕ явление за
 * сутки. Снег к вечеру подписывал весь день «снегопадом»: 08.10 модель
 * писала «Снегопад, 3.8 мм», а утром в Петропавловске было ясно и сухо;
 * 06.10 — «Сильный ливень, 19 мм» при мороси. Посты в канал дважды
 * правились руками. Сумма за сутки тоже не говорит, КОГДА пойдут осадки, а
 * для выхода на маршрут важно именно это.
 *
 * Отсюда разбивка по почасовому прогнозу: в каждой части — сумма осадков и
 * их тип, а суточную подпись осадков мы больше не показываем.
 *
 * ── Тип осадков — только при уверенном сигнале ─────────────────────────────
 *
 * При +1…+3° у моря дождь и снег решают десятые градуса и высота, которую
 * сетка модели усредняет. Поэтому слово «снег» — только если модель даёт
 * снегопад И температура части не выше +1°; «дождь» — только если снегопада
 * нет вовсе И температура не ниже +2°. Всё прочее — нейтральное «осадки N мм».
 * Ошибиться словом «снег» при дожде — тот же испорченный пост.
 */

export type DayPartLabel = 'ночь' | 'утро' | 'день' | 'вечер';

export interface DayPart {
  label: DayPartLabel;
  /** Сумма осадков за часы части, мм. null — ни одного часа с данными. */
  precipMm: number | null;
  /** Сумма снегопада за часы части, см. null — модель снег не отдала. */
  snowCm: number | null;
  tempMin: number | null;
  tempMax: number | null;
  windKmh: number | null;
}

export interface HourlySeries {
  time?: unknown[];
  temperature_2m?: unknown[];
  precipitation?: unknown[];
  snowfall?: unknown[];
  wind_speed_10m?: unknown[];
}

/** Часы частей по местному времени (Open-Meteo отдаёт их в timezone=Asia/Kamchatka). */
const PARTS: ReadonlyArray<{ label: DayPartLabel; from: number; to: number }> = [
  { label: 'ночь', from: 0, to: 5 },
  { label: 'утро', from: 6, to: 11 },
  { label: 'день', from: 12, to: 17 },
  { label: 'вечер', from: 18, to: 23 },
];

/** Ниже этого за часть — «без осадков»: десятая миллиметра — шум модели, а не морось. */
export const PRECIP_DRY_MM = 0.1;
export const SNOW_MAX_TEMP = 1;
export const RAIN_MIN_TEMP = 2;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Части дня `date` (YYYY-MM-DD) из почасового ряда. Пустой массив — почасовых
 * данных на эту дату нет: вызывающий тогда остаётся при суточной строке.
 */
export function buildDayParts(hourly: HourlySeries | undefined, date: string): DayPart[] {
  if (!hourly || !Array.isArray(hourly.time)) return [];
  const idx: Array<{ i: number; hour: number }> = [];
  hourly.time.forEach((t, i) => {
    if (typeof t !== 'string' || !t.startsWith(`${date}T`)) return;
    const hour = Number(t.slice(11, 13));
    if (Number.isInteger(hour)) idx.push({ i, hour });
  });
  if (idx.length === 0) return [];

  return PARTS.map(({ label, from, to }) => {
    const hours = idx.filter((h) => h.hour >= from && h.hour <= to).map((h) => h.i);
    const pick = (arr: unknown[] | undefined) => hours.map((i) => num(arr?.[i])).filter((v): v is number => v !== null);
    const temps = pick(hourly.temperature_2m);
    const precs = pick(hourly.precipitation);
    const snows = pick(hourly.snowfall);
    const winds = pick(hourly.wind_speed_10m);
    return {
      label,
      precipMm: precs.length ? round1(precs.reduce((a, b) => a + b, 0)) : null,
      snowCm: snows.length ? round1(snows.reduce((a, b) => a + b, 0)) : null,
      tempMin: temps.length ? Math.min(...temps) : null,
      tempMax: temps.length ? Math.max(...temps) : null,
      windKmh: winds.length ? Math.max(...winds) : null,
    };
  });
}

/** Осадки части словами — по правилу из шапки. */
export function precipWords(p: DayPart): string {
  if (p.precipMm === null) return 'осадки — нет данных';
  if (p.precipMm < PRECIP_DRY_MM) return 'без осадков';
  const mm = `${p.precipMm} мм`;
  if (p.snowCm !== null && p.snowCm > 0 && p.tempMax !== null && p.tempMax <= SNOW_MAX_TEMP) return `снег ${mm}`;
  if (p.snowCm === 0 && p.tempMin !== null && p.tempMin >= RAIN_MIN_TEMP) return `дождь ${mm}`;
  return `осадки ${mm}`;
}

/** «утро без осадков · день дождь 3 мм · вечер осадки 1.2 мм» — одна строка на сутки. */
export function dayPartsPhrase(parts: DayPart[]): string {
  return parts.map((p) => `${p.label} ${precipWords(p)}`).join(' · ');
}

/**
 * Показывать ли суточную подпись погоды рядом с частями. Подпись осадков
 * (морось, дождь, снег — коды 51–86) прячется: это «худшее за сутки», и части
 * уже сказали, когда и сколько. Ясно/облачно/туман (0–48) и гроза (95+)
 * остаются: первые не обманывают, грозу из частей не видно, а она опасна.
 */
export function keepDailyDescription(weatherCode: number | null, hasParts: boolean): boolean {
  if (!hasParts || weatherCode === null) return true;
  return weatherCode < 51 || weatherCode >= 95;
}
