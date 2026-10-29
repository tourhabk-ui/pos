/**
 * ПОИСК · слова запроса: русская основа и английский словарь поисков туров.
 *
 * До 29.10 правило основы жило копиями: `stemRu` в lib/mcp/search-terms
 * (поиск `search` коннектора), `wordStem` в lib/kuzmich/tour-filter (фильтр
 * get_tours), `stem` в lib/search/tour-query-match («Туры по запросу» и
 * /api/search) и `stemOf` в lib/kuzmich/tour-availability-tool (резолвер
 * имени тура). Правило одно — усечение до max(4, len−2) у слов от пяти букв,
 * — и копии расходились бы молча. Английский словарь был только у `search`,
 * и get_tours по-английски («whales», «fishing») не находил ничего, кроме
 * слага вида отдыха, а отвечал «нет ни в описаниях» (ловушка MCP 29.10,
 * filter-coverage). Теперь все четыре читают `stemRu` отсюда.
 *
 * Своё правило осталось у судьи коммерческого эвала
 * (lib/agents/eval/commercial-checks, mentionsOperator): там у
 * четырёхбуквенного слова основа — три буквы. Это сличение имени компании в
 * ответе модели («Край» — «Края»), а не поиск туров, и сюда оно не сведено.
 * Фильтр get_tours поверх `stemRu` сверяет короткие слова по своему правилу
 * (lib/search/tour-match): четырёхбуквенное — ещё и как слово с окончанием.
 *
 * Словарь закрытый и намеренно узкий: топонимы Камчатки и слова туриста.
 * Чего в нём нет — остаётся латиницей и в русском тексте не найдётся; это
 * «не искал», а не «нет» (§4.0).
 *
 * Сторожа: tests/unit/mcp-search-terms.test.ts, tests/unit/tour-filter.test.ts.
 */

/** Слова, которые ничего не ищут: предлоги, союзы, артикли. */
export const QUERY_STOP_WORDS: ReadonlySet<string> = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'о', 'об', 'у', 'из', 'за', 'от', 'до', 'для', 'не', 'ни',
  'что', 'как', 'или', 'а', 'но', 'же', 'то', 'это', 'где', 'когда', 'там', 'тут', 'ли', 'бы', 'да', 'нет',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'is', 'are', 'near', 'from',
  'by', 'about', 'what', 'where', 'how', 'best', 'top',
]);

/**
 * Английское слово → основы русских слов, которые ищутся вместо него.
 * Основа, не слово: она ловит все формы. Несколько основ — когда по-русски
 * это говорится по-разному.
 */
