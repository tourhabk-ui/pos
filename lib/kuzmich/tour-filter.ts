/**
 * Фильтр каталога туров по слову туриста — для `get_tours` (Кузьмич и MCP).
 *
 * Фильтр по типу объявлен в схеме с самого начала, но executeTool его
 * игнорировал (аудит 08.08). Матчим и слаг (fishing), и русскую метку
 * (Рыбалка) — модель передаёт слово туриста.
 *
 * Слово туриста — не всегда тип (сверка MCP 25.09): «вулканы» типом тура не
 * бывает и уходили в «по типу нет» плюс полный каталог рыбалки. Теперь второй
 * ступенью — упоминание в названии или описании (основа слова без окончания,
 * чтобы «вулканы» нашли «вулкан» и «вулканов»), с пометкой «тип другой».
 * Ничего нет — сказано прямо, и каталог идёт как замена с оговоркой, а не
 * как ответ на спрошенное.
 *
 * ── 08.10: «вулканы» не находили тип volcano ─────────────────────────────
 *
 * У тура «Восхождение на вулкан Ключевская Сопка» тип `volcano`, а ответ на
 * «вулканы» был «Тура с типом «вулканы» нет» — и тот же тур в списке «тип у
 * них другой». Тип сравнивался строкой целиком: «восхождение на вулкан» не
 * содержит «вулканы», а «вулканы» не содержит подписи. Теперь тип и слово
 * сравниваются ПО ОСНОВЕ, по каждому слову подписи во всех регистрах
 * словаря (полная, короткая, слаг): «вулканы» → «вулка» → «вулкан».
 *
 * И ответ больше не теряет туры: совпал тип — сначала они, а туры, где
 * слово стоит в названии или описании при другом типе (треккинг к вулкану,
 * облёт вулканов), идут следом отдельным блоком с той же оговоркой.
 *
 * ── 13.10: место — не вид отдыха ─────────────────────────────────────────
 *
 * Владелец: «тур на Авачинский вулкан есть». На «авачинский вулкан» ответ
 * начинался словами «Тура с типом «авачинский вулкан» нет» — и только потом
 * шли все пять туров к нему с припиской «тип у них другой, уточни, прежде
 * чем предлагать». Модель читала первую строку и отвечала «туров нет».
 * Фраза про тип верна только для слова, которое и есть вид отдыха
 * («дайвинг»: тип такой есть, туров этого типа нет). Название места типом не
 * бывает: для него ответ сразу — туры, где место упоминается, без отрицания
 * впереди и с просьбой назвать их, а что именно там делают — уточнить.
 * Вид ли это отдыха, решает словарь видов (typeMatches по всем его типам).
 *
 * ── 29.10: ищем в полях тура, а не в строке каталога ─────────────────────
 *
 * Утром того же дня шапка ответа называла причиной совпадения и «имя
 * компании»: слово сравнивалось со всей строкой каталога, а в ней
 * «Оп: <продавец>». Разбор ловушки MCP filter-coverage показал, что это не
 * подпись надо было править, а место поиска. На «вулкан» находились круиз на
 * Командоры и автотур на Курильское озеро только потому, что компания
 * называется «Край Вулканов»; на «экспедиция» — все туры «Лагуны
 * Экспедиции». А полного описания и программы в строке нет вовсе: на
 * «озеро» не находилась Долина гейзеров с озером в кратере, и ответ «ничего
 * нет» говорил «ни в описаниях» о текстах, которые не читались.
 *
 * Теперь слово ищет движок ПОИСК (lib/search/tour-match) в указателе, который
 * каталог собирает из полей тура рядом со строкой (loadTourCatalogEntries).
 * Указатель обязателен: запасного пути по разрезанной строке нет — именно
 * на строке другой формы, чем у прода, сторож этой ловушки и зеленел.
 * Блоки ответа:
 *   (а) совпал вид отдыха;
 *   (б) слово в названии, месте, кратком описании или главном месте тура;
 *   (в) слово только в полном описании или программе — отдельно и с
 *       нейтральной подписью: занятие это, вид по пути или предупреждение
 *       («медведи» в правилах безопасности), фильтр не знает.
 * Внутри блоков — порядок каталога (правило 1в). Имя компании или гида не
 * ищется нигде: туры продавца — get_tour_details (resolveTourChoice), и
 * каждый ответ, где искали по текстам, так и говорит (NO_SELLER_NAMES), а
 * «ничего нет» перечисляет ровно то, где искали.
 *
 * Ревью того же дня: общие слова каталога («туры», «tours») не сужают —
 * запрос из них одних отдаёт весь каталог как ответ; английские слова ищутся
 * основами словаря, и ответ называет, какими; у (в) из нескольких слов
 * подпись — «по отдельности, не фразой»; пояснение (б) у названия места
 * отделено от шапки пустой строкой, чтобы страницы не повторяли его над
 * страницей одних туров (в).
 */

