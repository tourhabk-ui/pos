/**
 * ПОИСК · упоминает ли тур слово туриста — предикат фильтра `get_tours`
 * (Кузьмич и MCP) и туров места рядом с прайсом машин (`search_transfers`).
 *
 * Это не новый движок подбора (§4): своего SQL и ранжирования здесь нет.
 * Строки туров читает каталог Кузьмича (lib/kuzmich/core, loadTourCatalog),
 * порядок задаёт правило 1в (lib/tours/offer-order). Здесь только ответ на
 * вопрос «где в данных тура стоит это слово».
 *
 * ── Почему отдельно от строки каталога (ловушка MCP 29.10, filter-coverage) ──
 *
 * Фильтр искал слово в выведенной строке каталога целиком. В строке есть имя
 * компании («Оп: Край Вулканов», «Оп: Лагуна Экспедиция») и служебный текст
 * («заявка оператору», «свободны»), и на «вулкан» находился круиз на
 * Командоры, а на «экспедиция» — все туры одной компании. Полного описания и
 * программы в строке нет: на «озеро» не находилась Долина гейзеров с
 * кратерным озером, а ответ «ничего нет» говорил «ни в описаниях» о текстах,
 * которые не читались.
 *
 * Теперь у тура два текста, собранные из его ПОЛЕЙ:
 *   near — название, место тура, краткое описание, имя и тип главного места
 *          (operator_tours.main_place_id — записанная связь, не похожесть);
 *   far  — полное описание и программа.
 * Имени компании и служебного текста нет ни в одном: продавца по имени ищет
 * get_tour_details (resolveTourChoice), не фильтр.
 *
 * ── Правило совпадения ─────────────────────────────────────────────────────
 *
 * Каждое слово запроса от четырёх букв обязано совпасть (не «любое»: иначе
 * «наблюдение за китами» нашло бы «Наблюдение за медведями»). Слово — основа
 * (lib/search/query-words, то же правило, что у `search`), и совпадает она с
 * НАЧАЛОМ слова текста: «озеро» — «озёра», «пеш» — «пешком», но не
 * «успешно». Все слова в near — 'near'; все в near и far вместе, каждое
 * отдельно, — 'far'.
 *
 * Четырёхбуквенное слово с окончанием («киты», «юрта», «река», «горы») —
 * ещё и как слово с другим падежным окончанием: «киты» — «китами», «юрта» —
 * «юрте» (ревью 29.10: «киты» не находили «встречи с косатками и китами», а
 * ответ «нет» уже называл программу проверенной). Окончание — из закрытого
 * списка, а не любые буквы: «горы» — не «город» и не «Горелый», «река» — не
 * «рекомендуем».
 *
 * Общие слова каталога («туры», «tour», «trip») не ищутся: каталог целиком из
 * туров, и обязательное «туры» отсеивало туры случайно — «туры на вулканы»
 * не находили ни одного тура вида volcano (ревью 29.10).
 *
 * Английское слово ищется русскими основами словаря; короткая основа — только
 * по её правилу (SHORT_STEMS), иначе не ищется. Ничего не осталось — текст
 * туров по слову не искался вовсе, и это исход «не искал», а не «нет» (§4.0):
 * тексты туров русские.
 *
 * Сторожа: tests/unit/tour-filter.test.ts (вызов на строках-объектах),
 * tests/integration/public-tour-gate.pg.test.ts (SQL каталога на схеме прода).
 */

import { locationTypeLabel } from '@/lib/places/location-types';
import { QUERY_STOP_WORDS, SHORT_STEMS, stemRu, translateEn } from './query-words';

/** Поля тура, из которых собирается указатель. Компании здесь нет намеренно. */
export interface TourMatchRow {
  title?: string | null;
  location_name?: string | null;
  short_description?: string | null;
  /** Имя главного места — только видимого и не слитого (LEFT JOIN по main_place_id). */
  main_place_name?: string | null;
  /** places.location_type главного места. */
  main_place_type?: string | null;
  description?: string | null;
  /** Текст программы дня: заголовки и тексты пунктов одной строкой. */
  program_text?: string | null;
}

