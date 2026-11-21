/**
 * Живые числа в тексте посадочных (Сыщик 21.11, хабы): сколько туров в
 * каталоге, сколько видов, сколько туров идёт в месяце, сезон конкретного тура.
 * В markdown стоит метка, число подставляется из базы на запросе — текст не
 * стареет вместе с каталогом. Метки:
 *   {{tours_total|тур}}         — «81 тур»
 *   {{tour_kinds|вид}}          — «13 видов»
 *   {{tours_month:8|тур}}       — сколько туров идёт в августе
 *   {{tour_season:<slug>}}      — «1 июля — 30 сентября» из карточки тура
 *   {{top_kinds:5}}             — пять самых частых видов, через запятую
 *   {{tours_kind:volcano}}      — сколько туров этого вида (activity_type)
 * Слово после «|» — форма для одного («тур»); склонение — pluralRu.
 * База не ответила — вместо числа «—», а не выдуманное значение.
 */
import { ACTIVITY_LABELS } from '@/lib/tours/labels';
import { tourRunsInMonth } from '@/lib/landings/tours';

export interface LiveTourRow {
  slug: string | null;
  activity_type?: string | null;
  season_start?: string | null;
  season_end?: string | null;
  next_open_date?: string | null;
}

const FORMS: Record<string, [string, string, string]> = {
  тур: ['тур', 'тура', 'туров'],
  вид: ['вид', 'вида', 'видов'],
  программа: ['программа', 'программы', 'программ'],
};

export function pluralRu(n: number, one: string): string {
  const f = FORMS[one] ?? [one, one, one];
  const a = Math.abs(n) % 100; const b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b === 1) return f[0];
  if (b >= 2 && b <= 4) return f[1];
  return f[2];
}

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function dayMonth(v: string | null | undefined): string | null {
  const m = v ? /^\d{4}-(\d{2})-(\d{2})/.exec(v) : null;
  if (!m) return null;
  return `${Number(m[2])} ${MONTHS_GEN[Number(m[1]) - 1]}`;
}

export function seasonLabel(t: Pick<LiveTourRow, 'season_start' | 'season_end'> | undefined): string {
  const a = dayMonth(t?.season_start); const b = dayMonth(t?.season_end);
  return a && b ? `${a} — ${b}` : 'сезон в карточке не указан';
}

/**
 * Подставить живые числа; rows === null — база не ответила. `total` — число
 * туров, которое страница уже показывает (у /catalog — из своего запроса),
 * чтобы текст и список не разошлись.
 */
export function fillLiveText(text: string, rows: readonly LiveTourRow[] | null, opts: { total?: number | null } = {}): string {
  if (!text.includes('{{')) return text;
  const count = (n: number | null, word?: string) =>
    n === null ? '—' : word ? `${n} ${pluralRu(n, word)}` : String(n);
  const kinds = rows ? new Map<string, number>() : null;
  if (rows && kinds) for (const r of rows) if (r.activity_type) kinds.set(r.activity_type, (kinds.get(r.activity_type) ?? 0) + 1);
  return text.replace(/\{\{([a-z_]+)(?::([^|}]+))?(?:\|([^}]+))?\}\}/g, (all, key: string, arg?: string, word?: string) => {
    switch (key) {
      case 'tours_total': return count(opts.total ?? (rows ? rows.length : null), word);
      case 'tour_kinds': return count(kinds ? kinds.size : null, word);
      case 'tours_month': {
        const m = Number(arg);
        if (!(m >= 1 && m <= 12)) return all;
        return count(rows ? rows.filter((r) => tourRunsInMonth({ season_start: r.season_start ?? null, season_end: r.season_end ?? null, next_open_date: r.next_open_date ?? null }, m)).length : null, word);
      }
      case 'tours_kind': return count(kinds ? kinds.get(arg ?? '') ?? 0 : null, word);
      case 'tour_season': {
        if (!rows) return '—';
        const t = rows.find((r) => r.slug === arg);
        return t ? seasonLabel(t) : 'тур сейчас не опубликован';
      }
      case 'top_kinds': {
        if (!kinds) return '—';
        const n = Number(arg) || 5;
        return [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
          .map(([k]) => (ACTIVITY_LABELS[k] ?? k).toLowerCase()).join(', ');
      }
      default: return all;
    }
  });
}

/** Посадочная с подставленными числами (до и после блока туров). */
export function landingWithLiveText<T extends { before: string; after: string }>(l: T, rows: readonly LiveTourRow[] | null, opts: { total?: number | null } = {}): T {
  if (!l.before.includes('{{') && !l.after.includes('{{')) return l;
  return { ...l, before: fillLiveText(l.before, rows, opts), after: fillLiveText(l.after, rows, opts) };
}

export function hasLiveMarks(l: { before: string; after: string }): boolean {
  return l.before.includes('{{') || l.after.includes('{{');
}
