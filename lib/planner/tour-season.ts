/**
 * Тур на карточке дня — только если его сезон не спорит с месяцем поездки.
 *
 * Повод 24.10: на июль план подставил «Зимнюю рыбалку: январь». Тип
 * активности fishing в июле открыт, а название тура называет другой месяц.
 * Пол сезона активности это не ловит: он про вид занятия, не про этот тур.
 *
 * Сезон в колонках, если обе даты записаны, — второе свидетельство.
 * Пустые даты сезона не выдумывают окно: тур без сезона и без месяца в
 * названии остаётся (сезон не записан — не то же самое, что «не сезон»).
 */

const MONTH_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/(?<![а-яё])январ/, 1],
  [/(?<![а-яё])феврал/, 2],
  [/(?<![а-яё])марта|(?<![а-яё])март(?![а-яё])/, 3],
  [/(?<![а-яё])апрел/, 4],
  [/(?<![а-яё])ма[йея](?![а-яё])/, 5],
  [/(?<![а-яё])июн/, 6],
  [/(?<![а-яё])июл/, 7],
  [/(?<![а-яё])август/, 8],
  [/(?<![а-яё])сентябр/, 9],
  [/(?<![а-яё])октябр/, 10],
  [/(?<![а-яё])ноябр/, 11],
  [/(?<![а-яё])декабр/, 12],
];

function namedMonths(title: string): number[] {
  const t = title.toLowerCase().replace(/ё/g, 'е');
  const found: number[] = [];
  for (const [rx, month] of MONTH_WORDS) {
    if (rx.test(t) && !found.includes(month)) found.push(month);
  }
  return found;
}

function monthOf(value: string): number | null {
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (full) {
    const month = Number(full[2]);
    return month >= 1 && month <= 12 ? month : null;
  }
  return null;
}

function monthInside(month: number, start: number, end: number): boolean {
  if (start <= end) return month >= start && month <= end;
  return month >= start || month <= end;
}

export function tourFitsTripMonth(input: {
  title: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  /** Месяц поездки, 1–12. */
  month: number;
}): boolean {
  if (input.month < 1 || input.month > 12) return false;
  const title = input.title.toLowerCase().replace(/ё/g, 'е');
  const named = namedMonths(input.title);
  if (named.length > 0 && !named.includes(input.month)) return false;
  if (/(?<![а-яё])зимн/.test(title) && input.month >= 5 && input.month <= 10) return false;
  if (/(?<![а-яё])летн/.test(title) && (input.month <= 4 || input.month >= 11)) return false;
  const start = input.seasonStart ? monthOf(input.seasonStart) : null;
  const end = input.seasonEnd ? monthOf(input.seasonEnd) : null;
  if (start != null && end != null && !monthInside(input.month, start, end)) return false;
  return true;
}
