/**
 * «Открой даты словами» (22.10, этап C): ЯЗЫК фразы, которую чат принимает.
 * Решение главной сессии после шестого круга ревью: фразу принимает закрытая
 * позиционная грамматика, а не эвристики «связки», «примыкание»,
 * «разделитель».
 *
 * Почему так. Круги 4, 5 и 6 нашли по blocker и около шести major, и все они
 * были связями между словами, а не самими словами: дефис вплотную
 * («весь июль-сб»), связка-поправка между группами дат («3 августа, только
 * 5 августа»), точка или скобки вокруг дней недели («весь июль. Субботы
 * тоже»), «…» внутри числа («10…12»), «за 5000» как начало названия тура.
 * Каждую дыру закрывали правилом, и правила давали новые дыры. Это ровно
 * урок #2527 (lib/safety/rescue-protocols.ts): «мешок слов» не знает порядка,
 * шаблон знает.
 *
 * Здесь только синтаксис: фраза — одна строка этого языка целиком, от
 * первого слова до последнего, или её нет. Смысл (год, прошедшие дни, тур
 * по названию, отказы с причиной) — в parse.ts. Фраза вне языка не
 * угадывается: parse.ts называет причину словами и даёт образец.
 *
 * ── Нормализация ──────────────────────────────────────────────────────────
 *
 * NFKC (полноширинные цифры — обычные), без невидимых знаков нулевой
 * ширины, нижний регистр, ё → е, все виды тире — «-». Пробелы схлопнуты.
 * Перевод строки, «…» и любой знак кроме `, . ! : - ₽` — вне языка.
 *
 * ── Язык ──────────────────────────────────────────────────────────────────
 *
 *   ФРАЗА    := [ПРИВЕТ [,|!|.]] [кузьмич [,]] ГЛАГОЛ [ВСТАВКИ] [ПРЕДМЕТ [:]]
 *               ЧАСТЬ ([,] ЧАСТЬ)* [[,] спасибо|пожалуйста] [.|!]
 *   ЧАСТЬ    := ДАТЫ | МЕСТА | ТУР | ЦЕНА — каждая не больше раза, ДАТЫ — обязательно;
 *               ТУР без «на», «тур», «для» — только первой частью
 *   ГЛАГОЛ   := открой|откройте|открыть|открывай|открывайте|добавь|добавьте
 *               |добавить|выставь|выставьте|выставить [-ка]
 *   ВСТАВКИ  := до четырёх из: мне нам пожалуйста плиз срочно сразу еще тоже
 *               также только пока — через пробел или «,»; «ещё» при МЕСТАХ —
 *               отказ (добавка или итог, не угадываем)
 *   ПРЕДМЕТ  := [новые|новую|новый] даты|дату|дата|выезды|выезд|места|место
 *               |слоты|слот|продажи|продажу|запись|набор|группу|тур
 *
 *   ДАТЫ     := [на] ГРУППА (СВЯЗЬ ГРУППА)*            СВЯЗЬ := , | и | , и
 *   ГРУППА   := [ДН_ВИН] Д (СВЯЗЬ Д)* МЕС_Р [ГОД]      3, 5 и 7 августа; субботу 3 июля
 *             | ДД.ММ (СВЯЗЬ ДД.ММ)*                   03.08 и 5.08; 3.8.2027; 2027-08-03
 *             | с|со Д [МЕС_Р [ГОД]] по Д МЕС_Р [ГОД] [включительно]
 *             | Д - Д МЕС_Р [ГОД] [включительно]        1-10 июля
 *             | Д МЕС_Р [ГОД] - Д МЕС_Р [ГОД] [включительно]   3 августа - 10 августа
 *             | с|со ДД.ММ по ДД.ММ [включительно] | ДД.ММ - ДД.ММ [включительно]
 *             | весь МЕС_И [ГОД] | МЕС_И целиком|полностью
 *             | каждый день МЕС_Р [ГОД] | все дни МЕС_Р [ГОД]
 *             | ДН МЕС_Р (СВЯЗЬ МЕС_Р)* [ГОД]          субботы июля и августа
 *             | ДН с|со Д [МЕС_Р] по Д МЕС_Р [ГОД]     сб и вс с 1 по 15 июля
 *             | ДН в|во МЕС_П (СВЯЗЬ МЕС_П)*           каждый вторник в августе
 *             | ДН с|со МЕС_Р по МЕС_И                 субботы с июля по сентябрь
 *             | по ДН_Д в|во МЕС_П (СВЯЗЬ МЕС_П)*      по субботам в июле и августе
 *             | по ДН_Д МЕС_Р (СВЯЗЬ МЕС_Р)*            по всем субботам июля
 *             | ОТРЕЗОК_С_ПО по ДН_Д | по ДН_Д ОТРЕЗОК_С_ПО   с 1 июля по 30 сентября по субботам
 *             | с|со МЕС_Р по МЕС_И по ДН_Д | по ДН_Д с|со МЕС_Р по МЕС_И
 *             | в|во МЕС_П (СВЯЗЬ МЕС_П)* по ДН_Д      в июле и августе по субботам
 *             | весь МЕС_И по ДН_Д | по ДН_Д весь МЕС_И | МЕС_И по ДН_Д
 *             | с|со ДН_Р по ДН_ВИН в|во МЕС_П         с понедельника по пятницу в июле
 *             | сегодня|завтра|послезавтра (СВЯЗЬ …)*  — только одна, без других групп
 *     Дни недели — не больше одной группы на фразу, и рядом с ней — только
 *     отдельные даты («субботы июля и 3 августа»).
 *     Седьмой ревью — в языке, но отказ с причиной (parse.ts): конец отрезка
 *     дней через «до» («с 1 до 10 июля» бывает и без 10-го) — образец с «по»;
 *     отрезок с одинаковыми концами («сб-сб», «со среды по среду», «с
 *     октября по октябрь»); дата без года, чей год по порядку дат во фразе и
 *     сам по себе разный («5 ноября и 22 октября») — «уточните год».
 *   ДН       := ЭЛЕМ (СВЯЗЬ ЭЛЕМ)* | КР - КР          пн-пт, сб и вс, выходные и вторники
 *   ЭЛЕМ     := [все|каждые] субботы… | выходные [дни] | будни | будние дни
 *             | каждый понедельник|вторник|четверг | каждую среду|пятницу|субботу
 *             | каждое воскресенье | каждый будний день | КР
 *   ДН_Д     := [всем] субботам… (СВЯЗЬ [всем] …)*     по выходным и вторникам
 *   Д        := 1…31 [-го|го|е|ое|ого|й]               ГОД := 2000…2099 [года|году|г]
 *
 *   МЕСТА    := [на|по|до] N мест|места|место|человек|чел
 *               [на каждую дату|на каждый выезд|на каждый день|на дату|на выезд]
 *             | мест : N
 *   ЦЕНА     := [по|за|от] N ₽|руб|рублей|рубля|рубль|р|тыс|тысяч|тысячи|тысяча
 *             | [по|за|от] Nк
 *   ТУР      := на|тур|для ЦЕПОЧКА | ЦЕПОЧКА — сразу после ПРЕДМЕТА «тур» это
 *               тоже «тур ЦЕПОЧКА». Название, начатое словом даты или отношения
 *               к ней («Выходные на Авачинском», «Субботы на Халактыре»,
 *               «Каждый день на вулкане»), — только после «тур»; голое и после
 *               «на», «для» — отказ (оно съело бы дни недели фразы)
 *   ЦЕПОЧКА  := слова подряд — название тура целиком или его непрерывный
 *               кусок: первое слово называет (не дата, не «после», не
 *               «неделю»), последнее — слово, а не число и не предлог;
 *               слово отличается от названия только окончанием («Горелого»,
 *               «Быструю»), не суффиксом («вечером» — не «Вечерняя»).
 *               Решает parse.ts по турам партнёра; два разных смысла одной
 *               фразы — «не по образцу».
 *
 * Дефис принят только внутри «Д - Д», «ДД.ММ - ДД.ММ», «Д МЕС - Д МЕС»,
 * «КР-КР», «открой-ка» и в цепочке тура там, где он есть в названии;
 * вплотную к чему-то ещё («июль-сб») — вне языка.
 * Между группами дат — только «,», «и», «, и»: «только», «давай», «на»,
 * точка — вне языка. Точка или «!» — только в конце.
 *
 * Сторож: tests/unit/chat-open-dates-grammar.test.ts — каждая форма языка
 * даёт предложение, снимок списков ниже, все фразы ревьюеров кругов 4–7,
 * вставка в любое место, сверка с прежним разбором и таблица цены.
 */

