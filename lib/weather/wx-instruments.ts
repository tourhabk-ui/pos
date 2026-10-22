/**
 * Геометрия приборов страницы погоды (слово владельца 22.10: «сделай в стиле
 * самсунг погода»): линия температуры по часам, положение солнца на дуге
 * дня, стрелка ветра, отметка на шкале УФ, заполнение кольца.
 *
 * Чистые функции, без запроса и без React: страница рисует SVG на сервере,
 * без скриптов, а правила здесь проверяются вызовом. Пропуск данных остаётся
 * пропуском — линия рвётся на часе без температуры, солнца нет ночью и там,
 * где источник не назвал восход или закат, — а не превращается в ноль.
 */

export interface CurvePoint {
  x: number;
  y: number;
  temp: number;
}

export interface TempCurve {
  /** Точка на каждый час; null — температуры у часа нет. */
  points: Array<CurvePoint | null>;
  /** SVG-путь: плавные отрезки между соседними точками, разрыв на пропуске. */
  path: string;
  min: number | null;
  max: number | null;
}

/**
 * Линия температуры: x — центр колонки часа, y — от верха (теплее — выше).
 * `padTop` оставляет место подписи над точкой, `padBottom` — под линией.
 * Ровная температура весь день — линия посередине, а не делением на ноль.
 */
export function tempCurve(
  temps: Array<number | null>,
  opts: { col: number; height: number; padTop: number; padBottom: number },
): TempCurve {
  const known = temps.filter((t): t is number => t !== null && Number.isFinite(t));
  if (known.length === 0) return { points: temps.map(() => null), path: '', min: null, max: null };
  const min = Math.min(...known);
  const max = Math.max(...known);
  const span = max - min;
  const inner = opts.height - opts.padTop - opts.padBottom;
  const yOf = (t: number) => (span > 0 ? opts.padTop + ((max - t) / span) * inner : opts.padTop + inner / 2);
  const points = temps.map((t, i) => (t === null || !Number.isFinite(t)
    ? null
    : { x: i * opts.col + opts.col / 2, y: round2(yOf(t)), temp: t }));

  let path = '';
  let prev: CurvePoint | null = null;
  for (const p of points) {
    if (!p) { prev = null; continue; }
    if (!prev) path += `${path ? ' ' : ''}M${p.x} ${p.y}`;
    else {
      const mid = round2((prev.x + p.x) / 2);
      path += ` C${mid} ${prev.y} ${mid} ${p.y} ${p.x} ${p.y}`;
    }
    prev = p;
  }
  return { points, path, min, max };
}

/** «07:59» → 479 минут; не время — null. */
export function minutesOf(hm: string | null | undefined): number | null {
  if (!hm) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Доля прошедшего светового дня, 0…1. Ночь, пропуск восхода, заката или
 * текущего времени — null: солнца на дуге нет, а не «на горизонте».
 */
export function daylightFraction(
  sunrise: string | null | undefined, sunset: string | null | undefined, now: string | null | undefined,
): number | null {
  const rise = minutesOf(sunrise);
  const set = minutesOf(sunset);
  const cur = minutesOf(now);
  if (rise === null || set === null || cur === null || set <= rise) return null;
  if (cur < rise || cur > set) return null;
  return (cur - rise) / (set - rise);
}

/** Точка на дуге дня (квадратичная кривая Безье от восхода к закату). */
export function arcPoint(
  t: number,
  from: { x: number; y: number }, peak: { x: number; y: number }, to: { x: number; y: number },
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: round2(u * u * from.x + 2 * u * t * peak.x + t * t * to.x),
    y: round2(u * u * from.y + 2 * u * t * peak.y + t * t * to.y),
  };
}

/**
 * Поворот стрелки ветра, градусы по часовой от севера. Источник называет,
 * ОТКУДА дует (метеорологическое направление); стрелка показывает, КУДА —
 * «летит по ветру», как в погодных приложениях. Нет направления — null.
 */
export function windArrowRotation(fromDeg: number | null | undefined): number | null {
  if (fromDeg === null || fromDeg === undefined || !Number.isFinite(fromDeg)) return null;
  return (((fromDeg + 180) % 360) + 360) % 360;
}

/** Отметка на шкале УФ 0…11+, проценты; выше 11 — край шкалы. */
export function uvMarkerPercent(uv: number | null | undefined): number | null {
  if (uv === null || uv === undefined || !Number.isFinite(uv)) return null;
  return round2(Math.max(0, Math.min(11, uv)) / 11 * 100);
}

/** Заполнение кольца: длина дуги для stroke-dasharray по доле 0…100. */
export function ringDash(percent: number, radius: number): { filled: number; circumference: number } {
  const circumference = round2(2 * Math.PI * radius);
  const p = Math.max(0, Math.min(100, percent));
  return { filled: round2((circumference * p) / 100), circumference };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
