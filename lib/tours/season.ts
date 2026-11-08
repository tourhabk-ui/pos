/**
 * Сезон тура — одно правило для карточки и разметки поисковиков.
 *
 * Колонки `operator_tours.season_start` / `season_end` — DATE: настоящие дни
 * с годом («2027-07-19»). До 08.11 оба читателя выбрасывали из них всё, кроме
 * месяца:
 *  - разметка (lib/seo/tour-structured-data) подставляла ТЕКУЩИЙ год и дни 1 и
 *    28 — у тура с сезоном 19.07–29.09.2027 поисковик в ноябре 2026 видел
 *    «продаётся 01.07–28.09.2026», то есть закончившееся предложение, а у
 *    зимней рыбалки 15.11.2026–15.01.2027 — конец раньше начала;
 *  - карточка писала «Июл — Сен» без года, и тур с прошедшим сезоном 2026
 *    выглядел так же, как тур с сезоном 2027.
 *
 * Здесь даты берутся как есть. Чего в данных нет, того нет и здесь (§4.0):
 * номер месяца без года, битая дата, конец раньше начала — сезона нет.
 */

export interface SeasonDates {
  /** YYYY-MM-DD */
  start: string;
  /** YYYY-MM-DD */
  end: string;
}

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/**
 * День из значения базы. node-postgres отдаёт DATE объектом `Date` на
 * ЛОКАЛЬНУЮ полночь, поэтому день читается локальными полями, а не UTC: на
 * сервере с поясом восточнее UTC `toISOString()` дал бы вчерашний день.
 */
function isoDay(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Даты сезона из базы; null — сезона нет или он записан не датами. */
export function seasonDates(start: unknown, end: unknown): SeasonDates | null {
  const s = isoDay(start);
  const e = isoDay(end);
  if (!s || !e || e < s) return null;
  return { start: s, end: e };
}

/** Сезон ещё не кончился к `today` (YYYY-MM-DD, день Камчатки). */
export function seasonAhead(season: SeasonDates, today: string): boolean {
  return season.end >= today;
}

function dayMonth(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}

/**
 * Подпись сезона: «19 июл — 29 сен 2027», через год — «15 ноя 2026 — 15 янв
 * 2027». Год стоит всегда: без него прошедший сезон читался как будущий.
 */
export function seasonLabel(start: unknown, end: unknown): string | null {
  const season = seasonDates(start, end);
  if (!season) return null;
  const sy = season.start.slice(0, 4);
  const ey = season.end.slice(0, 4);
  return sy === ey
    ? `${dayMonth(season.start)} — ${dayMonth(season.end)} ${ey}`
    : `${dayMonth(season.start)} ${sy} — ${dayMonth(season.end)} ${ey}`;
}