/** Закрытые списки языка. Правка любого — видимая: сторож держит их снимком. */
export const LANGUAGE = {
  greetings: ['привет', 'здравствуйте', 'добрый день', 'добрый вечер', 'доброе утро'],
  address: ['кузьмич'],
  verbs: ['открой', 'откройте', 'открыть', 'открывай', 'открывайте', 'добавь', 'добавьте', 'добавить', 'выставь', 'выставьте', 'выставить'],
  fillers: ['мне', 'нам', 'пожалуйста', 'плиз', 'срочно', 'сразу', 'еще', 'тоже', 'также', 'только', 'пока'],
  objectNew: ['новые', 'новую', 'новый'],
  objects: ['даты', 'дату', 'дата', 'выезды', 'выезд', 'места', 'место', 'слоты', 'слот', 'продажи', 'продажу', 'запись', 'набор', 'группу', 'тур'],
  tail: ['спасибо', 'пожалуйста'],
  monthGen: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  monthAbbr: { янв: 1, фев: 2, февр: 2, мар: 3, апр: 4, авг: 8, сен: 9, сент: 9, окт: 10, ноя: 11, нояб: 11, дек: 12 } as Record<string, number>,
  monthNom: ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'],
  monthPrep: ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'],
  /** Дни недели: 0 = пн … 6 = вс. */
  weekdayPlural: ['понедельники', 'вторники', 'среды', 'четверги', 'пятницы', 'субботы', 'воскресенья'],
  weekdayDative: ['понедельникам', 'вторникам', 'средам', 'четвергам', 'пятницам', 'субботам', 'воскресеньям'],
  weekdayAcc: ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'],
  weekdayGen: ['понедельника', 'вторника', 'среды', 'четверга', 'пятницы', 'субботы', 'воскресенья'],
  weekdayAbbr: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'],
  /** «каждый вторник», «каждую субботу», «каждое воскресенье» — род слова дня. */
  weekdayEvery: { каждый: [0, 1, 3], каждую: [2, 4, 5], каждое: [6] } as Record<string, number[]>,
  relative: ['сегодня', 'завтра', 'послезавтра'],
  seatUnits: ['мест', 'места', 'место', 'человек', 'чел'],
  priceUnits: ['руб', 'рублей', 'рубля', 'рубль', 'р', 'тыс', 'тысяч', 'тысячи', 'тысяча'],
  tourSlots: ['на', 'тур', 'для'],
} as const;