export const EN_TO_RU: Readonly<Record<string, readonly string[]>> = {
  // что ищет турист
  lake: ['озер'], volcano: ['вулкан'], volcanic: ['вулкан'], bear: ['медве'], geyser: ['гейзер'],
  valley: ['долин'], rafting: ['сплав'], raft: ['сплав'], fishing: ['рыб'], fish: ['рыб'], salmon: ['лосос', 'нерк', 'кижуч', 'чавыч'],
  helicopter: ['вертол'], heli: ['вертол'], hot: ['горяч'], spring: ['источник'], thermal: ['терм', 'источник'],
  trek: ['трекинг', 'поход'], trekking: ['трекинг', 'поход'], hike: ['поход', 'пеш'], hiking: ['поход', 'пеш'],
  climb: ['восхожд'], climbing: ['восхожд'], ascent: ['восхожд'], summit: ['восхожд', 'вершин'],
  ski: ['лыж'], skiing: ['лыж'], heliski: ['хели', 'лыж'], snowmobile: ['снегоход'], beach: ['пляж'],
  ocean: ['океан'], pacific: ['океан', 'тихи'], river: ['рек'], sea: ['морск', 'море'], marine: ['морск'],
  boat: ['катер', 'морск'], cruise: ['круиз'], whale: ['кит'], orca: ['косат'], island: ['остров'],
  waterfall: ['водопад'], cave: ['пещер'], pass: ['перевал'], glacier: ['ледник'], bay: ['бухт'], cape: ['мыс'],
  winter: ['зим'], snow: ['снег'], summer: ['летн'], camp: ['лагер', 'палатк'], camping: ['лагер', 'палатк'],
  jeep: ['джип'], offroad: ['вездеход', 'джип'], tour: ['тур'], excursion: ['экскурс'], day: ['дн', 'однодневн'],
  stay: ['гостев', 'отел', 'гостиниц', 'жиль'], hotel: ['отел', 'гостиниц'], guesthouse: ['гостев'], hostel: ['хостел'],
  accommodation: ['гостев', 'отел', 'гостиниц', 'жиль'], lodging: ['гостев', 'отел', 'жиль'],
  gear: ['снаряж', 'прокат'], equipment: ['снаряж', 'прокат'], rental: ['прокат', 'аренд'],
  transfer: ['трансфер'], bus: ['автобус', 'вахтов'], shuttle: ['трансфер', 'вахтов'], safety: ['безопасн'],
  eruption: ['изверж'], route: ['маршрут'], trail: ['троп', 'маршрут'], park: ['парк'], reserve: ['заповедн'],
  // топонимы
  kamchatka: ['камчатк'], kuril: ['курильск'], kurile: ['курильск'], kurilskoe: ['курильск'], kurilskoye: ['курильск'], kurilsky: ['курильск'],
  tolbachik: ['толбач'], mutnovsky: ['мутновск'], mutnovskiy: ['мутновск'], avacha: ['авач'], avachinsky: ['авачинск'], avachinskiy: ['авачинск'],
  klyuchevskaya: ['ключевск'], klyuchevskoy: ['ключевск'], kluchevskaya: ['ключевск'], gorely: ['горел'], goreliy: ['горел'],
  vilyuchinsky: ['вилючинск'], vilyuchik: ['вилючинск'], koryaksky: ['корякск'], koryakskiy: ['корякск'], uzon: ['узон'], esso: ['эссо'],
  nalychevo: ['налычев'], nalychevsky: ['налычев'], komandorsky: ['командорск'], komandorskie: ['командорск'], commander: ['командорск'],
  bystraya: ['быстр'], paratunka: ['паратунк'], petropavlovsk: ['петропавловск'], khalaktyrsky: ['халактырск'], khalaktyrskiy: ['халактырск'],
  vachkazhets: ['вачкаж'], dachnye: ['дачн'], russkaya: ['русск'], starichkov: ['старичк'], kronotsky: ['кроноцк'], shiveluch: ['шивелуч'],
  karymsky: ['карымск'], semyachik: ['семячик'], ksudach: ['ксудач'], khodutka: ['ходутк'], zhupanova: ['жупанов'], opala: ['опал'],
  tolmachevo: ['толмач'], mayachny: ['маячн'], mayachniy: ['маячн'], krasheninnikov: ['крашенинник'], nikolskaya: ['никольск'],
  malki: ['малк'], milkovo: ['мильков'], ust: ['усть'], kozelsky: ['козельск'], zhirovaya: ['жиров'], olga: ['ольг'],
};

/**
 * Короткие основы словаря (меньше четырёх букв) и как их сверять с текстом
 * туров в get_tours (lib/search/tour-match). Там основа совпадает с НАЧАЛОМ
 * слова, и короткая основа ловит чужие слова — ревью 29.10: «river» → «рек»
 * находил «Рекомендуем», «day» → «дн» — «3 дня», «tour» → «тур» — «Туристы».
 *   prefix    — с начала слова, как длинная основа: «рыб» — «рыбалка»,
 *               «пеш» — «пешком», «лыж» — «лыжный», «зим» — «зимний»;
 *   inflected — слово целиком, основа с падежным окончанием: «кит» —
 *               «китами», но не «китайский»; «рек» — «реке», но не
 *               «рекомендуем»; «мыс» — «мыса», но не «мысль».
 * Короткая основа без записи здесь в get_tours не ищется; почему — в
 * SHORT_STEMS_NOT_SEARCHED. Поиск `search` коннектора этим не пользуется:
 * у него ILIKE с рангом по числу слов.
 */
export const SHORT_STEMS: Readonly<Record<string, 'prefix' | 'inflected'>> = {
  'рыб': 'prefix', 'пеш': 'prefix', 'лыж': 'prefix', 'зим': 'prefix',
  'кит': 'inflected', 'рек': 'inflected', 'мыс': 'inflected',
};

/** Короткие основы словаря, по которым get_tours не ищет, — с причиной. */
export const SHORT_STEMS_NOT_SEARCHED: Readonly<Record<string, string>> = {
  'дн': '«дня», «дней» — длительность любого тура, а не «однодневный»',
  'тур': 'каталог целиком состоит из туров: слово ничего не сужает',
};

/** Русская основа: усечение до max(4, len−2) у слов от пяти букв. */
export function stemRu(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, 'е');
  if (w.length < 5) return w;
  return w.slice(0, Math.max(4, w.length - 2));
}

/** Английское слово → русские основы; множественное число снимается по -s/-es/-ies. */
export function translateEn(word: string): readonly string[] | null {
  const w = word.toLowerCase();
  const candidates = [w];
  if (w.endsWith('ies')) candidates.push(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) candidates.push(w.slice(0, -2));
  if (w.endsWith('s')) candidates.push(w.slice(0, -1));
  for (const c of candidates) {
    const hit = EN_TO_RU[c];
    if (hit) return hit;
  }
  return null;
}