import { ACTIVITY_LABELS } from '@/lib/tours/labels';
import { stemRu } from '@/lib/search/query-words';
import {
  matchTour, normalizeMatchText, onlyGenericTourWords, parseTourQuery, tourTextSearchable, TOUR_GENERIC_WORDS,
  type TourMatchEntry,
} from '@/lib/search/tour-match';

type ActivityLabel = (slug: string, short?: boolean) => string;

/**
 * Основа слова: без двух последних букв у длинных, не короче четырёх.
 * «вулканы» → «вулка», «рыбалка» → «рыбал», «сплав» → «спла». Правило —
 * общее с поиском (lib/search/query-words), «кк»→«к» — как у текста туров.
 */
export function wordStem(word: string): string {
  return stemRu(normalizeMatchText(word));
}

function words(s: string): string[] {
  return normalizeMatchText(s).split(/[^a-zа-я]+/).filter(Boolean);
}

/**
 * Совпадает ли слово туриста с типом тура: по основе, с любым словом подписи
 * типа в любом регистре или со слагом; у просьбы из нескольких слов — каждое. Слова подписи короче четырёх букв
 * («на», «тур») не участвуют: «туры» иначе нашли бы и снегоходный, и
 * культурный, и фототур. Общие слова каталога в просьбе («туры», «tours»)
 * тоже не участвуют: «вертолётные туры» — вертолётный тип (ревью 29.10:
 * обязательное «туры» не совпадало ни с одним типом, и блок (а) пустел).
 */
export function typeMatches(slug: string, want: string, activityLabel: ActivityLabel): boolean {
  const s = slug.toLowerCase();
  if (!s) return false;
  const typeWords = [
    ...words(s.replace(/_/g, ' ')), s,
    ...words(activityLabel(s)),
    ...words(activityLabel(s, true)),
  ].filter((w) => w.length >= 4);
  const wantStems = words(want).filter((w) => w.length >= 3 && !TOUR_GENERIC_WORDS.has(w)).map(wordStem);
  if (wantStems.length === 0) return false;
  // Каждое слово просьбы — у одного типа: «наблюдение за китами» иначе нашло
  // бы «Наблюдение за медведями» по первому слову.
  return wantStems.every((ws) => typeWords.some((tw) => tw.startsWith(ws) || ws.startsWith(wordStem(tw))));
}

/** Где ищет блок (б) — словами ответа и описания инструмента. */
export const NEAR_FIELDS = 'в названии, месте, кратком описании или главном месте тура';
/** Метка блока (в): по ней отрезают эталон (lib/agents/eval/commercial-checks). */
export const FAR_BLOCK_MARK = 'только в полном описании или программе';
/** Каталог, приложенный к ответу «нет», — замена, а не найденное. */
export const CATALOG_AS_SUBSTITUTE = 'Весь каталог — для замены с явной оговоркой:';
/**
 * Чего фильтр не ищет — в каждом ответе, где искал по текстам, а не только в
 * «нет»: на имя компании из нескольких слов блок (в) находил туры чужих
 * продавцов по словам по отдельности (ревью 29.10, «Край Вулканов»).
 */
export const NO_SELLER_NAMES = 'Имена компаний и гидов get_tours не ищет: туры продавца — get_tour_details.';

/**
 * Туров блока (в) в чате Кузьмича без страницы: весь отфильтрованный список
 * идёт там в результат инструмента. Остальные — строкой «ещё M».
 *
 * Замер 29.10 на базе со всеми миграциями (67 туров витрины): «вулкан» —
 * блок (в) 24 тура, 36% каталога (панорамы «на Домашние вулканы» в программах
 * многодневных туров), «озеро» — 18 (27%), «медведи» — 8, прочие слова — 1–7.
 * Ни одно слово замера не накрывает и половины каталога, но «вулкан» без
 * предела удлинил бы ответ в чате на 24 строки к 32 найденным ближним
 * совпадением. Предел — размер страницы MCP.
 */
export const FAR_CHAT_CAP = 7;