const L = LANGUAGE;

export type LTok =
  | { k: 'w'; w: string; sp: boolean }
  | { k: 'n'; v: number; raw: string; digits: number; grouped: boolean; suffix: boolean; sp: boolean }
  | { k: 'dm'; d: number; m: number; y: number | null; raw: string; sp: boolean }
  | { k: 'p'; p: string; sp: boolean };

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const DASHES = /[‐-―]/g;

/** Фраза в NFKC без невидимых знаков, с регистром — для разбора и для диагноста. */
export function languageSource(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '');
}

/** Нормальная форма фразы языка (шапка, «Нормализация»). */
export function languageText(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '').toLowerCase().replace(/ё/g, 'е')
    .replace(DASHES, '-').replace(/[ \t ]+/g, ' ').trim();
}

/** «…» и «..» — не точка: «10…12» не 10 декабря (шестой ревью). */
export function hasEllipsis(text: string): boolean {
  return /\.\.|…/u.test(text.normalize('NFKC'));
}

const TOKEN = new RegExp([
  '(\\d{4})-(\\d{1,2})-(\\d{1,2})(?![\\d])', // 1-3: 2027-08-03
  '(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?(?![\\d]|\\.\\d)', // 4-6: 03.08, 3.8.2027
  '(\\d{1,3}(?: \\d{3})+)(?![\\d])', // 7: 15 000
  '(\\d{1,2})-?(?:го|ого|ое|е|й)(?![\\p{L}\\d])', // 8: 3-го, 10е
  '(\\d+)', // 9
  '([а-я]+)', // 10
  '( )', // 11
  '([\\s\\S])', // 12
].join('|'), 'gu');
const PUNCT = new Set([',', '.', '!', ':', '-', '₽']);

/** Лексемы фразы языка; null — знак вне алфавита (перевод строки, латиница, «(», «…»). */
export function languageTokens(text: string): LTok[] | null {
  const t = languageText(text);
  const out: LTok[] = [];
  let sp = false;
  for (const m of t.matchAll(TOKEN)) {
    if (m[11] !== undefined) { sp = true; continue; }
    if (m[1] !== undefined) {
      out.push({ k: 'dm', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]), raw: m[0], sp });
    } else if (m[4] !== undefined) {
      const y = m[6] === undefined ? null : m[6].length === 2 ? 2000 + Number(m[6]) : Number(m[6]);
      out.push({ k: 'dm', d: Number(m[4]), m: Number(m[5]), y, raw: m[0], sp });
    } else if (m[7] !== undefined) {
      const digits = m[7].replace(/ /g, '');
      out.push({ k: 'n', v: Number(digits), raw: m[7], digits: digits.length, grouped: true, suffix: false, sp });
    } else if (m[8] !== undefined) {
      out.push({ k: 'n', v: Number(m[8]), raw: m[0], digits: m[8].length, grouped: false, suffix: true, sp });
    } else if (m[9] !== undefined) {
      out.push({ k: 'n', v: Number(m[9]), raw: m[9], digits: m[9].length, grouped: false, suffix: false, sp });
    } else if (m[10] !== undefined) {
      out.push({ k: 'w', w: m[10], sp });
    } else if (PUNCT.has(m[12]!)) {
      out.push({ k: 'p', p: m[12]!, sp });
    } else {
      return null;
    }
    sp = false;
  }
  return out;
}

// ── Разбор ────────────────────────────────────────────────────────────────

/** Дата, названная днём: месяц и год — если названы. */
export interface LPoint { d: number; m: number; y: number | null; raw: string }
/**
 * Дни недели группы: 0 = пн … 6 = вс; `named` — «выходные», «будни»
 * (праздники не учтены); `same` — отрезок дней с одинаковыми концами
 * («сб-сб», «со среды по среду»): что открыть, не сказано.
 */
export interface LWd { days: number[]; named: boolean; same?: boolean }
export type LGroup =
  /** Отдельные даты; `check` — день недели, названный при единственной дате («субботу 3 июля»). */
  | { k: 'days'; points: LPoint[]; check: number | null }
  /** `until` — конец назван через «до» (бывает и невключительно). */
  | { k: 'span'; from: LPoint; to: LPoint; fromInherited: boolean; wd: LWd | null; until: boolean }
  /**
   * Месяцы целиком (или с днями недели). `range` — «с июля по сентябрь»:
   * год идёт по порядку; перечень («июля и августа») — каждый месяц сверяется.
   * `same` — «с октября по октябрь».
   */
  | { k: 'months'; months: Array<{ m: number; y: number | null }>; wd: LWd | null; range: boolean; same: boolean }
  | { k: 'rel'; offsets: number[]; words: string[] };
export interface LParse {
  groups: LGroup[];
  seats: number | null;
  price: boolean;
  /** Цепочка тура и слово перед ней («на», «тур», «для»; null — без него, первой частью). */
  tour: { words: string[]; slot: string | null } | null;
  /** Вставки после глагола («ещё», «только»…): «ещё» при местах — добавка или итог (седьмой ревью, m1). */
  fillers: string[];
}

type R<T> = Array<[number, T]>;
type P<T> = (i: number) => R<T>;

