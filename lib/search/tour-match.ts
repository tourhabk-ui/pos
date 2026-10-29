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
 * НАЧАЛОМ слова текста: «кит» английского словаря — «китами», но не
 * «Никита»; «пеш» — «пешком», но не «успешно». Все слова в near — 'near';
 * все в near и far вместе — 'far'.
 *
 * Английское слово ищется русскими основами словаря. Нет его в словаре —
 * текст туров по нему не искался вовсе, и это исход «не искал», а не «нет»
 * (§4.0): тексты туров русские.
 *
 * Сторожа: tests/unit/tour-filter.test.ts (вызов на строках-объектах),
 * tests/integration/public-tour-gate.pg.test.ts (SQL каталога на схеме прода).
 */

import { locationTypeLabel } from '@/lib/places/location-types';
import { QUERY_STOP_WORDS, stemRu, translateEn } from './query-words';

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
  /** На каждое значимое слово — его основы (у английского их может быть несколько). */
  stems: ReadonlyArray<readonly string[]>;
  /** Латиница без записи в словаре: по текстам туров не искалась. */
  english: readonly string[];
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
 * Слово туриста → основы. Русские слова короче четырёх букв и служебные не
 * участвуют. Английское — русскими основами словаря; нет в словаре — в
 * `english`, и по текстам такой запрос не ищется.
 */
export function parseTourQuery(want: string): TourQuery {
  const stems: string[][] = [];
  const english: string[] = [];
  for (const w of normalizeMatchText(want).split(/[^a-zа-я0-9]+/).filter(Boolean)) {
    if (QUERY_STOP_WORDS.has(w)) continue;
    if (CYRILLIC.test(w)) {
      if (w.length >= MIN_QUERY_WORD) stems.push([stemRu(w)]);
      continue;
    }
    if (LATIN.test(w)) {
      const ru = translateEn(w);
      if (ru) stems.push(ru.map(normalizeMatchText));
      else if (w.length >= 3) english.push(w);
    }
  }
  return { stems, english };
}

/** Искался ли текст туров по этому запросу: есть основы и нет незнакомой латиницы. */
export function tourTextSearchable(q: TourQuery): boolean {
  return q.stems.length > 0 && q.english.length === 0;
}

const hasStem = (text: string, alts: readonly string[]) => alts.some((st) => text.includes(` ${st}`));

/**
 * Где у тура стоит слово туриста: 'near' — все слова в названии, месте,
 * кратком описании или главном месте; 'far' — часть или все только в полном
 * описании и программе; null — не все слова нашлись или текст не искался.
 */
export function matchTour(entry: TourMatchEntry, want: string | TourQuery): TourMatch {
  const q = typeof want === 'string' ? parseTourQuery(want) : want;
  if (!tourTextSearchable(q)) return null;
  if (q.stems.every((alts) => hasStem(entry.near, alts))) return 'near';
  if (q.stems.every((alts) => hasStem(entry.near, alts) || hasStem(entry.far, alts))) return 'far';
  return null;
}

/** Все ли слова запроса — в главном месте тура (имя или тип по записанной связи). */
export function matchTourPlace(entry: TourMatchEntry, want: string | TourQuery): boolean {
  const q = typeof want === 'string' ? parseTourQuery(want) : want;
  return tourTextSearchable(q) && q.stems.every((alts) => hasStem(entry.place, alts));
}
