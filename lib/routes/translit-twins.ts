/**
 * lib/routes/translit-twins.ts — сличение латинских транслит-заголовков
 * с кириллическими тёзками.
 *
 * Контрольный аудит 20.08 (проба 100) показал на витрине латинские записи
 * без данных рядом с нормальными кириллическими: «bukhta pionerskaya» при
 * живой «Бухте Пионерской», «vodopad babiy kamen» при «Бабьем камне».
 * Это след скрейпа: тот же объект, имя прогнано транслитом. Семья имён
 * (family-merge) их не видит — множества слов в разных алфавитах не
 * совпадают. Здесь кириллица приводится к транслиту и сравнивается
 * по тем же правилам: множество слов, порядок не важен.
 *
 * Схема транслита выведена из самих данных («bukhta» — х→kh,
 * «snezhnyy» — ж→zh и ый→yy, «ruche» — ь опускается), не из ГОСТа:
 * сличать надо с тем, как писал скрейпер, а не как положено.
 *
 * Только перепись: решение о слиянии — за человеком.
 */

import { normalizeTitle } from '@/lib/import/kml-inbox';

const RU_TO_LAT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya',
};

/** Кириллица → транслит скрейпера; прочие символы как есть. */
export function translitRuToLat(s: string): string {
  let out = '';
  for (const ch of s.toLowerCase()) {
    out += RU_TO_LAT[ch] ?? ch;
  }
  return out;
}

/** Заголовок целиком латинский (есть латиница, нет ни одной кириллической буквы). */
export function isLatinOnlyTitle(title: string): boolean {
  const n = normalizeTitle(title);
  return /[a-z]/.test(n) && !/[а-яё]/.test(n);
}

/** Значимые слова, отсортированные — как nameTokens семьи, но по транслиту. */
function tokens(s: string): string[] {
  return s
    .split(/[\s-]+/)
    .map(t => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(t => t.length > 0)
    .sort();
}

export function latinTokens(latinTitle: string): string[] {
  return tokens(normalizeTitle(latinTitle));
}

export function translitTokens(cyrTitle: string): string[] {
  return tokens(translitRuToLat(normalizeTitle(cyrTitle)));
}

export type TwinMatchKind = 'exact' | 'latin_superset' | 'cyr_superset';

/**
 * Родство латинского и кириллического заголовков:
 *   exact          — множества слов равны: тот же объект, то же имя;
 *   latin_superset — латинское имя полнее («vodopad snezhnyy bars na ruche
 *                    spokoynyy» ⊃ «Водопад на ручье Спокойный»);
 *   cyr_superset   — кириллическое полнее;
 *   null           — не родня.
 * Надмножества — только кандидаты на глаза человеку, не приговор.
 */
export function twinMatch(latinTitle: string, cyrTitle: string): TwinMatchKind | null {
  const lat = latinTokens(latinTitle);
  const cyr = translitTokens(cyrTitle);
  if (lat.length === 0 || cyr.length === 0) return null;
  const latSet = new Set(lat);
  const cyrSet = new Set(cyr);
  if (lat.length === cyr.length && lat.every((t, i) => t === cyr[i])) return 'exact';
  if (cyr.every(t => latSet.has(t))) return 'latin_superset';
  if (lat.every(t => cyrSet.has(t))) return 'cyr_superset';
  return null;
}