/** Указатель тура: слова каждого текста, нормализованные, через пробел и с пробелом по краям. */
export interface TourMatchEntry {
  /** Главное место тура: имя и подпись типа. */
  place: string;
  /** Название, место тура, краткое описание, главное место. */
  near: string;
  /** Полное описание и программа. */
  far: string;
}

export type TourMatch = 'near' | 'far' | null;

/** Слово туриста, разобранное для поиска по текстам туров. */
export interface TourQuery {
  /**
   * На каждое значимое слово — его иглы: строки, которые ищутся в указателе.
   * Основа — с пробелом впереди (начало слова); слово с окончанием — с
   * пробелом и впереди, и в конце (слово целиком).
   */
  needles: ReadonlyArray<readonly string[]>;
  /**
   * Латиница, по которой тексты туров не искались: в словаре её нет или у
   * неё там только короткая основа без правила.
   */
  english: readonly string[];
  /** Английские слова и чем они искались — словами для ответа. */
  translated: ReadonlyArray<{ from: string; to: readonly string[] }>;
  /** Общие слова каталога («туры», «tour»): не сужают и не ищутся. */
  generic: readonly string[];
  /** Русские слова короче четырёх букв: не ищутся. */
  short: readonly string[];
}

/** ё→е и «кк»→«к»: «треккинг» и «трекинг» пишут оба, туристы — как придётся. */
export function normalizeMatchText(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/кк/g, 'к');
}

function tokens(parts: ReadonlyArray<string | null | undefined>): string {
  const words = parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .flatMap((p) => normalizeMatchText(p).split(/[^a-zа-я0-9]+/))
    .filter(Boolean);
  return words.length > 0 ? ` ${words.join(' ')} ` : ' ';
}

/** Подпись типа главного места; «Место» (other) и незнакомый ключ ничего не добавляют. */
function placeTypeLabel(type: string | null | undefined): string {
  if (!type || type === 'other') return '';
  return locationTypeLabel(type, '');
}

/** Указатель тура из его полей. Чистая функция: SQL — у вызывающего. */
export function tourMatchEntry(row: TourMatchRow): TourMatchEntry {
  const label = row.main_place_name ? placeTypeLabel(row.main_place_type) : '';
  return {
    place: tokens([row.main_place_name, label]),
    near: tokens([row.title, row.location_name, row.short_description, row.main_place_name, label]),
    far: tokens([row.description, row.program_text]),
  };
}

const CYRILLIC = /^[а-я]+$/;
const LATIN = /^[a-z]+$/;
/** Основы короче — слишком общие: «тур», «на» нашли бы всё. */
export const MIN_QUERY_WORD = 4;

/**
 * Общие слова каталога: каждый тур — тур, и обязательное «туры» отсеивало бы
 * туры случайно (ревью 29.10: «туры на вулканы» — ни одного тура вида
 * volcano). Свой список, а не служебные слова словаря: `search` коннектора
 * ищет и места, и жильё, и «тур» для него слово.
 */
export const TOUR_GENERIC_WORDS: ReadonlySet<string> = new Set([
  'тур', 'туры', 'тура', 'туров', 'туру', 'туром', 'туре', 'турах', 'турам', 'турами',
  'tour', 'tours', 'trip', 'trips',
]);

/**
 * Падежные окончания для слова «основа + окончание» (закрытый список): «кит»
 * — «киты», «китами», «китов»; «рек» — «реке», «рекой»; но не «китайский»,
 * не «рекомендуем», не «город» от «горы».
 */
const INFLECTION_ENDINGS: readonly string[] = [
  '', 'а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ь', 'й',
  'ой', 'ей', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ью', 'ою', 'ею', 'ами', 'ями',
];
/** Конец слова, который у четырёхбуквенного слова — скорее окончание. */
const ENDS_IN_ENDING = /[аеиоуыэюяьй]$/;

const prefixNeedle = (stem: string) => ` ${stem}`;
const wholeNeedles = (base: string) => INFLECTION_ENDINGS.map((e) => ` ${base}${e} `);