export interface TourFilterOptions {
  activityLabel: ActivityLabel;
  /** Слаги видов отдыха: слово из них — вид отдыха, а не название места. */
  knownTypes?: readonly string[];
  /**
   * Указатель туров каталога по id (lib/kuzmich/core, loadTourCatalogEntries) —
   * из той же записи кэша, что и текст. Обязателен: по строке каталога фильтр
   * не ищет.
   */
  entries: ReadonlyMap<string, TourMatchEntry>;
  /**
   * Сколько туров блока (в) показать; остальные — строкой «ещё M» со ссылкой
   * на страницы. Без числа — все (MCP и запрос страницы: там режут страницы).
   */
  farCap?: number;
}

const tourId = (line: string) => line.match(/^ID(\d+):/)?.[1] ?? '';

export function filterTourCatalog(ctx: string, want: string, opts: TourFilterOptions): string {
  const { activityLabel, entries, farCap } = opts;
  const knownTypes = opts.knownTypes ?? Object.keys(ACTIVITY_LABELS);
  const lines = ctx.split('\n');
  const isTourLine = (l: string) => /^ID\d+:/.test(l);
  const firstTour = lines.findIndex(isTourLine);
  let lastTour = -1;
  lines.forEach((l, i) => { if (isTourLine(l)) lastTour = i; });
  const head = firstTour >= 0 ? lines.slice(0, firstTour) : lines;
  const tail = lastTour >= 0 ? lines.slice(lastTour + 1) : [];
  const tours = lines.filter(isTourLine);

  const query = parseTourQuery(want);
  // «туры», «tours»: им назван весь каталог — ответ и есть каталог, а не
  // «нет» с каталогом «для замены» (все туры — туры).
  if (onlyGenericTourWords(query)) {
    return [`«${want}» — общее слово: вида отдыха или места в нём нет, и фильтр по нему не сужает — ниже весь каталог.`, ...lines].join('\n');
  }
  const searchable = tourTextSearchable(query);
  const manyWords = query.needles.length > 1;
  const byType: string[] = [];
  const near: string[] = [];
  const far: string[] = [];
  let unindexed = 0;
  for (const l of tours) {
    if (typeMatches(l.match(/тип:(\S+)/)?.[1] ?? '', want, activityLabel)) { byType.push(l); continue; }
    if (!searchable) continue;
    const entry = entries.get(tourId(l));
    if (!entry) { unindexed += 1; continue; }
    const m = matchTour(entry, query);
    if (m === 'near') near.push(l);
    else if (m === 'far') far.push(l);
  }

  // Чего не искали — сказано словами (§4.0): «не искал» не равно «нет».
  const notSearched = !searchable
    ? `По текстам туров «${want}» не искал: ${query.english.length > 0
      ? `для ${query.english.map((w) => `«${w}»`).join(', ')} в словаре платформы нет русской основы, по которой искать, а тексты туров русские — повтори get_tours по-русски`
      : 'в запросе нет слова от четырёх букв'}.`
    : '';
  const unindexedNote = unindexed > 0 ? `У ${unindexed} туров указателя текстов нет — у них проверен только вид отдыха.` : '';
  // Что искалось вместо английского и что не искалось вовсе — в ответе, а не
  // молча: «day tour» искал «однодневн…», а не «дн…» с «тур…» (ревью 29.10).
  const translatedNote = searchable && query.translated.length > 0
    ? `Английские слова искались по словарю платформы: ${query.translated.map((t) => `${t.from} → ${t.to.map((x) => `«${x}»`).join(' или ')}`).join('; ')}.`
    : '';
  const genericNote = searchable && query.generic.length > 0
    ? `${query.generic.map((w) => `«${w}»`).join(', ')} — общее слово каталога, по нему не сужал.`
    : '';
  const notes = [notSearched, unindexedNote, translatedNote, genericNote, searchable ? NO_SELLER_NAMES : ''].filter(Boolean);

  // У запроса из нескольких слов (в) значит «все слова есть в туре, каждое
  // отдельно, и не все — в ближних полях»: «фраза есть в описании» была бы
  // неправдой (ревью 29.10: «Край Вулканов» — «край» в названии, «вулканы» в
  // описании, фразы нет ни у одного тура).
  const farNote = manyWords
    ? `Слова «${want}» есть в этих турах по отдельности, не фразой, и не все — ${NEAR_FIELDS}: часть ${FAR_BLOCK_MARK} — `
      + 'занятие это, вид по пути или предупреждение, не проверено; get_tour_details прежде чем предлагать:'
    : `Слово «${want}» есть ${FAR_BLOCK_MARK} этих туров — занятие это, вид по пути или предупреждение, не проверено; get_tour_details прежде чем предлагать:`;
  const farShown = farCap != null && far.length > farCap ? far.slice(0, farCap) : far;
  const farRest = far.length - farShown.length;
  const farBlock = far.length === 0 ? [] : [
    farNote,
    ...farShown,
    ...(farRest > 0 ? [`(Ещё ${farRest} таких туров — get_tours с тем же activity_type и page=1 покажет все по страницам.)`] : []),
  ];
  // То же и в (б): «упоминается «край вулканов»» при «Камчатского края» в
  // одном месте и «вулканы» в другом было бы неправдой о фразе (замер 29.10).
  const apart = manyWords ? ' — слова каждое отдельно, не обязательно фразой' : '';
  const mentionedNote = `Упоминают «${want}» ${NEAR_FIELDS}${apart} — тип у них другой, уточни через get_tour_details, прежде чем предлагать:`;
  const isActivity = knownTypes.some((t) => typeMatches(t, want, activityLabel));

  if (byType.length > 0) {
    return [
      ...head,
      ...notes,
      ...byType,
      ...(near.length > 0 ? ['', `Ещё ${mentionedNote.charAt(0).toLowerCase()}${mentionedNote.slice(1)}`, ...near] : []),
      ...(farBlock.length > 0 ? ['', ...farBlock] : []),
      ...tail,
    ].join('\n');
  }
  if (near.length > 0) {
    const nearBlock = isActivity
      ? [mentionedNote, ...near]
      : [`Туры, где упоминается «${want}» (${NEAR_FIELDS})${apart}. Назови их; `
          + 'едет ли тур к самому месту и что там делают, уточни через get_tour_details:', ...near];
    return [
      // Вид отдыха без туров этого вида — первой строкой: «дайвинг» есть как
      // тип, туров такого типа нет. У названия места отрицания впереди нет.
      ...(isActivity ? [`Тура с типом «${want}» нет.`] : []),
      ...head,
      ...notes,
      // Пустая строка отделяет пояснение (б) от шапки: страницы повторяют
      // шапку на каждой странице, а пояснение — только там, где его туры
      // (ревью 29.10: «Назови их» висело над страницей одних «не проверено»).
      '',
      ...nearBlock,
      ...(farBlock.length > 0 ? ['', ...farBlock] : []),
      ...tail,
    ].join('\n');
  }
  if (far.length > 0) {
    return [
      manyWords
        ? `${isActivity ? `Тура с типом «${want}» нет; н` : 'Н'}и у одного тура все слова «${want}» не стоят ${NEAR_FIELDS.replace(' тура', '')}.`
        : `${isActivity ? `Тура с типом «${want}» нет; в` : 'В'} названии, месте и кратком описании туров «${want}» нет.`,
      ...head,
      ...notes,
      ...farBlock,
      ...tail,
    ].join('\n');
  }
  if (!searchable) {
    return `Тура с типом «${want}» нет. ${notSearched} Не выдавай другие туры за такие. ${CATALOG_AS_SUBSTITUTE}\n${ctx}`;
  }
  // Ответ «нет» перечисляет ровно то, где искали, и чего не искали вовсе.
  return `Туров «${want}» у операторов платформы сейчас нет — ни по типу, ни в названии, месте, кратком и полном описании или программе тура.`
    + `${unindexedNote ? ` ${unindexedNote}` : ''}${translatedNote ? ` ${translatedNote}` : ''} ${NO_SELLER_NAMES} `
    + `Не выдавай другие туры за такие. ${CATALOG_AS_SUBSTITUTE}\n${ctx}`;
}

