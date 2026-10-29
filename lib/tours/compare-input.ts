/**
 * Вход сравнения туров (compare_tours, слово владельца 29.10: «делай» на
 * «сравнение 2–4 туров по тому, что важно человеку — только факты из базы»).
 *
 * Модуль чистый — без базы: его зовут и Zod-схема инструмента (сколько туров
 * названо), и исполнитель (какие туры и какие строки сравнения).
 *
 * ── Туры ──────────────────────────────────────────────────────────────────
 *
 * Номера — через запятую («61, 70»), названия — через «;». В названиях туров
 * бывают запятые («Вулкан Горелый, кратеры и пещеры»), и угадывать, где
 * кончается одно название и начинается другое, нельзя (§4.0): строка без «;»
 * из не-номеров — ОДНО название. Китайские «；», «、» и «，» в русских
 * названиях не встречаются никогда — они делят всегда.
 *
 * ── Критерии ──────────────────────────────────────────────────────────────
 *
 * Набор фиксированный: строка сравнения — это поле базы и функция, которая
 * уже называет его на карточке или в ответах агента. Синонимы — явным
 * словарём, по-русски и по-английски. Чего в наборе нет, называется в ответе
 * с причиной, а не выбрасывается молча. Оценки, рейтинг и правила
 * безопасности в набор не входят намеренно: сравнение раскладывает факты,
 * выбирает человек (§0); отсутствие записанных правил безопасности рядом с
 * чужими читалось бы как «здесь риска меньше».
 */

/** Сколько туров сравнивается за раз. */
export const COMPARE_MIN_TOURS = 2;
export const COMPARE_MAX_TOURS = 4;