/** Предел перебора: длиннее — вне языка (фраза из чата, а не документ). */
const MAX_TOKENS = 60;

/**
 * Все разборы фразы языком; пусто — фраза вне языка. `chainOk` — может ли
 * цепочка слов быть туром партнёра (судит parse.ts по названиям).
 */
export function languageParses(text: string, chainOk: (words: string[]) => boolean): LParse[] {
  const toks = languageTokens(text);
  if (!toks || toks.length === 0 || toks.length > MAX_TOKENS) return [];
  return parsePhrase(toks, chainOk);
}

function parsePhrase(toks: LTok[], chainOk: (words: string[]) => boolean): LParse[] {
  const w = (i: number): string | null => { const x = toks[i]; return x && x.k === 'w' ? x.w : null; };
  const isP = (i: number, p: string): boolean => { const x = toks[i]; return !!x && x.k === 'p' && x.p === p; };
  const one = (list: readonly string[]): P<string> => (i) => { const x = w(i); return x !== null && list.includes(x) ? [[i + 1, x]] : []; };
  const lit = (word: string): P<string> => one([word]);
  const pun = (p: string): P<string> => (i) => (isP(i, p) ? [[i + 1, p]] : []);
  const opt = <T>(p: P<T>): P<T | null> => (i) => [[i, null] as [number, T | null], ...p(i)];
  const bind = <A, B>(p: P<A>, f: (a: A, j: number) => R<B>): P<B> => (i) => p(i).flatMap(([j, a]) => f(a, j));
  const alt = <T>(...ps: Array<P<T>>): P<T> => (i) => ps.flatMap((p) => p(i));
  /** Список через «,», «и», «, и». */
  const SEP: P<null> = (i) => {
    const out: R<null> = [];
    if (isP(i, ',')) { out.push([i + 1, null]); if (w(i + 1) === 'и') out.push([i + 2, null]); }
    if (w(i) === 'и') out.push([i + 1, null]);
    return out;
  };
  const listOf = <T>(item: P<T>): P<T[]> => (i) => {
    const out: R<T[]> = [];
    const go = (j: number, acc: T[]): void => {
      for (const [k, v] of item(j)) {
        const next = [...acc, v];
        out.push([k, next]);
        for (const [s] of SEP(k)) go(s, next);
      }
    };
    go(i, []);
    return out;
  };
  /** Дефис вплотную или через пробелы — внутри отрезка. */
  const DASH = pun('-');

  // ── Числа, месяцы, дни недели ──
  const DAY: P<{ d: number; raw: string }> = (i) => {
    const x = toks[i];
    return x && x.k === 'n' && !x.grouped && x.digits <= 2 && x.v >= 1 && x.v <= 31 ? [[i + 1, { d: x.v, raw: x.raw }]] : [];
  };
  const NUM: P<number> = (i) => {
    const x = toks[i];
    return x && x.k === 'n' && !x.suffix ? [[i + 1, x.v]] : [];
  };
  const YEAR: P<number> = (i) => {
    const x = toks[i];
    if (!x || x.k !== 'n' || x.suffix || x.grouped || x.digits !== 4 || x.v < 2000 || x.v > 2099) return [];
    const out: R<number> = [[i + 1, x.v]];
    if (['года', 'году', 'г'].includes(w(i + 1) ?? '')) out.push([i + 2, x.v]);
    return out;
  };
  const DM: P<LPoint> = (i) => {
    const x = toks[i];
    return x && x.k === 'dm' ? [[i + 1, { d: x.d, m: x.m, y: x.y, raw: x.raw }]] : [];
  };
  const MON_GEN: P<number> = (i) => {
    const x = w(i);
    if (x === null) return [];
    const g = (L.monthGen as readonly string[]).indexOf(x);
    if (g >= 0) return [[i + 1, g + 1]];
    const a = L.monthAbbr[x];
    return a ? [[i + 1, a]] : [];
  };
  const fromList = (list: readonly string[]): P<number> => (i) => {
    const x = w(i);
    const n = x === null ? -1 : list.indexOf(x);
    return n >= 0 ? [[i + 1, n + 1]] : [];
  };
  const MON_NOM = fromList(L.monthNom);
  const MON_PREP = fromList(L.monthPrep);
  const yearOpt = opt(YEAR);
  const monthWithYear: P<{ m: number; y: number | null }> = bind(MON_GEN, (m, j) => yearOpt(j).map(([k, y]) => [k, { m, y }]));
  const monthsGen: P<number[]> = listOf(MON_GEN);
  const monthsPrep: P<number[]> = listOf(MON_PREP);
  const inclusive = (j: number): number[] => (w(j) === 'включительно' ? [j, j + 1] : [j]);

  const wdIndex = (list: readonly string[]): P<number> => (i) => {
    const x = w(i);
    const n = x === null ? -1 : list.indexOf(x);
    return n >= 0 ? [[i + 1, n]] : [];
  };
  const ABBR = wdIndex(L.weekdayAbbr);
  const ALL = [0, 1, 2, 3, 4, 5, 6];
  const range = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let d = a; ; d = (d + 1) % 7) { out.push(d); if (d === b || out.length === 7) break; }
    return out;
  };
  /** Элемент группы дней недели (шапка, ЭЛЕМ). */
  const ELEM: P<LWd> = (i) => {
    const out: R<LWd> = [];
    const x = w(i);
    const q = x === 'все' || x === 'каждые' ? 1 : 0;
    const y = w(i + q);
    const pl = y === null ? -1 : (L.weekdayPlural as readonly string[]).indexOf(y);
    if (pl >= 0) out.push([i + q + 1, { days: [pl], named: false }]);
    if (y === 'выходные') {
      out.push([i + q + 1, { days: [5, 6], named: true }]);
      if (w(i + q + 1) === 'дни') out.push([i + q + 2, { days: [5, 6], named: true }]);
    }
    if (y === 'будни') out.push([i + q + 1, { days: [0, 1, 2, 3, 4], named: true }]);
    if (y === 'будние' && w(i + q + 1) === 'дни') out.push([i + q + 2, { days: [0, 1, 2, 3, 4], named: true }]);
    if (x !== null && L.weekdayEvery[x]) {
      const z = w(i + 1);
      const acc = z === null ? -1 : (L.weekdayAcc as readonly string[]).indexOf(z);
      if (acc >= 0 && L.weekdayEvery[x]!.includes(acc)) out.push([i + 2, { days: [acc], named: false }]);
      if (x === 'каждый' && z === 'будний' && w(i + 2) === 'день') out.push([i + 3, { days: [0, 1, 2, 3, 4], named: true }]);
    }
    for (const [j, d] of ABBR(i)) out.push([j, { days: [d], named: false }]);
    return out;
  };
  const merge = (ws: LWd[]): LWd => ({
    days: ALL.filter((d) => ws.some((x) => x.days.includes(d))), named: ws.some((x) => x.named),
  });
  const WD: P<LWd> = alt(
    bind(listOf(ELEM), (ws, j) => [[j, merge(ws)]]),
    bind(ABBR, (a, j) => bind(DASH, (_, k) => bind(ABBR, (b, l) =>
      [[l, { days: range(a, b).sort((x, y) => x - y), named: false, same: a === b }]])(k))(j)),
  );
  const DAT_ITEM: P<LWd> = (i) => {
    const q = w(i) === 'всем' ? 1 : 0;
    const y = w(i + q);
    const n = y === null ? -1 : (L.weekdayDative as readonly string[]).indexOf(y);
    if (n >= 0) return [[i + q + 1, { days: [n], named: false }]];
    if (y === 'выходным') return [[i + q + 1, { days: [5, 6], named: true }]];
    if (y === 'будням') return [[i + q + 1, { days: [0, 1, 2, 3, 4], named: true }]];
    return [];
  };
  const WD_DAT: P<LWd> = bind(listOf(DAT_ITEM), (ws, j) => [[j, merge(ws)]]);
  const FROM = one(['с', 'со']);
  /** Конец отрезка дней: «по» или «до» (у «до» — отказ с образцом «по», в parse.ts). */
  const TO = one(['по', 'до']);
  /** Конец отрезка месяцев и дней недели — только «по». */
  const TO_PO = lit('по');
  const IN = one(['в', 'во']);

  // ── Группы дат ──
  const days = (pts: Array<{ d: number; raw: string }>, m: number, y: number | null): LPoint[] =>
    pts.map((p) => ({ d: p.d, m, y, raw: p.raw }));
  const G_DAYS: P<LGroup> = alt(
    bind(listOf(DAY), (ds, j) => monthWithYear(j).map(([k, my]) => [k, { k: 'days', points: days(ds, my.m, my.y), check: null } as LGroup])),
    bind(wdIndex(L.weekdayAcc), (wd, j) => bind(DAY, (dd, k) => monthWithYear(k).map(([l, my]) =>
      [l, { k: 'days', points: days([dd], my.m, my.y), check: wd } as LGroup]))(j)),
  );
  const G_DM: P<LGroup> = bind(listOf(DM), (pts, j) => [[j, { k: 'days', points: pts, check: null }]]);
  const span = (from: LPoint, to: LPoint, inherited: boolean, wd: LWd | null, until = false): LGroup =>
    ({ k: 'span', from, to, fromInherited: inherited, wd, until });
  /** с|со Д [МЕС_Р [ГОД]] по|до Д МЕС_Р [ГОД] [включительно] — `wd` задаёт обёртка. */
  const spanFromTo = (wd: LWd | null): P<LGroup> => bind(FROM, (_, j) => bind(DAY, (a, k) => {
    const heads: R<{ m: number | null; y: number | null }> = [[k, { m: null, y: null }], ...monthWithYear(k)];
    return heads.flatMap(([l, am]) => bind(TO, (till, n) => bind(DAY, (b, o) => monthWithYear(o).flatMap(([q, bm]) =>
      inclusive(q).map((r) => [r, span(
        { d: a.d, m: am.m ?? bm.m, y: am.m === null ? null : am.y, raw: a.raw }, { d: b.d, m: bm.m, y: bm.y, raw: b.raw },
        am.m === null, wd, till === 'до',
      )] as [number, LGroup])))(n))(l));
  })(j));
  const G_SPAN: P<LGroup> = alt(
    spanFromTo(null),
    bind(DAY, (a, j) => bind(DASH, (_, k) => bind(DAY, (b, l) => monthWithYear(l).flatMap(([n, bm]) =>
      inclusive(n).map((o) => [o, span({ d: a.d, m: bm.m, y: null, raw: a.raw }, { d: b.d, m: bm.m, y: bm.y, raw: b.raw }, true, null)] as [number, LGroup])))(k))(j)),
    bind(DAY, (a, j) => bind(monthWithYear, (am, k) => bind(DASH, (_, l) => bind(DAY, (b, n) => monthWithYear(n).flatMap(([o, bm]) =>
      inclusive(o).map((q) => [q, span({ d: a.d, m: am.m, y: am.y, raw: a.raw }, { d: b.d, m: bm.m, y: bm.y, raw: b.raw }, false, null)] as [number, LGroup])))(l))(k))(j)),
    bind(FROM, (_, j) => bind(DM, (a, k) => bind(TO, (till, l) => bind(DM, (b, n) =>
      inclusive(n).map((o) => [o, span(a, b, false, null, till === 'до')] as [number, LGroup]))(l))(k))(j)),
    bind(DM, (a, j) => bind(DASH, (_, k) => bind(DM, (b, l) => inclusive(l).map((n) => [n, span(a, b, false, null)] as [number, LGroup]))(k))(j)),
  );
  const monthsGroup = (ms: number[], y: number | null, wd: LWd | null, range = false, same = false): LGroup =>
    ({ k: 'months', months: ms.map((m, n) => ({ m, y: n === ms.length - 1 ? y : null })), wd, range, same });
  /** «с июля по сентябрь»: месяцы подряд, год — по порядку; «с октября по октябрь» — `same`. */
  const monthRange = (a: number, b: number, wd: LWd): LGroup => monthsGroup(monthSpan(a, b), null, wd, true, a === b);
  const G_WHOLE: P<LGroup> = alt(
    bind(lit('весь'), (_, j) => bind(MON_NOM, (m, k) => yearOpt(k).map(([l, y]) => [l, monthsGroup([m], y, null)] as [number, LGroup]))(j)),
    bind(MON_NOM, (m, j) => (['целиком', 'полностью'].includes(w(j) ?? '') ? [[j + 1, monthsGroup([m], null, null)] as [number, LGroup]] : [])),
    bind(lit('каждый'), (_, j) => bind(lit('день'), (__, k) => bind(MON_GEN, (m, l) => yearOpt(l).map(([n, y]) => [n, monthsGroup([m], y, null)] as [number, LGroup]))(k))(j)),
    bind(lit('все'), (_, j) => bind(lit('дни'), (__, k) => bind(MON_GEN, (m, l) => yearOpt(l).map(([n, y]) => [n, monthsGroup([m], y, null)] as [number, LGroup]))(k))(j)),
  );
  const monthSpan = (a: number, b: number): number[] => {
    const out: number[] = [];
    for (let m = a; ; m = (m % 12) + 1) { out.push(m); if (m === b || out.length === 12) break; }
    return out;
  };
  const G_WEEKDAY: P<LGroup> = alt(
    // ДН МЕС_Р (СВЯЗЬ МЕС_Р)* [ГОД]
    bind(WD, (wd, j) => bind(monthsGen, (ms, k) => yearOpt(k).flatMap(([l, y]) =>
      (y !== null && ms.length > 1 ? [] : [[l, monthsGroup(ms, y, wd)] as [number, LGroup]])))(j)),
    // ДН с|со Д [МЕС_Р] по|до Д МЕС_Р [ГОД]
    bind(WD, (wd, j) => spanFromTo(wd)(j)),
    // ДН в|во МЕС_П (СВЯЗЬ МЕС_П)*
    bind(WD, (wd, j) => bind(IN, (_, k) => bind(monthsPrep, (ms, l) => [[l, monthsGroup(ms, null, wd)] as [number, LGroup]])(k))(j)),
    // ДН с|со МЕС_Р по|до МЕС_И
    bind(WD, (wd, j) => bind(FROM, (_, k) => bind(MON_GEN, (a, l) => bind(TO_PO, (__, n) => bind(MON_NOM, (b, o) =>
      [[o, monthRange(a, b, wd)] as [number, LGroup]])(n))(l))(k))(j)),
    // по ДН_Д в|во МЕС_П (СВЯЗЬ МЕС_П)*
    bind(lit('по'), (_, j) => bind(WD_DAT, (wd, k) => bind(IN, (__, l) => bind(monthsPrep, (ms, n) =>
      [[n, monthsGroup(ms, null, wd)] as [number, LGroup]])(l))(k))(j)),
    // в|во МЕС_П (СВЯЗЬ МЕС_П)* по ДН_Д
    bind(IN, (_, j) => bind(monthsPrep, (ms, k) => bind(lit('по'), (__, l) => bind(WD_DAT, (wd, n) =>
      [[n, monthsGroup(ms, null, wd)] as [number, LGroup]])(l))(k))(j)),
    // весь МЕС_И по ДН_Д | по ДН_Д весь МЕС_И | МЕС_И по ДН_Д
    bind(lit('весь'), (_, j) => bind(MON_NOM, (m, k) => bind(lit('по'), (__, l) => bind(WD_DAT, (wd, n) =>
      [[n, monthsGroup([m], null, wd)] as [number, LGroup]])(l))(k))(j)),
    bind(lit('по'), (_, j) => bind(WD_DAT, (wd, k) => bind(lit('весь'), (__, l) => bind(MON_NOM, (m, n) =>
      [[n, monthsGroup([m], null, wd)] as [number, LGroup]])(l))(k))(j)),
    bind(MON_NOM, (m, j) => bind(lit('по'), (_, k) => bind(WD_DAT, (wd, l) => [[l, monthsGroup([m], null, wd)] as [number, LGroup]])(k))(j)),
    // по ДН_Д МЕС_Р (СВЯЗЬ МЕС_Р)*
    bind(lit('по'), (_, j) => bind(WD_DAT, (wd, k) => bind(monthsGen, (ms, l) => [[l, monthsGroup(ms, null, wd)] as [number, LGroup]])(k))(j)),
    // с|со Д … по|до Д МЕС_Р по ДН_Д | по ДН_Д с|со Д … по|до Д МЕС_Р
    bind(spanFromTo(null), (g, j) => bind(lit('по'), (_, k) => bind(WD_DAT, (wd, l) => [[l, { ...g, wd } as LGroup]])(k))(j)),
    bind(lit('по'), (_, j) => bind(WD_DAT, (wd, k) => spanFromTo(wd)(k))(j)),
    // с|со МЕС_Р по|до МЕС_И по ДН_Д | по ДН_Д с|со МЕС_Р по|до МЕС_И
    bind(FROM, (_, j) => bind(MON_GEN, (a, k) => bind(TO_PO, (__, l) => bind(MON_NOM, (b, n) => bind(lit('по'), (___, o) =>
      bind(WD_DAT, (wd, q) => [[q, monthRange(a, b, wd)] as [number, LGroup]])(o))(n))(l))(k))(j)),
    bind(lit('по'), (_, j) => bind(WD_DAT, (wd, k) => bind(FROM, (__, l) => bind(MON_GEN, (a, n) => bind(TO_PO, (___, o) =>
      bind(MON_NOM, (b, q) => [[q, monthRange(a, b, wd)] as [number, LGroup]])(o))(n))(l))(k))(j)),
    // с|со ДН_Р по|до ДН_ВИН в|во МЕС_П (СВЯЗЬ МЕС_П)*
    bind(FROM, (_, j) => bind(wdIndex(L.weekdayGen), (a, k) => bind(TO_PO, (__, l) => bind(wdIndex(L.weekdayAcc), (b, n) =>
      bind(IN, (___, o) => bind(monthsPrep, (ms, q) =>
        [[q, monthsGroup(ms, null, { days: range(a, b).sort((x, y) => x - y), named: false, same: a === b })] as [number, LGroup]])(o))(n))(l))(k))(j)),
  );
  const G_REL: P<LGroup> = bind(listOf(wdIndex(L.relative)), (offs, j) =>
    [[j, { k: 'rel', offsets: offs, words: offs.map((o) => L.relative[o]!) }] as [number, LGroup]]);
  const GROUP: P<LGroup> = alt(G_DAYS, G_DM, G_SPAN, G_WHOLE, G_WEEKDAY, G_REL);
  /** Ограничения шапки: одна группа дней недели, рядом — только отдельные даты; «сегодня» — одна. */
  const groupsOk = (gs: LGroup[]): boolean => {
    if (gs.some((g) => g.k === 'rel') && gs.length > 1) return false;
    const withWd = gs.filter((g) => (g.k === 'span' || g.k === 'months') && g.wd !== null);
    if (withWd.length > 1) return false;
    if (withWd.length === 1 && gs.some((g) => g !== withWd[0] && g.k !== 'days')) return false;
    return true;
  };
  const DATES: P<LGroup[]> = bind(opt(lit('на')), (_, j) => listOf(GROUP)(j).filter(([, gs]) => groupsOk(gs)));

  // ── Места, цена, тур ──
  const SEAT_EACH: P<null> = (i) => {
    if (w(i) !== 'на') return [];
    const a = w(i + 1);
    const b = w(i + 2);
    if ((a === 'каждую' && b === 'дату') || (a === 'каждый' && (b === 'выезд' || b === 'день'))) return [[i + 3, null]];
    if (a === 'дату' || a === 'выезд') return [[i + 2, null]];
    return [];
  };
  const SEATS: P<number> = alt(
    bind(opt(one(['на', 'по', 'до'])), (_, j) => bind(NUM, (n, k) => bind(one(L.seatUnits), (__, l) =>
      [[l, n] as [number, number], ...SEAT_EACH(l).map(([o]) => [o, n] as [number, number])])(k))(j)),
    bind(lit('мест'), (_, j) => bind(pun(':'), (__, k) => NUM(k))(j)),
  );
  const PRICE: P<true> = bind(opt(one(['по', 'за', 'от'])), (_, j) => bind(NUM, (__, k) => {
    const out: R<true> = [];
    if (isP(k, '₽')) out.push([k + 1, true]);
    const x = toks[k];
    if (x && x.k === 'w' && (L.priceUnits as readonly string[]).includes(x.w)) out.push([k + 1, true]);
    if (x && x.k === 'w' && x.w === 'к' && !x.sp) out.push([k + 1, true]);
    return out;
  })(j));
  /** Цепочка: слова и числа подряд, дефис — только вплотную между словами. */
  const CHAIN: P<string[]> = (i) => {
    const out: R<string[]> = [];
    const words: string[] = [];
    for (let j = i; j < toks.length && words.length < 8; j++) {
      const x = toks[j]!;
      if (x.k === 'w' || (x.k === 'n' && !x.suffix && !x.grouped)) {
        words.push(x.k === 'w' ? x.w : x.raw);
        if (chainOk(words)) out.push([j + 1, [...words]]);
        continue;
      }
      // Дефис вплотную между словами — в цепочке; есть ли он в названии, решает `chainOk`.
      if (x.k === 'p' && x.p === '-' && !x.sp && words.length > 0 && toks[j + 1]?.k === 'w' && !toks[j + 1]!.sp) { words.push('-'); continue; }
      break;
    }
    return out;
  };
  const TOUR_SLOT: P<{ words: string[]; slot: string | null }> =
    bind(one(L.tourSlots), (slot, j) => CHAIN(j).map(([k, ws]) => [k, { words: ws, slot }]));
  const TOUR_BARE: P<{ words: string[]; slot: string | null }> = (i) => CHAIN(i).map(([k, ws]) => [k, { words: ws, slot: null }]);

  // ── Части ──
  type Part = { t: 'dates'; v: LGroup[] } | { t: 'seats'; v: number } | { t: 'price' } | { t: 'tour'; v: { words: string[]; slot: string | null } };
  const PART = (first: boolean): P<Part> => alt<Part>(
    bind(DATES, (v, j) => [[j, { t: 'dates', v }]]),
    bind(SEATS, (v, j) => [[j, { t: 'seats', v }]]),
    bind(PRICE, (_, j) => [[j, { t: 'price' }]]),
    bind(first ? alt(TOUR_SLOT, TOUR_BARE) : TOUR_SLOT, (v, j) => [[j, { t: 'tour', v }]]),
  );
  const PARTS: P<Part[]> = (i) => {
    const out: R<Part[]> = [];
    const go = (j: number, acc: Part[]): void => {
      for (const [k, part] of PART(acc.length === 0)(j)) {
        if (acc.some((a) => a.t === part.t)) continue;
        const next = [...acc, part];
        if (next.some((a) => a.t === 'dates')) out.push([k, next]);
        go(k, next);
        if (isP(k, ',')) go(k + 1, next);
      }
    };
    go(i, []);
    return out;
  };

  // ── Фраза ──
  const GREET: P<null> = (i) => {
    const a = w(i);
    const b = w(i + 1);
    let j = -1;
    if (a === 'привет' || a === 'здравствуйте') j = i + 1;
    else if ((a === 'добрый' && (b === 'день' || b === 'вечер')) || (a === 'доброе' && b === 'утро')) j = i + 2;
    if (j < 0) return [];
    return [[j, null], ...[',', '!', '.'].filter((p) => isP(j, p)).map((): [number, null] => [j + 1, null])];
  };
  const ADDR: P<null> = (i) => (w(i) === 'кузьмич' ? [[i + 1, null], ...(isP(i + 1, ',') ? [[i + 2, null] as [number, null]] : [])] : []);
  const VERB: P<null> = (i) => {
    if (!(L.verbs as readonly string[]).includes(w(i) ?? '')) return [];
    const ka = isP(i + 1, '-') && !toks[i + 1]!.sp && w(i + 2) === 'ка' && !toks[i + 2]!.sp;
    return [[ka ? i + 3 : i + 1, null]];
  };
  const FILLERS: P<string[]> = (i) => {
    const out: R<string[]> = [[i, []]];
    const go = (j: number, acc: string[]): void => {
      if (acc.length === 4) return;
      const k = isP(j, ',') ? j + 1 : j;
      const f = w(k);
      if (f === null || !(L.fillers as readonly string[]).includes(f)) return;
      const next = [...acc, f];
      out.push([k + 1, next]);
      if (isP(k + 1, ',')) out.push([k + 2, next]);
      go(k + 1, next);
    };
    go(i, []);
    return out;
  };
  /** Предмет фразы; слово — чтобы «открой тур Выходные…» называло тур после «тур». */
  const OBJECT: P<string> = (i) => {
    const j = (L.objectNew as readonly string[]).includes(w(i) ?? '') ? i + 1 : i;
    const o = w(j);
    if (o === null || !(L.objects as readonly string[]).includes(o)) return [];
    return [[j + 1, o], ...(isP(j + 1, ':') ? [[j + 2, o] as [number, string]] : [])];
  };
  const TAIL: P<null> = (i) => {
    const j = isP(i, ',') ? i + 1 : i;
    return (L.tail as readonly string[]).includes(w(j) ?? '') ? [[j + 1, null]] : [];
  };
  const END = (i: number): boolean => i === toks.length || (i === toks.length - 1 && (isP(i, '.') || isP(i, '!')));

  const results: LParse[] = [];
  const seen = new Set<string>();
  for (const [a] of opt(GREET)(0)) {
    for (const [b] of opt(ADDR)(a)) {
      for (const [c] of VERB(b)) {
        for (const [d, fillers] of FILLERS(c)) {
          for (const [e, obj] of opt(OBJECT)(d)) {
            for (const [f, parts] of PARTS(e)) {
              for (const [g] of opt(TAIL)(f)) {
                if (!END(g)) continue;
                const lp: LParse = { groups: [], seats: null, price: false, tour: null, fillers };
                for (const part of parts) {
                  if (part.t === 'dates') lp.groups = part.v;
                  else if (part.t === 'seats') lp.seats = part.v;
                  else if (part.t === 'price') lp.price = true;
                  // Цепочка первой частью сразу после предмета «тур» названа после слова «тур».
                  else lp.tour = obj === 'тур' && part === parts[0] && part.v.slot === null ? { ...part.v, slot: 'тур' } : part.v;
                }
                const key = JSON.stringify(lp);
                if (!seen.has(key)) { seen.add(key); results.push(lp); }
              }
            }
          }
        }
      }
    }
  }
  return results;
}