/** Туров на странице каталога (#2314: клиент MCP обрезал ответ на 11+ турах). */
export const TOURS_PAGE_SIZE = 7;

/**
 * Страница ответа get_tours. Режутся только строки туров (`IDn: ...`); шапка
 * и хвост остаются на каждой странице. Пояснение посреди списка («Ещё
 * упоминают… — тип у них другой») относится ко всем турам после него и
 * повторяется на каждой странице, где есть его туры: иначе на второй
 * странице «тип другой» читался бы как «совпал по типу». Номер за пределами
 * — сказано прямо, сколько страниц есть, а не пустой ответ.
 *
 * Пояснение ПЕРВОЙ секции стоит до первого тура, и раньше всё до первого
 * тура считалось шапкой: «Туры, где упоминается… Назови их» повторялось над
 * страницей одних туров блока «не проверено» (ревью 29.10). Теперь абзац
 * после последней пустой строки перед первым туром — пояснение первой
 * секции, а не шапка: filterTourCatalog отделяет его пустой строкой.
 *
 * 29.10 (ловушка MCP filter-coverage): одна страница шла без приписки, хотя
 * описание параметра page обещает «в конце ответа сказано, сколько страниц»
 * — ответ без строки о страницах внешний агент не отличит от обрезанного.
 * Теперь и одна страница называет себя. И проверка номера стоит ПЕРВОЙ: при
 * семи турах и меньше page=2 молча повторял первую страницу.
 */