/** Иглы русского слова: основа с начала слова; у четырёх букв с окончанием — и слово с другим окончанием. */
function cyrillicNeedles(w: string): string[] {
  if (w.length === MIN_QUERY_WORD && ENDS_IN_ENDING.test(w)) return [prefixNeedle(w), ...wholeNeedles(w.slice(0, 3))];
  return [prefixNeedle(stemRu(w))];
}

/** Английское слово → иглы и подписи по словарю; короткая основа — только по своему правилу. */
function englishNeedles(w: string): { needles: string[]; shown: string[] } {
  const ru = translateEn(w) ?? [];
  const needles: string[] = [];
  const shown: string[] = [];
  for (const raw of ru) {
    const st = normalizeMatchText(raw);
    const rule = st.length >= MIN_QUERY_WORD ? 'prefix' : SHORT_STEMS[st];
    if (rule === 'prefix') { needles.push(prefixNeedle(st)); shown.push(`${st}…`); }
    else if (rule === 'inflected') { needles.push(...wholeNeedles(st)); shown.push(`${st} + окончание`); }
  }
  return { needles, shown };
}

/**
 * Слово туриста → иглы для указателя. Русские слова короче четырёх букв,
 * служебные и общие слова каталога не участвуют. Английское — русскими
 * основами словаря; не нашлось ни одной пригодной — в `english`, и по
 * текстам такой запрос не ищется.
 */
export function parseTourQuery(want: string): TourQuery {
  const needles: string[][] = [];
  const english: string[] = [];
  const translated: Array<{ from: string; to: readonly string[] }> = [];
  const generic: string[] = [];
  const short: string[] = [];
  for (const w of normalizeMatchText(want).split(/[^a-zа-я0-9]+/).filter(Boolean)) {
    if (QUERY_STOP_WORDS.has(w)) continue;
    if (TOUR_GENERIC_WORDS.has(w)) { generic.push(w); continue; }
    if (CYRILLIC.test(w)) {
      if (w.length >= MIN_QUERY_WORD) needles.push(cyrillicNeedles(w));
      else short.push(w);
      continue;
    }
    if (LATIN.test(w)) {
      const en = englishNeedles(w);
      if (en.needles.length > 0) { needles.push(en.needles); translated.push({ from: w, to: en.shown }); }
      else if (w.length >= 3) english.push(w);
    }
  }
  return { needles, english, translated, generic, short };
}

/** Искался ли текст туров по этому запросу: есть иглы и нет незнакомой латиницы. */
export function tourTextSearchable(q: TourQuery): boolean {
  return q.needles.length > 0 && q.english.length === 0;
}

/**
 * Запрос только из общих слов каталога («туры», «tours»): им назван весь
 * каталог, а не вид отдыха или место, — фильтр по нему не сужает.
 */
export function onlyGenericTourWords(q: TourQuery): boolean {
  return q.generic.length > 0 && q.needles.length === 0 && q.english.length === 0 && q.short.length === 0;
}

const hasNeedle = (text: string, alts: readonly string[]) => alts.some((n) => text.includes(n));

/**
 * Где у тура стоит слово туриста: 'near' — все слова в названии, месте,
 * кратком описании или главном месте; 'far' — часть или все только в полном
 * описании и программе; null — не все слова нашлись или текст не искался.
 */
export function matchTour(entry: TourMatchEntry, want: string | TourQuery): TourMatch {
  const q = typeof want === 'string' ? parseTourQuery(want) : want;
  if (!tourTextSearchable(q)) return null;
  if (q.needles.every((alts) => hasNeedle(entry.near, alts))) return 'near';
  if (q.needles.every((alts) => hasNeedle(entry.near, alts) || hasNeedle(entry.far, alts))) return 'far';
  return null;
}

/** Все ли слова запроса — в главном месте тура (имя или тип по записанной связи). */
export function matchTourPlace(entry: TourMatchEntry, want: string | TourQuery): boolean {
  const q = typeof want === 'string' ? parseTourQuery(want) : want;
  return tourTextSearchable(q) && q.needles.every((alts) => hasNeedle(entry.place, alts));
}
