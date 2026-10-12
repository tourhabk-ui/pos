/**
 * Слова запроса для `search` коннектора (lib/mcp/connector-tools).
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * 12.10 живой `search` на проде ответил пусто на собственный пример из
 * описания инструмента — «Курильское озеро медведи» — и на «Kurile Lake
 * bears», хотя «Курильское озеро» одно даёт десять записей. Причина: вся
 * строка запроса подставлялась в ILIKE одним куском, и запись проходила
 * только там, где эти слова стоят подряд и в той же форме. Агент, получив
 * пустой ответ, запоминает «у них ничего нет» (#2371, узкое место 2).
 *
 * Здесь запрос режется на слова, каждое слово ищется отдельно, а запись
 * ранжируется по числу совпавших слов. Русское слово сводится к основе
 * (простое усечение: «озеро» → «озер», «медведи» → «медве»), чтобы ILIKE
 * ловил и «озера», и «медвежья». Английское слово переводится явным
 * словарём в русские основы: модели читают описания по-английски, а данные
 * платформы русские (§4.0: обещать английский поиск без словаря было бы
 * выдумкой — словарь и есть то, что обещано).
 *
 * ── Границы ────────────────────────────────────────────────────────────────
 *
 * Словарь закрытый и намеренно узкий: топонимы Камчатки и слова туриста.
 * Чего в нём нет — остаётся латиницей и в русском тексте не найдётся; это
 * «не нашли», а не «нет». Служебные слова («и», «the») отбрасываются, чтобы
 * не ранжировать по ним. Больше шести слов — лишние отбрасываются: запрос
 * агента длиннее шести значимых слов это уже вопрос, а не поиск.
 *
 * Сторож: tests/unit/mcp-search-terms.test.ts.
 */

/** Больше слов в SQL не уходит: каждое — свой параметр и своё слагаемое ранга. */
export const MAX_TERMS = 6;

/** Слова, которые ничего не ищут: предлоги, союзы, артикли. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'по', 'о', 'об', 'у', 'из', 'за', 'от', 'до', 'для', 'не', 'ни',
  'что', 'как', 'или', 'а', 'но', 'же', 'то', 'это', 'где', 'когда', 'там', 'тут', 'ли', 'бы', 'да', 'нет',
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'with', 'is', 'are', 'near', 'from',
  'by', 'about', 'what', 'where', 'how', 'best', 'top',
]);

/**
 * Английское слово → основы русских слов, которые ищутся вместо него.
 * Основа, не слово: ILIKE '%основа%' ловит все формы. Несколько основ — когда
 * по-русски это говорится по-разному.
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

const CYRILLIC = /^[а-яё]+$/i;
const LATIN = /^[a-z]+$/i;

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

/**
 * Слова запроса → основы для ILIKE, каждая своим параметром. Пустой итог
 * невозможен: если значимых слов не осталось, ищется вся строка, как раньше.
 */
export function searchTerms(query: string): string[] {
  const raw = query.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-яё0-9-]+/i).filter((w) => w.length >= 2);
  const out: string[] = [];
  const push = (t: string) => { if (t.length >= 2 && !out.includes(t)) out.push(t); };
  for (const w of raw) {
    if (STOP_WORDS.has(w)) continue;
    if (CYRILLIC.test(w)) { push(stemRu(w)); continue; }
    if (LATIN.test(w)) {
      const ru = translateEn(w);
      if (ru) ru.forEach(push); else push(w);
      continue;
    }
    push(w);
  }
  if (out.length === 0) return [query.trim().replace(/\s+/g, ' ')];
  return out.slice(0, MAX_TERMS);
}