export function paginateTourText(text: string, page: number, size: number = TOURS_PAGE_SIZE): string {
  const lines = text.split('\n');
  const isTour = (l: string) => /^ID\d+:/.test(l);
  const tourIdx = lines.map((l, i) => (isTour(l) ? i : -1)).filter((i) => i >= 0);
  const total = tourIdx.length;
  if (total === 0) return text;
  const pages = Math.ceil(total / size);
  if (page > pages) {
    return `Страницы ${page} нет: туров ${total}, страниц ${pages}. Начни с page=1.`;
  }
  if (pages === 1) return `${text}\n\nСтраница 1 из 1, туров всего ${total}. Других страниц нет.`;
  const first = tourIdx[0];
  const last = tourIdx[tourIdx.length - 1];
  const keep = new Set(tourIdx.slice((page - 1) * size, page * size));
  // Где кончается шапка: на пустой строке перед первым туром, если она есть.
  const headEnd = lines.lastIndexOf('', first);

  const out: string[] = lines.slice(0, headEnd >= 0 ? headEnd : first);
  let note: string[] = [];
  let noteShown = true;
  let inNote = false;
  for (let i = headEnd >= 0 ? headEnd : first; i <= last; i++) {
    const l = lines[i];
    if (!isTour(l)) {
      // Новая секция: пояснение копится, пока не встретим её тур. Секция без
      // туров на этой странице своё пояснение не оставляет следующей (29.10:
      // при трёх блоках «Ещё упоминают…» висел на второй странице без туров).
      if (!inNote) { note = []; inNote = true; noteShown = false; }
      note.push(l);
      continue;
    }
    inNote = false;
    if (!keep.has(i)) continue;
    if (!noteShown) { out.push(...note); noteShown = true; }
    out.push(l);
  }
  out.push(...lines.slice(last + 1));
  const next = page < pages ? ` Следующая — get_tours с page=${page + 1} (тот же activity_type).` : ' Это последняя.';
  out.push('', `Страница ${page} из ${pages}, туров всего ${total}.${next}`);
  return out.join('\n');
}

/**
 * Сколько туров каталога идёт в подсказку Кузьмича. Каталог входит в КАЖДЫЙ
 * чат, и с 75 турами (29.10: «Лагуна Экспедиция» и гид) он раздувал бы
 * подсказку вдвое. Остальные туры Кузьмич берёт инструментом get_tours.
 */
export const PROMPT_CATALOG_TOURS = 40;

/**
 * Каталог для подсказки: первые `max` туров и строка о том, сколько их всего и
 * где остальные. До 29.10 каталог резался в самом запросе (`LIMIT 40`), молча:
 * MCP get_tours отвечал «туров всего 40» при 42 на витрине, и два самых
 * дорогих тура не видел ни внешний агент, ни Кузьмич. Обрезка допустима
 * только здесь и только названной словами. Первые — по порядку витрины
 * (правило 1в, lib/tours/offer-order; оно названо в шапке каталога), а не по
 * цене: с 29.10 «первые по цене» больше не порядок каталога.
 */
export function capTourCatalog(text: string, max: number = PROMPT_CATALOG_TOURS): string {
  const lines = text.split('\n');
  const isTour = (l: string) => /^ID\d+:/.test(l);
  const tourIdx = lines.map((l, i) => (isTour(l) ? i : -1)).filter((i) => i >= 0);
  if (tourIdx.length <= max) return text;
  const lastKept = tourIdx[max - 1];
  const lastTour = tourIdx[tourIdx.length - 1];
  return [
    ...lines.slice(0, lastKept + 1),
    `(Здесь ${max} туров из ${tourIdx.length} — первые по порядку витрины (правило в шапке). Остальные ${tourIdx.length - max} — инструментом get_tours: страницы и фильтр по виду.)`,
    ...lines.slice(lastTour + 1),
  ].join('\n');
}
