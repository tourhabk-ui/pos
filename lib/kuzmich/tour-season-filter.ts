/**
 * Список туров get_tours — без туров вне сезона месяца, названного человеком
 * (тест планировщика владельца 21.11).
 *
 * Было: «рыбалка на кижуча, 4 дня, сентябрь» — в ответе «Осенняя рыбалка
 * (октябрь–ноябрь)»: каталог отдавался модели целиком, и сезон она сверяла
 * сама (или не сверяла). Теперь до модели: строка тура, чей сезон записан
 * (season_start/season_end) и не задевает названный месяц, из вывода
 * убирается. Сезон не записан — тур остаётся: судить нечем (§4.0).
 *
 * Ничего не осталось — так и сказано: «в январе такого тура нет, ближайший
 * по сезону — …» (идея с zimaletokamchatka.ru, свой код).
 */
import { seasonMonths } from '@/lib/tours/season-month';
import { MONTH_IN } from '@/lib/planner/trip-season';

export interface SeasonFields {
  seasonStart: string | null;
  seasonEnd: string | null;
}

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function monthsWords(months: readonly number[]): string {
  const w = months.map((m) => MONTH_IN[m - 1]);
  return w.length <= 1 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} и ${w[w.length - 1]}`;
}

function seasonWords(ms: readonly number[]): string {
  return ms.length === 12 ? 'круглый год' : `${MONTH_SHORT[ms[0] - 1]}–${MONTH_SHORT[ms[ms.length - 1] - 1]}`;
}

/** Сколько месяцев до ближайшего месяца сезона от любого из `months`. */
function distance(season: readonly number[], months: readonly number[]): number {
  let best = 12;
  for (const m of months) for (const s of season) best = Math.min(best, (s - m + 12) % 12);
  return best;
}

export function filterToursByMonth(
  text: string,
  entries: ReadonlyMap<string, SeasonFields>,
  months: readonly number[],
): { text: string; hidden: string[] } {
  if (months.length === 0) return { text, hidden: [] };
  const hidden: Array<{ title: string; season: number[] }> = [];
  let kept = 0;
  const lines = text.split('\n').filter((line) => {
    const id = /^ID(\d+):/.exec(line)?.[1];
    if (!id) return true;
    const e = entries.get(id);
    const season = e ? seasonMonths(e.seasonStart, e.seasonEnd) : null;
    if (season === null || months.some((m) => season.includes(m))) { kept++; return true; }
    hidden.push({ title: /^ID\d+: "([^"]+)"/.exec(line)?.[1] ?? `ID${id}`, season });
    return false;
  });
  if (hidden.length === 0) return { text, hidden: [] };
  const when = monthsWords(months);
  const notes: string[] = [];
  notes.push(`Вне сезона в ${when} скрыто туров: ${hidden.length} (сезон тура в базе не задевает ${when}; не предлагай их на эти даты).`);
  if (kept === 0) {
    const nearest = [...hidden].sort((a, b) => distance(a.season, months) - distance(b.season, months))[0];
    notes.push(`В ${when} такого тура нет. Ближайший по сезону — «${nearest.title}» (сезон: ${seasonWords(nearest.season)}). Скажи это человеку прямо.`);
  }
  return { text: [...lines, '', ...notes].join('\n'), hidden: hidden.map((h) => h.title) };
}