/** Номер тура в записи человека или агента: «61», «ID61», «ID 61», «tour:61», «#61», «№61». */
const TOUR_ID_RE = /^(?:#|№\s*|id\s*|tour:\s*)?(\d+)$/i;

/** Разделители названий: «;» и китайская пунктуация, которой нет в русских названиях. */
const NAME_SEP = /[;；、，\n]+/;

/** Номер тура из записи или null — это не номер. */
export function tourIdOf(ref: string): string | null {
  const m = TOUR_ID_RE.exec(ref.trim());
  return m ? m[1] : null;
}

/** Часть списка — несколько номеров («61, 70», «61 и 70»)? Тогда — номера по одному. */
function idsIn(part: string): string[] | null {
  const byComma = part.split(',').map((x) => x.trim()).filter(Boolean);
  if (byComma.length > 1 && byComma.every((x) => tourIdOf(x) !== null)) return byComma.map((x) => tourIdOf(x) as string);
  const byWords = part.split(/[\s,]+/).filter((w) => w && !/^(?:и|and|&)$/i.test(w));
  if (byWords.length > 1 && byWords.every((x) => tourIdOf(x) !== null)) return byWords.map((x) => tourIdOf(x) as string);
  return null;
}

/**
 * Туры строкой — по одному. Номер приводится к числу («ID61» → «61»), чтобы
 * резолвер искал его как номер, а не как слово. Пустые части отбрасываются.
 */
export function splitTourList(raw: string): string[] {
  const parts = raw.split(NAME_SEP).map((x) => x.trim()).filter(Boolean);
  return parts.flatMap((p) => idsIn(p) ?? [tourIdOf(p) ?? p]);
}

export type Criterion =
  | 'price' | 'duration' | 'group' | 'difficulty' | 'season' | 'program'
  | 'included' | 'not_included' | 'cancellation' | 'pickup' | 'operator' | 'nearest_date';

/** Строки сравнения в порядке набора и их заголовки в ответе. */
export const COMPARE_CRITERIA: ReadonlyArray<{ key: Criterion; heading: string }> = [
  { key: 'price', heading: 'Цена' },
  { key: 'duration', heading: 'Длительность' },
  { key: 'group', heading: 'Группа' },
  { key: 'difficulty', heading: 'Сложность' },
  { key: 'season', heading: 'Сезон' },
  { key: 'program', heading: 'Программа' },
  { key: 'included', heading: 'Что входит' },
  { key: 'not_included', heading: 'Что не входит' },
  { key: 'cancellation', heading: 'Условия отмены' },
  { key: 'pickup', heading: 'Как попасть на тур' },
  { key: 'operator', heading: 'Оператор и проверка' },
  { key: 'nearest_date', heading: 'Ближайшая свободная дата' },
];

export const CRITERION_HEADING: Readonly<Record<Criterion, string>> = Object.fromEntries(
  COMPARE_CRITERIA.map((c) => [c.key, c.heading]),
) as Record<Criterion, string>;

/** Критерии не названы — короткий набор: то, о чём спрашивают до заявки. */
export const DEFAULT_CRITERIA: readonly Criterion[] = [
  'price', 'duration', 'nearest_date', 'difficulty', 'pickup', 'cancellation', 'operator',
];

/** Синонимы критериев. Ищется самый длинный, целыми словами: «не входит» раньше «входит». */
const CRITERION_WORDS: Readonly<Record<Criterion, readonly string[]>> = {
  price: ['цена', 'цены', 'цену', 'ценой', 'стоимость', 'стоимости', 'сколько стоит', 'итог', 'сумма', 'price', 'prices', 'cost', 'total'],
  duration: ['длительность', 'продолжительность', 'сколько длится', 'сколько дней', 'сколько часов', 'duration', 'how long', 'length'],
  group: ['группа', 'группы', 'размер группы', 'сколько человек', 'group', 'group size'],
  difficulty: ['сложность', 'сложности', 'нагрузка', 'физическая подготовка', 'difficulty', 'fitness'],
  season: ['сезон', 'сезона', 'когда', 'даты', 'season', 'dates', 'when'],
  program: ['программа', 'программу', 'по дням', 'маршрут дня', 'program', 'programme', 'itinerary'],
  included: ['что входит', 'входит', 'включено', 'что включено', 'included', 'includes', 'inclusions'],
  not_included: ['не входит', 'что не входит', 'не включено', 'доплата', 'доплаты', 'not included', 'extras', 'exclusions'],
  cancellation: ['отмена', 'отмены', 'условия отмены', 'возврат', 'cancellation', 'cancel', 'refund'],
  pickup: ['подвоз', 'трансфер', 'забор', 'заберут', 'как добраться', 'как попасть', 'сбор', 'место сбора', 'точка сбора', 'pickup', 'pick up', 'transfer', 'meeting point'],
  operator: ['оператор', 'компания', 'гид', 'продавец', 'проверка', 'кто проводит', 'operator', 'company', 'guide', 'verified', 'seller'],
  nearest_date: ['ближайшая дата', 'ближайшие даты', 'свободная дата', 'свободные даты', 'места', 'свободные места', 'наличие мест', 'availability', 'nearest date', 'free seats'],
};

/** Названное, но не сравниваемое — с причиной словами. */
const NOT_COMPARED: ReadonlyArray<{ words: readonly string[]; why: string }> = [
  {
    words: ['рейтинг', 'отзывы', 'отзыв', 'оценка', 'оценки', 'звезды', 'rating', 'ratings', 'reviews', 'stars', 'best'],
    why: 'оценок сравнение не ставит: отзывы туристов — на странице тура, если они есть',
  },
  {
    words: ['безопасность', 'опасность', 'опасности', 'риск', 'риски', 'safety', 'risk', 'risks'],
    why: 'правила безопасности тура — get_tour_details, обстановка у места — get_guardian_context; рядом их не ставлю: незаписанные правила не значат, что риска меньше',
  },
  {
    words: ['что взять', 'что взять с собой', 'снаряжение', 'экипировка', 'what to bring', 'gear'],
    why: 'что взять с собой — get_tour_details: это список сборов, а не отличие туров',
  },
];

/** Слова фразы: строчные, «ё» как «е», без пунктуации. */
function wordsOf(s: string): string[] {
  return s.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Слово человека — то же слово словаря с другим окончанием: «стоимостью» —
 * «стоимость», «возврата» — «возврат», «операторы» — «оператор». Короткие
 * слова (до пяти букв) — только точно: «гид» не «гидра», «даты» не «датчик».
 */
function sameWord(w: string, s: string): boolean {
  if (w === s) return true;
  if (w.length < 5 || s.length < 5) return false;
  let i = 0;
  while (i < w.length && i < s.length && w[i] === s[i]) i++;
  return i >= Math.max(4, s.length - 2) && w.length - i <= 3 && s.length - i <= 2;
}

interface Phrase<T> { words: string[]; value: T }

/** Длинные фразы раньше коротких: «не входит» побеждает «входит», «свободные даты» — «даты». */
function phraseIndex<T>(entries: ReadonlyArray<{ words: readonly string[]; value: T }>): Phrase<T>[] {
  return entries
    .flatMap((e) => e.words.map((w) => ({ words: wordsOf(w), value: e.value })))
    .sort((a, b) => b.words.length - a.words.length || b.words.join(' ').length - a.words.join(' ').length);
}

const CRITERION_INDEX = phraseIndex((Object.entries(CRITERION_WORDS) as Array<[Criterion, readonly string[]]>)
  .map(([value, words]) => ({ words, value })));
const NOT_COMPARED_INDEX = phraseIndex(NOT_COMPARED.map((n) => ({ words: n.words, value: n.why })));

/** Первое вхождение фразы в слова части, не задевающее уже занятых слов; -1 — нет. */
function findPhrase(tokens: readonly string[], used: readonly boolean[], phrase: readonly string[]): number {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, j) => !used[i + j] && sameWord(tokens[i + j], w))) return i;
  }
  return -1;
}

export interface UnknownCriterion {
  /** Как назвал человек. */
  word: string;
  /** Почему не сравнивается; null — такого критерия нет в наборе. */
  why: string | null;
}

export interface ParsedCriteria {
  /** Строки сравнения — в порядке, как назвал человек, без повторов. */
  keys: Criterion[];
  /** Названное, но не узнанное — называется в ответе. */
  unknown: UnknownCriterion[];
  /** Ни один критерий не узнан (или не назван) — взят короткий набор. */
  defaulted: boolean;
}

/**
 * Что важно человеку — строкой через запятую, «;», перевод строки или «и».
 * Часть без единого синонима — в `unknown`; ни одного узнанного — набор по
 * умолчанию, и это сказано (`defaulted`).
 */
export function parseCriteria(raw: string | null | undefined): ParsedCriteria {
  const parts = (raw ?? '')
    .split(/[,;\n]+|\s+(?:и|and)\s+|\s*&\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const keys: Criterion[] = [];
  const unknown: UnknownCriterion[] = [];
  for (const part of parts) {
    const tokens = wordsOf(part);
    const used = tokens.map(() => false);
    // Найденные в части критерии — по месту в тексте: «цена и длительность» и
    // «длительность, цена» дают строки в порядке слов человека.
    const found: Array<{ at: number; key: Criterion }> = [];
    for (const p of CRITERION_INDEX) {
      for (let at = findPhrase(tokens, used, p.words); at >= 0; at = findPhrase(tokens, used, p.words)) {
        for (let j = 0; j < p.words.length; j++) used[at + j] = true;
        found.push({ at, key: p.value });
      }
    }
    for (const f of found.sort((a, b) => a.at - b.at)) if (!keys.includes(f.key)) keys.push(f.key);
    if (found.length === 0) {
      const not = NOT_COMPARED_INDEX.find((n) => findPhrase(tokens, used, n.words) >= 0);
      unknown.push({ word: part, why: not?.value ?? null });
    }
  }
  return keys.length > 0
    ? { keys, unknown, defaulted: false }
    : { keys: [...DEFAULT_CRITERIA], unknown, defaulted: true };
}
