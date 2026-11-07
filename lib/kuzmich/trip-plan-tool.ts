/**
 * Инструмент Кузьмича make_trip_plan («Мой план 2.0», A-2; владелец 08.08:
 * «план мне нравится, реализуем»).
 *
 * Паттерн GuideGeek (планировщик в мессенджере), доведённый до сделки:
 * Кузьмич в Telegram/MAX/вебе отвечает не советом, а планом по дням из
 * движка recommendTrip — и даёт две ссылки: публичная страница готового
 * плана (/plans/[slug], там бронь реальных туров) и живой планировщик.
 *
 * Ссылку на персональную страницу «в один клик» не рождаем сознательно:
 * user_trips.user_id NOT NULL, анонимный share потребовал бы миграцию —
 * пресетные страницы уже публичны и ведут к брони, этого достаточно для MVP.
 */

import {
  recommendTrip, parseInterestsFromText, ACTIVITY_CONSTRAINTS, ACTIVITY_NAMES, type DayPlan,
  type BudgetTier, type PriceBreakdown, type ChildBlocked,
} from '@/lib/planner';
import { PLAN_PRESETS, type PlanPreset } from '@/lib/plans/presets';
// Словарь переехал в чистый модуль без зависимостей: те же слова читает
// клиент планировщика, а сюда тянется `pool` (см. шапку interest-words).
import { INTEREST_WORDS, parseInterestWords } from '@/lib/planner/interest-words';
import { parseTravelPreferences } from '@/lib/planner/travel-style-words';
import { MAX_REST_DAYS, type TravelStyle } from '@/lib/planner/travel-style';
import { tourKeepsSchedule } from '@/lib/seat-requests/service';
import {
  applyPlanEdit, planPrice, planEstimate, type PlanEdit, type PlanParams, type RereadTour, type TouchedTour,
} from '@/lib/planner/plan-edit';
import { estimateGroup, type GroupEstimate } from '@/lib/planner/estimate';
import { priceFromUnit } from '@/lib/tours/price-label';
import { kamchatkaStamp } from '@/lib/safety/place-day-status';
import { saveDraft, loadDraft, updateDraft, isDraftId, type DraftSurface } from '@/lib/planner/plan-drafts';
import { McpUserError } from '@/lib/mcp/jsonrpc';
import { parsePlanStart, rangeDays, planStartRefusal, type PlanStart } from '@/lib/kuzmich/plan-start';
import { planOfferLines } from '@/lib/kuzmich/plan-offers';

/**
 * Как ехать — из слова модели. Принимаются и коды (self/operator/mixed), и
 * русские слова («сам», «с гидом», «вперемешку»). Не понял — undefined, то
 * есть «вперемешку», как без поля: выдумать выбор туриста нельзя.
 */
export function readTravelStyle(raw: string | undefined): TravelStyle | undefined {
  const t = (raw ?? '').trim().toLowerCase();
  if (!t) return undefined;
  if (t === 'self' || t === 'operator' || t === 'mixed') return t;
  return parseTravelPreferences(t).travelStyle ?? undefined;
}

/** Дни отдыха: целое 0..MAX_REST_DAYS, иначе поля нет. */
export function readRestDays(raw: string | undefined): number | undefined {
  const t = (raw ?? '').trim();
  if (!/^\d{1,2}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= MAX_REST_DAYS ? n : undefined;
}

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru';

/**
 * Что Кузьмич вообще умеет разобрать — то он и вправе предложить.
 *
 * Множество выводится из словаря выше, а не пишется вторым списком: слово,
 * которого Кузьмич не понимает, в совете было бы издевательством («назови
 * сплавы» → «не разобрал»), а слово, которое он понимает, но не советует,
 * молча выпадало бы из сезонной подсказки.
 */
const OFFERABLE = new Set(Object.values(INTEREST_WORDS));

const MONTH_NAME = [
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
];

/**
 * Что вообще доступно в этом месяце.
 *
 * Два свидетеля, как и у движка: сезонные окна (`ACTIVITY_CONSTRAINTS`) —
 * пол, а `catalogueOpen` — то, на что оператор реально открыл запись. Окно
 * каталогом только расширяется.
 *
 * Без второго аргумента отказ говорил бы «в октябре рыбалка не сезон» в тот
 * же час, когда план по рыбалке собирается: два голоса об одном (§10.09).
 * Замер 20.09: семь живых туров из восьми рыболовные, один из них —
 * «Осенняя рыбалка (октябрь-ноябрь)».
 */
export function inSeasonInterests(month: number, catalogueOpen: string[] | null = null): string[] {
  const fromCatalogue = new Set(catalogueOpen ?? []);
  return Object.entries(ACTIVITY_CONSTRAINTS)
    .filter(([key, c]) => (c.months.includes(month) || fromCatalogue.has(key)) && OFFERABLE.has(key))
    .map(([key]) => key);
}

/**
 * Что убрано из плана по возрасту детей — словами, с альтернативой (08.10).
 * Пусто — ничего не убирали. Строка кончается пробелом: за ней идёт причина
 * по сезону, если есть.
 */
export function childAgeLine(blocked: readonly ChildBlocked[]): string {
  if (blocked.length === 0) return '';
  const items = blocked.map((b) => {
    const alt = b.alternative ? `; альтернатива: ${b.alternative}` : '';
    return `${ACTIVITY_NAMES[b.interest] ?? b.interest} — с ${b.minAge} лет${alt}`;
  });
  return `По возрасту младшего (${blocked[0].youngest}) в план не вошло: ${items.join('; ')}. `;
}

/**
 * Текст отказа: причина, дата и то, что В СЕЗОНЕ.
 *
 * ── Что было (замер с прода 19.09) ───────────────────────────────────────
 *
 * Отказ звучал так: «Не собрал план по этим параметрам — попробуй назвать
 * интересы иначе (вулканы, рыбалка, медведи, море)». Список был вшит
 * строкой, и три слова из четырёх — ровно те, на которых план и не
 * собирается: планировщик считает поездку на `now + 30 дней`, а в октябре
 * вулканы, рыбалка и медведи уже вне сезонных окон (`ACTIVITY_CONSTRAINTS`).
 *
 * То есть совет вёл обратно в тот же отказ, а настоящая причина — месяц —
 * не называлась ни словом. Проверено на проде: те же десять дней «море» →
 * план, «рыбалка» → отказ.
 *
 * Список теперь СЧИТАЕТСЯ из сезонных окон, а не пишется руками: вшитый
 * перечень устаревает молча вместе со сменой месяца.
 */
export function buildRefusal(
  month: number, asked: string[], site: string,
  catalogueOpen: string[] | null = null,
  /** Убранное по возрасту младшего ребёнка (решение владельца 08.10). */
  childBlocked: readonly ChildBlocked[] = [],
): string {
  const open = inSeasonInterests(month, catalogueOpen);
  const byAge = new Set(childBlocked.map((b) => b.interest));
  const closed = asked.filter((k) => !open.includes(k) && !byAge.has(k));

  const monthWord = MONTH_NAME[month - 1] ?? 'этом месяце';
  const openWords = open.map((k) => ACTIVITY_NAMES[k]).filter(Boolean).join(', ');

  const ageLine = childAgeLine(childBlocked);
  const why = closed.length > 0
    ? `${ageLine}В ${monthWord} это уже не сезон: ${closed.map((k) => ACTIVITY_NAMES[k] ?? k).join(', ')}.`
    : ageLine
      ? ageLine.trimEnd()
      : `В ${monthWord} по этим интересам план не сложился.`;

  return `${why} Что идёт в ${monthWord}: ${openWords || 'по нашим данным — ничего, и это похоже на пробел в данных, а не на правду о Камчатке'}. `
    + `Живой планировщик, там можно задать свои даты: ${site}/planner`;
}

/**
 * Когда считать поездку — разбор поля `when` живёт в `lib/kuzmich/plan-start`
 * (аудит планировщика 07.11, M1 и M2): число и диапазон, несуществующая дата
 * и «не дата» — отказ без плана, «сегодня» и «через месяц» — по Камчатке.
 * Здесь реэкспорт: тем же разбором ссылку в планер строит `handoff-targets`.
 */
export { parsePlanStart, rangeDays, planStartRefusal, type PlanStart } from '@/lib/kuzmich/plan-start';

/**
 * Что сказать человеку про выбранную дату. Пусто — когда говорить нечего.
 *
 * Молча подставлять «через месяц» вместо прошедшей даты нельзя: турист
 * спросил про одно, получил план про другое и не узнал об этом. Само число
 * дня при этом всё равно называется в первой строке плана — здесь
 * объясняется ПОЧЕМУ оно такое. Отказа («не дата», «нет в календаре») здесь
 * нет: плана на него не собирается вовсе (`planStartRefusal`).
 */
export function startNote(start: Exclude<PlanStart, { kind: 'invalid' }>, plannedFor: string): string {
  return start.kind === 'past' ? `«${start.raw}» уже прошло — считаю на ${plannedFor}.` : '';
}

/** Классика первой поездки — когда интересы не разобраны. */
export const DEFAULT_PLAN_INTERESTS = ['volcano', 'bears', 'thermal'];

/** Свободный текст интересов → ключи движка. Пусто — классика первой поездки. */
export function parseChatInterests(raw: string): string[] {
  return parseChatInterestsDetailed(raw).interests;
}

/** То же, и признак «ничего не разобрано — подставлена классика». */
export function parseChatInterestsDetailed(raw: string): { interests: string[]; defaulted: boolean } {
  const text = (raw || '').toLowerCase();
  const found = new Set<string>(parseInterestWords(text));
  // parseInterestsFromText движка ловит то, что словарь не покрыл
  try {
    const parsed = parseInterestsFromText(text);
    for (const k of parsed.interests ?? []) found.add(k);
  } catch { /* словаря достаточно */ }
  if (found.size === 0) return { interests: [...DEFAULT_PLAN_INTERESTS], defaulted: true };
  return { interests: [...found], defaulted: false };
}

/**
 * Длительность из слова модели. «10 days», «10 дней» — десять: прежнее
 * Number('10 days') давало NaN и молча превращалось в семь (проверка MCP
 * 29.09). Вне 3–21 — ближайшая граница, и это говорится вслух.
 */
export function readPlanDays(raw: string | undefined): { days: number; note: string | null } {
  const m = /\d+/.exec(raw ?? '');
  if (!m) {
    return { days: 7, note: raw?.trim() ? `Длительность «${raw.trim()}» не разобрал — считаю 7 дней.` : null };
  }
  const n = Number(m[0]);
  if (n < 3) return { days: 3, note: `План собираю от 3 дней — считаю 3, а не ${n}.` };
  if (n > 21) return { days: 21, note: `План собираю до 21 дня — считаю 21, а не ${n}.` };
  return { days: n, note: null };
}

/** «10 июля» без пояса процесса: даты плана — полночь UTC, подпись — те же сутки. */
function ruDayMonth(date: Date): string {
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/**
 * Длительность плана с диапазоном в `when` (аудит 07.11, M1).
 *
 * `days` названа — она главная: у поля это и есть смысл. Не названа — длина
 * диапазона («10–17 июля» — 8 дней, считая первый и последний). Названы
 * обе и расходятся — считаю названную и говорю, сколько дней в диапазоне:
 * «10–17 июля» при days 7 — частая ошибка на единицу (ночи вместо дней), и
 * молча потерять последний день нельзя.
 */
export function readPlanDaysFor(raw: string | undefined, start: PlanStart): { days: number; note: string | null } {
  const span = rangeDays(start);
  if (span === null || start.kind !== 'parsed' || !start.end) return readPlanDays(raw);
  const bySpan = readPlanDays(String(span));
  if (!raw?.trim()) return bySpan;
  // «две недели» без числа — не длительность, а слово: даты точнее.
  if (!/\d/.test(raw)) {
    const said = `Длительность «${raw.trim()}» не разобрал — считаю по датам: ${bySpan.days} ${dayWord(bySpan.days)}.`;
    return { days: bySpan.days, note: bySpan.note ? `${said} ${bySpan.note}` : said };
  }
  const named = readPlanDays(raw);
  if (named.days === span) return named;
  const last = new Date(start.date.getTime() + (named.days - 1) * 86400000);
  const said = `Даты ${ruDayMonth(start.date)} — ${ruDayMonth(start.end)}: это ${span} ${dayWord(span)}, `
    + `а длительность — ${named.days}: считаю ${named.days} ${dayWord(named.days)}, ${ruDayMonth(start.date)} — ${ruDayMonth(last)}. `
    + `Нужны все даты — передай длительность ${span} или не передавай её.`;
  return { days: named.days, note: named.note ? `${named.note} ${said}` : said };
}

/** «день», «дня», «дней» — для чисел плана (3–21 и длины диапазона). */
function dayWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

/** Потолок группы — тот же, что у заявки на бронь (1–30 человек). */
const MAX_GROUP = 30;

/** Взрослые: целое 1..30. Не дано — двое; не разобрали — двое и сказано вслух. */
export function readAdults(raw: string | undefined): { adults: number; given: boolean; note: string | null } {
  const t = (raw ?? '').trim();
  if (!t) return { adults: 2, given: false, note: null };
  const m = /^\d{1,2}/.exec(t);
  const n = m ? Number(m[0]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_GROUP) {
    return { adults: 2, given: false, note: `Число взрослых «${t}» не разобрал (нужно 1–${MAX_GROUP}) — считаю двоих.` };
  }
  return { adults: n, given: true, note: null };
}

/**
 * Дети — разбор поля с тремя исходами (§4.0): возрасты, «детей нет», «не знаю».
 *
 * ── Что было (ловушка MCP 29.10) ─────────────────────────────────────────
 *
 * Возраст и число детей пишутся в одно поле одинаково, а разборщик не умел
 * сказать «не знаю». Голое «12» (агент имел в виду «12 детей») читалось как
 * ребёнок 12 лет — и план ставил школьной группе восхождения на Горелый и
 * Авачинский: порог «вулкан с 12» пройден. «Двое детей» и «6-10» не
 * разбирались вовсе, и ответ говорил «считаю без детей»: план собирался
 * взрослым, ни одного возрастного допуска. «12, малыш» отбрасывал как раз
 * младшего. Заметка в ответе это называла, но план с восхождениями всё равно
 * уходил.
 *
 * Теперь неразобранное — отказ, а не допущение: плана нет, пока не известен
 * возраст каждого ребёнка. Правила одни на чат и на внешнего агента:
 *  - список из двух и больше целых 0–17 — возрасты («6, 10», «6 лет и 10 лет»);
 *  - одно число со словом единицы — возраст («12 лет», «2 года», «до года»);
 *  - JSON-массив — однозначный список возрастов: [12] — ребёнок 12 лет,
 *    [0] — до года, [] — детей нет (схема сохраняет признак массива, см.
 *    agesString в tool-schemas);
 *  - одно голое число — «возраст одного ребёнка или число детей?», отказ.
 *    Угадывать по величине («до двух — возраст») нельзя: это привязка к
 *    нынешним порогам, и первая активность с порогом 2 молча её сломает;
 *  - любое другое слово («двое», «детей», «малыш», «6-10», «25», «месяцев») —
 *    отказ с этим словом, без «считаю без детей» и без частичного списка;
 *  - больше 30 возрастов — отказ (группа — до 30 человек), без обрезки;
 *  - пустой элемент списка ([""], [6, ""], «[,]») — отказ: это ребёнок без
 *    возраста, а не «детей нет» и не повод выбросить его из списка;
 *  - дробный возраст с единицей («1,5 года», «7,5 лет») — отказ: десятичная
 *    запятая иначе делит его на двух детей, 1 и 5 лет. Без единицы «6,10» —
 *    по-прежнему список.
 *
 * Одно исключение — «0» в чате туриста: там поле заполняет Кузьмич по
 * описанию «детей нет — не передавай», и «0» по-прежнему «детей нет»
 * (решение 22.10). У внешнего агента «0» — тот же вопрос, что любое голое
 * число: младенец или «детей нет»; младенец — [0] или «до года».
 *
 * Текст отказа в чате — без имён полей (их видит турист, решение 22.10), у
 * внешнего агента — с формой повтора, выполнимой и по старой схеме.
 */
export type ChildrenRead =
  | { kind: 'none'; children: number[] }
  | { kind: 'ages'; children: number[] }
  | { kind: 'unknown'; refusal: string };

/** «Детей нет» словами — однозначно, на любой поверхности. */
const NO_CHILDREN = /^(нет|-|—|без детей|детей нет|нет детей|0 детей|none|no|no children|0 children)$/i;
/** Единица возраста после числа: «6 лет», «2 года», «1 год», «10 years», «5 yo». */
const AGE_UNIT = /^(лет|год|года|годик|годика|г\.?|years?|yrs?|yo|y\.o\.?|y\/o)$/i;
/** То же слитно: «6лет», «2года», «10y». */
const AGE_WITH_UNIT = /^(\d{1,2})(лет|год|года|г\.?|y|yo|years?)$/i;
/** Связки между возрастами: «6 и 10», «6 and 10». */
const AGE_JOINER = /^(и|and|&|\+)$/i;
/**
 * Дробный возраст с единицей: «1,5 года», «7,5 лет», «1,5года», «2.5 years».
 * Одна цифра после разделителя и без пробела — «6,10 лет» остаётся списком.
 */
const FRACTIONAL_AGE = /(?<![\d.,])\d{1,2}[.,]\d(?!\d)\s*(лет|годика|годик|года|год|г\.?|years?|yrs?|yo|y\.o\.?|y\/o|y)(?![\p{L}\d])/iu;
/** Пустой элемент списка возрастов — так он назван в отказе. */
const EMPTY_AGE_ITEM = 'пустой элемент';
const MAX_CHILD_AGE = 17;

function isChildAge(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_CHILD_AGE;
}

/** Как повторить вызов — словами для поверхности; чат имён полей не называет. */
function childAgesHint(surface: DraftSurface): string {
  return surface === 'mcp'
    ? 'Повтори с возрастом каждого ребёнка: один ребёнок 12 лет — children: "12 лет" или [12]; '
      + 'двое, 6 и 10 лет — "6 лет, 10 лет" или [6, 10]; ребёнок до года — "до года" или [0]. '
      + 'Знаешь только, сколько детей, — спроси у человека возраст каждого: от возраста младшего зависят допуски активностей. '
      + 'Детей нет — не передавай поле children.'
    : 'Спроси у человека возраст каждого ребёнка и повтори с возрастами словами: «12 лет», «6 лет, 10 лет», «до года». '
      + 'От возраста младшего зависят допуски активностей. Детей нет — повтори без детей.';
}

function childrenRefusal(why: string, surface: DraftSurface): ChildrenRead {
  return { kind: 'unknown', refusal: `План не собран: ${why} ${childAgesHint(surface)}` };
}

/** Возрасты из JSON-массива (строкой «[6,10]»): каждый элемент — возраст. */
function readAgeList(inner: string, surface: DraftSurface): ChildrenRead {
  if (inner.trim() === '') return { kind: 'none', children: [] };
  // Пустой элемент не выбрасывается: [""] — ребёнок без возраста, а не
  // «детей нет», [6, ""] — двое, и младший мог остаться неназванным.
  const items = inner.split(',').map((x) => x.trim().replace(/^"|"$/g, '').trim());
  const ages: number[] = [];
  const bad: string[] = [];
  for (const item of items) {
    if (!item) {
      bad.push(EMPTY_AGE_ITEM);
      continue;
    }
    const words = item.split(/\s+/);
    const unit = words.length === 2 && AGE_UNIT.test(words[1]);
    const glued = AGE_WITH_UNIT.exec(item);
    const raw = /^до\s+(1\s+)?года?$/i.test(item) ? '0' : glued ? glued[1] : unit ? words[0] : item;
    const n = /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
    if (isChildAge(n)) ages.push(n);
    else bad.push(item);
  }
  if (bad.length > 0) {
    return childrenRefusal(`в списке возрастов детей не разобрал ${bad.map((b) => `«${b}»`).join(', ')} — нужен возраст каждого ребёнка в годах (0–${MAX_CHILD_AGE}).`, surface);
  }
  if (ages.length > MAX_GROUP) {
    return childrenRefusal(`возрастов детей ${ages.length}, а группа — не больше ${MAX_GROUP} человек.`, surface);
  }
  return { kind: 'ages', children: ages };
}

export function readChildren(raw: string | undefined, surface: DraftSurface = 'chat'): ChildrenRead {
  const t = (raw ?? '').trim();
  if (!t || NO_CHILDREN.test(t)) return { kind: 'none', children: [] };
  if (t === '0' && surface === 'chat') return { kind: 'none', children: [] };

  // До разбора на слова: «1,5 года» запятая разрезала бы на «1» и «5 года» —
  // двое детей вместо одного полуторагодовалого.
  const fractional = FRACTIONAL_AGE.exec(t);
  if (fractional) {
    const where = surface === 'mcp' ? `в children «${t}»` : `в возрасте детей «${t}»`;
    return childrenRefusal(`${where} дробный возраст «${fractional[0]}» — нужен возраст каждого ребёнка в полных годах: полтора года — «1 год», полгода — «до года».`, surface);
  }

  const list = /^\[([\s\S]*)\]$/.exec(t);
  if (list) return readAgeList(list[1], surface);

  // Слова по порядку: число, за ним может стоять единица («6 лет»), «до года»
  // — возраст 0 с единицей, связки пропускаются, остальное — неразобранное.
  const words = t.split(/[\s,;]+/).filter(Boolean);
  const ages: Array<{ n: number; unit: boolean }> = [];
  const bad: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (AGE_JOINER.test(w)) continue;
    if (/^до$/i.test(w)) {
      const one = words[i + 1] === '1' ? 1 : 0;
      if (/^года?$/i.test(words[i + 1 + one] ?? '')) {
        ages.push({ n: 0, unit: true });
        i += 1 + one;
        continue;
      }
      bad.push(w);
      continue;
    }
    const glued = AGE_WITH_UNIT.exec(w);
    if (glued && isChildAge(Number(glued[1]))) {
      ages.push({ n: Number(glued[1]), unit: true });
      continue;
    }
    const n = /^\d{1,2}$/.test(w) ? Number(w) : NaN;
    const unit = AGE_UNIT.test(words[i + 1] ?? '');
    if (!isChildAge(n)) {
      // «25 лет» — одно неразобранное, а не два: единица идёт вместе с числом.
      bad.push(unit ? `${w} ${words[i + 1]}` : w);
      if (unit) i += 1;
      continue;
    }
    ages.push({ n, unit });
    if (unit) i += 1;
  }

  if (bad.length > 0) {
    const where = surface === 'mcp' ? `в children «${t}»` : `в возрасте детей «${t}»`;
    return childrenRefusal(`${where} не разобрал ${bad.map((b) => `«${b}»`).join(', ')} — нужен возраст каждого ребёнка в годах (0–${MAX_CHILD_AGE}), а не число детей и не диапазон.`, surface);
  }
  if (ages.length === 0) {
    return childrenRefusal(surface === 'mcp' ? `в children «${t}» нет ни одного возраста.` : `в «${t}» нет ни одного возраста детей.`, surface);
  }
  if (ages.length === 1 && !ages[0].unit) {
    const n = ages[0].n;
    const question = n === 0
      ? 'это ребёнок до года или «детей нет»?'
      : `это возраст одного ребёнка (${n} ${plural(n, 'год', 'года', 'лет')}) или число детей?`;
    const where = surface === 'mcp' ? `children «${t}» — одно число без «лет»` : `«${t}» — одно число без «лет»`;
    return childrenRefusal(`${where}: ${question}`, surface);
  }
  if (ages.length > MAX_GROUP) {
    return childrenRefusal(`возрастов детей ${ages.length}, а группа — не больше ${MAX_GROUP} человек.`, surface);
  }
  return { kind: 'ages', children: ages.map((a) => a.n) };
}

// Слова жилья (#2224, «замени жильё на базу») ведут к тому же уровню, по
// которому движок считает ночь: базы, хостелы и палатки — эконом, гостиницы
// и апартаменты — комфорт, лоджи — премиум (ZONE_ACCOMMODATION).
const BUDGET_WORDS: Array<[RegExp, BudgetTier]> = [
  [/^(economy|эконом|бюджет|дешев|недорог|подешевле|минимал|баз|хостел|палат)/i, 'economy'],
  [/^(comfort|комфорт|средн|стандарт|гостиниц|отел|апартамент)/i, 'comfort'],
  [/^(premium|премиум|люкс|дорог|максимал|vip|лодж|эко-лодж)/i, 'premium'],
];

export const BUDGET_LABEL: Record<BudgetTier, string> = { economy: 'эконом', comfort: 'комфорт', premium: 'премиум' };

/** Уровень бюджета: код или русское слово. Не понял — «комфорт», и это сказано. */
export function readBudgetTier(raw: string | undefined): { tier: BudgetTier; given: boolean; note: string | null } {
  const t = (raw ?? '').trim();
  if (!t) return { tier: 'comfort', given: false, note: null };
  const word = t.replace(/^(на|в)\s+/i, '');
  for (const [re, tier] of BUDGET_WORDS) if (re.test(word)) return { tier, given: true, note: null };
  return { tier: 'comfort', given: false, note: `Уровень бюджета «${t}» не разобрал — считаю «комфорт». Можно: эконом, комфорт, премиум.` };
}

function childrenWords(ages: number[]): string {
  return ages.length === 1 ? `ребёнок ${ages[0]} лет` : `дети ${ages.join(', ')} лет`;
}

/** Возраст словами в именительном: «1 год», «2 года», «10 лет»; ноль — «до года». */
function ageWords(n: number): string {
  return n === 0 ? 'до года' : `${n} ${plural(n, 'год', 'года', 'лет')}`;
}

/**
 * Состав группы для внешнего агента (MCP и A2A): число людей и то, КАК
 * прочитано поле children.
 *
 * Живая проверка MCP 22.10: агент передал children: "2", считая это числом
 * детей; сервер прочёл «ребёнок 2 лет» и считал группу на троих вместо
 * четверых — сумма на группу вышла меньше на четверть, и из ответа это не
 * было видно. Строка теперь называет и людей числом, и прочтение поля:
 * агент, ошибившийся с полем, увидит это в ответе и пересоберёт план.
 * С 29.10 голое число до этой строки не доходит — readChildren отказывает
 * («возраст одного ребёнка или число детей?»); строка осталась для
 * разобранных возрастов, в том числе массива из одного ([2]).
 *
 * В чате туриста этой строки нет: там поле заполняет Кузьмич из слов
 * человека, и «поле children» туристу ничего не говорит.
 */
function agentGroupWords(adults: number, adultsGiven: boolean, ages: number[]): string {
  const adultsPart = `${adults} взр.${adultsGiven ? '' : ' (число взрослых не названо — допущение)'}`;
  const k = ages.length;
  return `Группа: ${adultsPart} и ${k} ${plural(k, 'ребёнок', 'ребёнка', 'детей')}, всего ${adults + k} чел.; `
    + `${k === 1 ? 'возраст ребёнка' : 'возрасты детей'}: ${ages.map(ageWords).join(', ')} `
    + '(поле children — возрасты в годах через запятую, не число детей)';
}

function adultsWords(n: number): string {
  if (n === 1) return 'одного взрослого';
  if (n === 2) return 'двоих взрослых';
  return `${n} взрослых`;
}

/**
 * Допущения, которых турист не называл, — вслух первой строкой. Движок
 * считает на двоих взрослых со средней подготовкой, и его «у вас указана
 * средняя» читалось как слова человека, который ничего не указывал.
 *
 * С #2223 состав и бюджет можно назвать. Что названо — пересказывается как
 * названное, что не названо — как допущение: «считаю на двоих» и «вас двое»
 * — разные утверждения.
 *
 * `surface` — кто читает ответ: у внешнего агента (`mcp`, через MCP и A2A)
 * строка группы называет людей числом и прочтение поля children (22.10).
 */
export function planAssumptions(p: {
  adults: number; adultsGiven: boolean; children: number[]; tier: BudgetTier; tierGiven: boolean;
}, surface: DraftSurface = 'chat'): string {
  const group = surface === 'mcp' && p.children.length > 0
    ? agentGroupWords(p.adults, p.adultsGiven, p.children)
    : p.adultsGiven || p.children.length > 0
      ? `Группа: ${[`${p.adults} взр.${p.adultsGiven ? '' : ' (число взрослых не названо — допущение)'}`, p.children.length > 0 ? childrenWords(p.children) : ''].filter(Boolean).join(', ')}`
      : `Считаю на ${adultsWords(p.adults)}`;
  const level = p.tierGiven
    ? `уровень размещения «${BUDGET_LABEL[p.tier]}»`
    : `уровень размещения «${BUDGET_LABEL[p.tier]}» (не назван — допущение)`;
  return `${group}, средняя подготовка, ${level}, только безопасные варианты — если у вас иначе, пересоберите в планировщике.`;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const range = ([a, b]: [number, number]) => (a === b ? rub(a) : `${rub(a)}–${rub(b)}`);

const plural = (n: number, one: string, few: string, many: string) =>
  (n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);

/**
 * Цена плана словами (#2223): вилка на человека и из чего она сложена.
 *
 * Сумма — `priceBreakdown` движка, своей арифметики здесь нет. Задача этой
 * функции — не дать вилке выглядеть точнее, чем она есть (§4.0): дни по цене
 * тура и дни по справочной вилке названы раздельно, туры с ценой не за
 * человека — исключены и названы, перелёт до Камчатки не входит и сказано.
 * Плана нет — цены нет (пустой массив).
 *
 * С #2304 — и итог на группу (`group`, lib/planner/estimate — та же формула,
 * что у экрана /planner). Тур с ценой за группу в вилку на человека не входит,
 * а в итог на группу входит — по своей единице цены; раньше он не входил
 * никуда, и итога на группу не было вовсе. Тур с нераспознанной единицей цены
 * не входит ни в одну сумму и назван.
 */
export function formatPlanPrice(pb: PriceBreakdown, tier: BudgetTier, planned: boolean, group?: GroupEstimate): string[] {
  if (!planned) return [];
  // `unpriced` с умолчанием: разбивка, сохранённая до #2304, его не несёт.
  const { tourPriced, estimated, excluded, unpriced = 0 } = pb.activityPricing;
  const parts: string[] = [];
  if (tourPriced > 0) parts.push(`${tourPriced} — по ценам туров операторов`);
  if (estimated > 0) parts.push(`${estimated} — по справочной вилке вида активности, это не цена тура`);
  const lines = [
    `Ориентир на человека: ${range(pb.perPersonTotal)} (уровень «${BUDGET_LABEL[tier]}»). Из чего сложено:`,
    `- активности: ${range(pb.activities)}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`,
    `- жильё: ${range(pb.accommodation)} — оценка за ночи по зоне и уровню размещения; ночи, включённые в туры, не считаны`,
    `- транспорт: ${range(pb.transport)} — трансферы и переезды по краю, оценка`,
  ];
  if (excluded > 0 && !group) {
    lines.push(`Без учёта ${excluded} ${excluded === 1 ? 'тура' : 'туров'}: цена у ${excluded === 1 ? 'него' : 'них'} не за человека (за группу или за день) — сумму смотрите в карточке тура.`);
  }
  if (unpriced > 0 && !group) {
    lines.push(`Без цены для вашей группы: ${unpriced} ${plural(unpriced, 'тур', 'тура', 'туров')} — цену называет оператор, в сумму не вошли.`);
  }
  if (group) {
    // Строки туров без суммы в смете — это туры без цены для группы
    // (`unpriced` вилки) и туры с нераспознанной единицей цены (они же в
    // `excluded`). Остальные исключённые посчитаны в итоге на группу.
    const unknownUnit = group.lines.filter((l) => l.kind === 'tour' && !l.total).length - unpriced;
    const inGroup = excluded - unknownUnit;
    if (inGroup > 0) {
      lines.push(`В вилку на человека ${plural(inGroup, 'не вошёл', 'не вошли', 'не вошли')} ${inGroup} ${plural(inGroup, 'тур', 'тура', 'туров')} с ценой не за человека (за группу или за день) — в итоге на группу ${inGroup === 1 ? 'он учтён' : 'они учтены'} по своей единице цены.`);
    }
    lines.push(`Итого на ${group.people === 1 ? 'одного' : `группу из ${group.people} чел.`}: ${range(group.total)} — туры по своей цене (за человека — на каждого, за группу — на группу), жильё, переезды и дни без тура — ориентир на каждого.`);
    if (group.unpriced.length > 0) {
      lines.push(`Не вошло ни в одну сумму — цены нет: ${group.unpriced.join('; ')}. Цену называет оператор, она в карточке тура.`);
    }
    lines.push(...group.assumptions);
  }
  lines.push('Перелёт до Камчатки в сумму не входит.');
  return lines;
}

/**
 * Вес за совпадение ЗАГЛАВНОГО интереса пресета — первого в его списке.
 *
 * Первый интерес — это то, что написано в заголовке страницы, куда придёт
 * турист: у `kamchatka-za-5-dney-okean` это `boat_trip` («океан и
 * побережье»), у `kamchatka-za-7-dney-rybalka` — `fishing` («рыбалка»), хотя
 * `boat_trip` есть и там. Поэтому вес обязан перебивать одно лишнее побочное
 * совпадение (10) вместе с разницей в днях: иначе турист, спросивший про
 * море, уходит на страницу про рыбалку — она просто шире.
 */
const HEADLINE_BONUS = 25;

/**
 * Ближайший пресет /plans под длительность и интересы — ссылка с бронью.
 *
 * ── Чем это было сломано (замер 19.09) ───────────────────────────────────
 *
 * Счёт был `overlap * 10 - dayPenalty`, а сравнение — строгим `>`. На запрос
 * «море», 7 дней счёт 10 набирали СРАЗУ ЧЕТЫРЕ пресета, и побеждал не
 * лучший, а первый в массиве: `kamchatka-za-7-dney-rybalka`. Турист просил
 * море — получал ссылку «Камчатка за 7 дней: рыбалка», потому что у неё
 * `boat_trip` стоит третьим в списке. Порядок литералов в файле решал, что
 * увидит человек.
 *
 * Теперь счёт различает три вещи, и ни одна из них не зависит от порядка:
 * заглавный интерес пресета, число совпадений и обещанное СВЕРХ спрошенного
 * (пресет на шесть тем — плохой ответ на одну). Остаточная ничья решается
 * слагом, а не индексом массива.
 *
 * `presets` параметром — чтобы сторож мог перетасовать список и показать,
 * что ответ от порядка не зависит.
 */
export function matchPreset(
  days: number,
  interests: string[],
  presets: readonly PlanPreset[] = PLAN_PRESETS,
  month?: number,
): { slug: string; title: string } | null {
  let best: { slug: string; title: string; score: number } | null = null;

  for (const p of presets) {
    // Сезонная страница — только в свой месяц: «Камчатка в июне» на поездку
    // в июле или октябре обещает то, чего в эти месяцы нет (проба MCP 29.09).
    if (month !== undefined && p.months && !p.months.includes(month)) continue;
    const overlap = p.interests.filter((i) => interests.includes(i)).length;
    // Ни одного общего интереса — не кандидат вовсе. Ссылка наугад хуже
    // отсутствия ссылки: турист уходит читать не про то, что просил.
    if (overlap === 0) continue;

    const headline = p.interests[0];
    const extraPromised = p.interests.length - overlap;
    const score = overlap * 10
      + (headline && interests.includes(headline) ? HEADLINE_BONUS : 0)
      - Math.abs(p.days - days)
      - extraPromised;

    if (!best || score > best.score || (score === best.score && p.slug < best.slug)) {
      best = { slug: p.slug, title: p.title, score };
    }
  }

  return best ? { slug: best.slug, title: best.title } : null;
}

function capitalize(t: string): string {
  return t ? t.charAt(0).toLocaleUpperCase('ru-RU') + t.slice(1) : t;
}

function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

/**
 * Строка живой занятости под днём с туром оператора (#2241).
 *
 * Даты и места — из той же занятости, что `get_tour_availability`
 * (`fetchAvailabilityForTour` движка), второго расчёта здесь нет. До 08.10
 * движок их считал, а текст плана выбрасывал: агент видел «Летняя рыбалка —
 * от 28 000 ₽» без даты и без номера тура и шёл к оператору вслепую.
 *
 * Исходов четыре, и ни один не подменяет другой (§4.0):
 * дата есть — называется (и честно, если это не день плана); расписания у
 * тура нет — «дату подтверждает оператор», а не «мест нет»; расписание есть,
 * а дат в окне нет — «мест нет»; не смогли прочитать — так и сказано.
 *
 * `planDayIso` — дата этого дня плана; `keepsSchedule` — ведёт ли тур
 * календарь (нужен только для исхода `none`; null — не смогли проверить).
 * null в ответе — сказать нечего (у дня нет тура или занятость не читалась).
 *
 * У ответа наличия есть время проверки (совет, пересланный владельцем 07.11,
 * принцип 2: дата, ответ наличия и время проверки — без них «не
 * подтверждено»). Места, которых нечем подтвердить (не прочиталось,
 * расписания нет, время проверки не записано), так и названы.
 */
export function tourAvailabilityLine(
  d: Pick<DayPlan, 'realTour' | 'availability' | 'availableDate' | 'slotsRemaining' | 'capacityWarning' | 'availabilityCheckedAt'>,
  planDayIso: string | null,
  keepsSchedule: boolean | null | undefined,
): string | null {
  if (!d.realTour || !d.availability) return null;
  const id = `Тур ID${d.realTour.tourId}${d.realTour.operatorName ? `, ${d.realTour.operatorName}` : ''}`;
  const at = d.availabilityCheckedAt;
  const stamp = at && Number.isFinite(Date.parse(at)) ? kamchatkaStamp(at) : null;
  const checked = stamp ? ` (проверено ${stamp} по Камчатке)` : null;
  if (d.availability === 'open' && d.availableDate) {
    const seats = d.slotsRemaining != null ? `, свободно мест: ${d.slotsRemaining}` : '';
    const other = planDayIso && d.availableDate !== planDayIso
      ? ` — это не ${ddmm(planDayIso)}, день плана можно сдвинуть под тур`
      : '';
    const warn = d.capacityWarning ? `. ${d.capacityWarning}` : '';
    const proof = checked ?? ' (время проверки не записано — места не подтверждены)';
    return `${id}: ближайшая свободная дата в ваши даты — ${ddmm(d.availableDate)}${seats}${other}${proof}${warn}`;
  }
  if (d.availability === 'unread') {
    return `${id}: занятость сейчас не прочиталась — места не подтверждены, даты не называю, проверьте get_tour_availability по ID`;
  }
  if (keepsSchedule === false) {
    return `${id}: расписания в системе нет — места не подтверждены, но это не «мест нет»: дату подтверждает оператор по заявке`;
  }
  if (keepsSchedule === true) {
    return `${id}: в ваши даты свободных мест нет${checked ?? ' (время проверки не записано)'} — другие даты покажет get_tour_availability по ID`;
  }
  return `${id}: свободных дат в ваши даты не нашли, а ведёт ли тур расписание, проверить не смогли — места не подтверждены, не утверждайте, что мест нет`;
}

const DAY_WARNINGS_SHOWN = 3;
/**
 * Восемь, а не шесть (07.11): до агента теперь доходит и «зона не вошла» —
 * справка уровня info, которая раньше отсекалась фильтром. Порядок ниже
 * держит важное впереди, потолок режет хвост.
 */
const WARNINGS_SHOWN = 8;

/**
 * Справки уровня info, которые агенту нужны в «Важно»: безопасность
 * («территория медведей», «нет сотовой связи» — проверка MCP 29.09) и почему
 * дальняя зона не вошла (`zone_days`: рыбалку ИИ не объяснил, пруф 06.11).
 * Допущение счёта у местного (`home_nights`) стоит не здесь, а под сметой
 * (planPriceLines). Остальные справки (загрузка, разрешения зон вне плана)
 * агенту не нужны.
 */
const INFO_FOR_AGENT: ReadonlySet<string> = new Set(['safety', 'zone_days']);

/**
 * Строки «Важно» плана в порядке, который переживает потолок WARNINGS_SHOWN.
 * Критическое — первым: потолок режет хвост, и «парк закрыт» или «дня на
 * возвращение нет» уступали место справкам (разбор планера 06.11: в 68 из 272
 * планов такая строка до агента не доходила). Сразу за ним — сводка МЧС: движок
 * добавляет её последней из важных, и при длинном списке извержение или
 * перекрытая дорога уходили за потолок (аудит планировщика 07.11, K3). Затем —
 * что вышло из просьбы «как ехать / дни отдыха» (турист об этом просил, и
 * частичное исполнение не должно читаться как полное), почему зона не вошла,
 * безопасность и остальное важное. Допущение счёта — под сметой, не здесь.
 */
export function planWarningLines(rec: {
  warnings: ReadonlyArray<{ type: string; severity: 'critical' | 'important' | 'info'; message: string }>;
  preferences?: { notes: ReadonlyArray<{ status: string; message: string }> } | null;
}): string[] {
  const shown = rec.warnings.filter((w) => w.severity !== 'info' || INFO_FOR_AGENT.has(w.type));
  const rest = shown.filter((w) => w.severity !== 'critical');
  const pick = (keep: (w: { type: string; severity: string }) => boolean): string[] => rest.filter(keep).map((w) => w.message);
  return [
    ...shown.filter((w) => w.severity === 'critical').map((w) => w.message),
    ...pick((w) => w.type === 'mchs'),
    ...(rec.preferences?.notes ?? []).filter((n) => n.status !== 'honoured').map((n) => n.message),
    ...pick((w) => w.type === 'zone_days'),
    ...pick((w) => w.type === 'safety' && w.severity !== 'info'),
    ...pick((w) => w.type === 'safety' && w.severity === 'info'),
    ...pick((w) => !['mchs', 'zone_days', 'safety', 'home_nights'].includes(w.type)),
  ];
}

/**
 * Строки сметы плана и сразу под ними — допущение счёта у местного
 * (`home_nights`: «ночи в Авачинской зоне в счёт не вошли»). Допущение — про
 * смету: без него «Ориентир на человека» читается как полный счёт, а последней
 * строкой «Важно» оно срезалось потолком (аудит планировщика 07.11, K4).
 * Сметы нет — нет и допущения.
 */
export function planPriceLines(
  priceLines: string[],
  warnings: ReadonlyArray<{ type: string; message: string }>,
): string[] {
  if (priceLines.length === 0) return [];
  return [...priceLines, ...warnings.filter((w) => w.type === 'home_nights').map((w) => w.message)];
}

/** План по дням → текст для чата (Telegram/MAX/веб). Чистая, под тестом. */
export function formatTripPlanForChat(
  days: DayPlan[],
  warnings: string[],
  preset: { slug: string; title: string } | null,
  /**
   * Готовый текст отказа и дата, на которую считали. Оба обязательны:
   * турист просил «семь дней», а движок молча берёт месяц вперёд — не
   * назвать эту дату значит выдать план на октябрь за план «на сейчас».
   */
  context?: {
    refusal: string; plannedFor: string;
    /** Дата первого дня плана, YYYY-MM-DD — чтобы назвать дату каждого дня. */
    arrivalIso?: string;
    /** Ведёт ли тур расписание — по ID, для дней с туром без свободных дат. */
    keepsSchedule?: ReadonlyMap<string, boolean | null>;
    /** Цена плана словами (formatPlanPrice) — под днями, до «Важно». */
    priceLines?: string[];
  },
): string {
  if (days.length === 0) {
    return context?.refusal
      ?? `Не собрал план по этим параметрам. Живой планировщик: ${SITE}/planner`;
  }
  const lines: string[] = [
    context?.plannedFor
      ? `Собрал план по дням (считаю на ${context.plannedFor} — пересобрать под свои даты можно в планировщике):`
      : 'Собрал план по дням:',
    '',
  ];
  let prevDay = 0;
  for (const d of days) {
    // Разрыв в нумерации — дни, которые движок не наполнил и не придумал
    // (19.09). Молча пропущенные, они читались как «День 5 → День 7» (аудит
    // MCP 29.09): человек не понимал, куда делся шестой.
    if (d.day > prevDay + 1) {
      const from = prevDay + 1;
      const to = d.day - 1;
      lines.push(from === to
        ? `День ${from}. Не заполнен: подтверждённого выхода на эту дату у нас нет, придумывать не стали`
        : `Дни ${from}–${to}. Не заполнены: подтверждённых выходов на эти даты у нас нет, придумывать не стали`);
    }
    prevDay = d.day;
    // Цена — только у реального тура. Без него priceFrom — ориентир из
    // констант движка («вулканы от 5 000 ₽» при нуле туров на вулканы), и
    // рядом с настоящими ценами он читался как цена (аудит MCP 29.09).
    // Единица — из тура (priceFromUnit, #2304): «от 196 000 ₽» у тура за
    // группу агент читал как цену с человека. Цены для группы нет (вне ступеней
    // оператора) — так и сказано строкой ниже, без числа.
    const price = d.realPrice != null && d.realPrice > 0 ? ` — ${priceFromUnit(d.realPrice, d.realTour?.priceUnit)}` : '';
    lines.push(`День ${d.day}. ${capitalize(d.title)}${price}`);
    if (d.priceMissing) lines.push(`   ${d.priceMissing}`);
    const planDayIso = context?.arrivalIso
      ? new Date(Date.parse(`${context.arrivalIso}T00:00:00Z`) + (d.day - 1) * 86400000).toISOString().slice(0, 10)
      : null;
    const live = tourAvailabilityLine(d, planDayIso, d.realTour ? context?.keepsSchedule?.get(d.realTour.tourId) : undefined);
    if (live) lines.push(`   ${live}`);
    // Предупреждения дня — «Только с гидом», лимит парка, детям до N лет —
    // стоят на самом дне; до 29.09 до ответа не доходило ни одно.
    const dayWarn = (d.dayWarnings ?? []).filter(Boolean);
    for (const w of dayWarn.slice(0, DAY_WARNINGS_SHOWN)) lines.push(`   ! ${w}`);
    if (dayWarn.length > DAY_WARNINGS_SHOWN) lines.push(`   …и ещё ${dayWarn.length - DAY_WARNINGS_SHOWN} — в планировщике`);
  }
  if (context?.priceLines && context.priceLines.length > 0) {
    lines.push('', ...context.priceLines);
  }
  if (warnings.length > 0) {
    // Без молчаливого потолка: прежний slice(0, 2) отрезал третье и
    // дальше, включая безопасность (проверка MCP 29.09).
    lines.push('', 'Важно:', ...warnings.slice(0, WARNINGS_SHOWN).map((w) => `- ${w}`));
    if (warnings.length > WARNINGS_SHOWN) lines.push(`…и ещё ${warnings.length - WARNINGS_SHOWN} — в планировщике`);
  }
  lines.push('');
  if (preset) {
    lines.push(`Готовая страница этого формата с турами и заявкой оператору: ${SITE}/plans/${preset.slug}`);
  }
  lines.push(`Пересобрать под свои даты и состав: ${SITE}/planner`);
  return lines.join('\n');
}

/** Обработчик инструмента: собрать план и отдать текст с ссылками. */
export async function makeTripPlanForKuzmich(
  args: {
    days?: string; interests?: string; when?: string; travel_style?: string; rest_days?: string;
    adults?: string; children?: string; budget_tier?: string;
  },
  opts: { surface?: DraftSurface } = {},
): Promise<string> {
  const start = parsePlanStart(args.when, Date.now());
  // Не дата, нет в календаре, конец раньше начала — плана нет и черновика
  // нет: план на подставленную дату был бы ответом на другой вопрос (аудит
  // 07.11, M2; аудит MCP 25.10, п. 1). Отказ по входу, а не падение: на MCP
  // роут отвечает isError с кодом в журнале, в чате — та же фраза (core.ts).
  if (start.kind === 'invalid') throw new McpUserError(planStartRefusal(start), 'invalid_date');
  const { days: daysNum, note: daysNote } = readPlanDaysFor(args.days, start);
  const { interests, defaulted } = parseChatInterestsDetailed(args.interests ?? '');
  // Интересы не разобраны — берётся классика, и это говорится, как у дат.
  const interestsNote = defaulted
    ? (args.interests?.trim()
      ? `Интересы «${args.interests.trim()}» не разобрал — взял классику первой поездки: вулканы, медведи, термальные источники.`
      : 'Интересы не названы — взял классику первой поездки: вулканы, медведи, термальные источники.')
    : null;

  const group = readAdults(args.adults);
  const kids = readChildren(args.children, opts.surface ?? 'chat');
  // Возраст детей не разобран — плана нет и черновика нет: собрать план
  // «как для взрослых» значило бы снять возрастные допуски (ловушка 29.10).
  if (kids.kind === 'unknown') return kids.refusal;
  const budget = readBudgetTier(args.budget_tier);

  const arrival = start.date;
  // `daysNum` — КАЛЕНДАРНЫЕ дни, считая первый и последний, поэтому шагов
  // между датами на один меньше (движок считает так же с 27.09: до этого
  // `getTripDays` возвращал ночи, и «7 дней» превращались в восемь).
  const departure = new Date(arrival.getTime() + (daysNum - 1) * 86400000);

  const rec = await recommendTrip({
    interests,
    arrivalDate: arrival.toISOString().slice(0, 10),
    departureDate: departure.toISOString().slice(0, 10),
    adults: group.adults,
    children: kids.children,
    fitnessLevel: 'moderate',
    budgetTier: budget.tier,
    riskMode: 'safe_only',
    travelStyle: readTravelStyle(args.travel_style),
    restDays: readRestDays(args.rest_days),
  }, { itinerary: 'plain' });

  // Жильё и машина к плану — настоящие варианты тем же подбором, что экран
  // планера (аудит 07.11, 4.3; lib/kuzmich/plan-offers). Параллельно с
  // занятостью туров: запросы независимы.
  const offersP = rec.days.length > 0
    ? planOfferLines({
      days: rec.days.map((d) => ({ day: d.day, type: d.type, zone: d.zone, lodgingIncluded: d.realTour?.lodgingIncluded ?? null })),
      arrivalIso: arrival.toISOString().slice(0, 10),
      departureIso: departure.toISOString().slice(0, 10),
      adults: group.adults, children: kids.children, surface: opts.surface ?? 'chat',
    }, SITE)
    : Promise.resolve([]);

  const keepsSchedule = await scheduleMap(rec.days);

  const month = arrival.getUTCMonth() + 1;
  const plannedFor = ruDayMonth(arrival);

  const text = formatTripPlanForChat(
    rec.days,
    planWarningLines(rec),
    matchPreset(daysNum, interests, PLAN_PRESETS, month),
    {
      refusal: buildRefusal(month, interests, SITE, rec.catalogueOpen, rec.childBlocked ?? []), plannedFor,
      arrivalIso: arrival.toISOString().slice(0, 10), keepsSchedule,
      priceLines: planPriceLines(
        formatPlanPrice(rec.priceBreakdown, budget.tier, rec.days.length > 0,
          estimateGroup(rec.days, { adults: group.adults, children: kids.children, budgetTier: budget.tier })),
        rec.warnings,
      ),
    },
  );

  const assumptions = planAssumptions({
    adults: group.adults, adultsGiven: group.given, children: kids.children,
    tier: budget.tier, tierGiven: budget.given,
  }, opts.surface ?? 'chat');
  const notes = [
    startNote(start, plannedFor), daysNote, interestsNote,
    group.note, budget.note, assumptions,
  ].filter(Boolean);

  // План сохраняется черновиком — правка идёт по его id (#2224). Отказа
  // нет — нет и плана, сохранять нечего.
  let idLine = '';
  if (rec.days.length > 0) {
    const params: PlanParams = {
      interests,
      arrivalDate: arrival.toISOString().slice(0, 10),
      departureDate: departure.toISOString().slice(0, 10),
      adults: group.adults,
      children: kids.children,
      budgetTier: budget.tier,
      ...(readTravelStyle(args.travel_style) ? { travelStyle: readTravelStyle(args.travel_style) } : {}),
      ...(readRestDays(args.rest_days) !== undefined ? { restDays: readRestDays(args.rest_days) } : {}),
    };
    idLine = planIdLine(await saveDraft({ params, days: rec.days }, opts.surface ?? 'chat', args.interests), 1);
  }
  const offers = await offersP;
  return `${notes.join('\n')}\n\n${text}${offers.length > 0 ? `\n\n${offers.join('\n')}` : ''}${idLine ? `\n\n${idLine}` : ''}`;
}

/**
 * Ведёт ли тур расписание — только для туров, у которых в окне поездки
 * свободных дат не нашлось: «календаря нет» и «мест нет» — разные ответы.
 */
async function scheduleMap(days: readonly DayPlan[]): Promise<Map<string, boolean | null>> {
  const keepsSchedule = new Map<string, boolean | null>();
  const noDates = [...new Set(days
    .filter((d) => d.realTour && d.availability === 'none')
    .map((d) => (d.realTour as NonNullable<DayPlan['realTour']>).tourId))];
  await Promise.all(noDates.map(async (id) => {
    keepsSchedule.set(id, await tourKeepsSchedule(Number(id)));
  }));
  return keepsSchedule;
}

/**
 * Строка с id плана для правки. Черновик не записался — так и сказано:
 * план показан, но правка через edit_trip_plan для него недоступна.
 *
 * Здесь же — ссылка на страницу плана (#2225): карта, GPX и сохранение для
 * офлайна. Строка одна на make_trip_plan и edit_trip_plan, поэтому ссылка
 * есть у каждого показа плана, и страница читает свежую правку черновика.
 * Нет черновика — нет и ссылки: страница открыла бы «не найдено».
 */
export function planIdLine(id: string | null, revision: number): string {
  if (!id) {
    return 'Черновик плана не сохранился — править этот план через edit_trip_plan нельзя; чтобы изменить, собери план заново.';
  }
  return `ID плана: ${id}${revision > 1 ? ` (правка ${revision - 1})` : ''}. Изменить — edit_trip_plan с этим ID: добавить, убрать, переставить или заменить день, сменить уровень жилья или состав группы, сдвинуть поездку на другие даты, учесть задержку рейса (flight_delay). План хранится 7 дней.\n`
    + `Страница плана — карта, GPX для навигатора и сохранение на телефон для поля без связи: ${SITE}/trip/${id}`;
}

// Разбор строки «ID плана» живёт в лёгком модуле: его зовёт и роут чата,
// которому движок планера не нужен (аудит 07.11, K7).
export { planIdFromAnswer } from '@/lib/kuzmich/plan-id';

const EDIT_ACTIONS: Record<string, PlanEdit['kind']> = {
  add_day: 'add_day', remove_day: 'remove_day', move_day: 'move_day', replace_day: 'replace_day',
  set_lodging: 'set_lodging', set_party: 'set_party', shift_dates: 'shift_dates', flight_delay: 'flight_delay',
  добавить: 'add_day', убрать: 'remove_day', удалить: 'remove_day', переставить: 'move_day',
  заменить: 'replace_day', замена: 'replace_day', жильё: 'set_lodging', жилье: 'set_lodging',
  состав: 'set_party', группа: 'set_party', сдвинуть: 'shift_dates', сдвиг: 'shift_dates', перенести: 'shift_dates',
  рейс: 'flight_delay', задержка: 'flight_delay',
};

const EDIT_ACTION_LIST = 'add_day, remove_day, move_day, replace_day, set_lodging, set_party, shift_dates, flight_delay';

/** «да» / «нет» для keep_return; не сказано — обратный билет прежний. */
function readKeepReturn(raw: string | undefined): boolean | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return true;
  if (/^(да|yes|true|1|прежн|оставить|не меня)/.test(v)) return true;
  if (/^(нет|no|false|0|перенес|сдвин|меня)/.test(v)) return false;
  return null;
}

/** Номер дня: целое ≥ 1. */
function readDayNum(raw: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*$/.exec(raw ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Сдвиг в днях со знаком: «7», «+7», «-3», «−3». Ноль и не число — null. */
function readShiftDays(raw: string | undefined): number | null {
  const m = /^\s*([+\-−]?)\s*(\d{1,3})\s*$/.exec(raw ?? '');
  if (!m) return null;
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n === 0) return null;
  return m[1] === '-' || m[1] === '−' ? -n : n;
}

/** Занятие из слов: ключ движка или ошибка словами. */
function readInterest(raw: string | undefined, action: string): { ok: true; interest: string } | { ok: false; error: string } {
  const keys = parseInterestWords((raw ?? '').toLowerCase());
  if (keys.length > 0) return { ok: true, interest: keys[0] };
  return {
    ok: false,
    error: raw?.trim()
      ? `Интерес «${raw.trim()}» не разобрал — назови занятие: рыбалка, вулканы, медведи, сплав, море, термальные.`
      : `Для ${action} нужен интерес (interest): «рыбалка», «вулканы»…`,
  };
}

/**
 * Новая дата начала для shift_dates — тем же разбором, что `when` у
 * make_trip_plan (lib/kuzmich/plan-start): «20 июля», 20.07.2027,
 * 2027-07-20, «в августе», диапазон «20–27 июля»; «сегодня» — по Камчатке.
 */
function readShiftStart(raw: string, now: number): { ok: true; startDate: string; length?: number } | { ok: false; error: string } {
  const start = parsePlanStart(raw, now);
  if (start.kind === 'invalid') {
    if (start.reason === 'bad_range') return { ok: false, error: `В «${start.raw}» конец раньше начала — назови даты по порядку, например «20–27 июля».` };
    if (start.reason === 'no_such_date') return { ok: false, error: `Даты «${start.raw}» нет в календаре — назови настоящую дату: «20 июля», 20.07.2027 или 2027-07-20.` };
    return { ok: false, error: `«${start.raw}» не разобрал как дату — назови новый первый день поездки: «20 июля», 20.07.2027, 2027-07-20 или месяц («в августе»).` };
  }
  if (start.kind === 'past') return { ok: false, error: `«${start.raw}» по Камчатке уже прошло — назови дату не раньше сегодняшней.` };
  if (start.kind === 'default') return { ok: false, error: 'Для shift_dates нужен новый первый день поездки (start_date) или сдвиг в днях (shift_days).' };
  const length = rangeDays(start);
  return { ok: true, startDate: start.date.toISOString().slice(0, 10), ...(length ? { length } : {}) };
}

/**
 * Разбор правки из аргументов инструмента. Правка — структура, не свободный
 * текст (#2224): действие, день, место, интерес, уровень жилья, состав, даты.
 * Чего не хватает — ошибка словами, без догадки. Состав и даты читаются теми
 * же правилами, что у make_trip_plan: взрослые 1–30, возраст каждого ребёнка,
 * даты по Камчатке.
 */
export function readPlanEdit(args: {
  action?: string; day?: string; to_day?: string; interest?: string; lodging?: string;
  delay_days?: string; keep_return?: string;
  adults?: string; children?: string; start_date?: string; shift_days?: string;
}, opts: { surface?: DraftSurface; now?: number } = {}): { ok: true; edit: PlanEdit } | { ok: false; error: string } {
  const kind = EDIT_ACTIONS[(args.action ?? '').trim().toLowerCase()];
  if (!kind) return { ok: false, error: `Не понял действие. Можно: ${EDIT_ACTION_LIST}.` };
  if (kind === 'flight_delay') {
    const days = readDayNum(args.delay_days);
    if (!days) return { ok: false, error: 'Для flight_delay нужно, на сколько дней задержан рейс (delay_days, 1–7).' };
    const keepReturn = readKeepReturn(args.keep_return);
    if (keepReturn === null) return { ok: false, error: `keep_return «${args.keep_return}» не разобрал: «да» — обратный билет прежний, «нет» — переносится.` };
    return { ok: true, edit: { kind, days, keepReturn } };
  }
  if (kind === 'remove_day') {
    const day = readDayNum(args.day);
    return day ? { ok: true, edit: { kind, day } } : { ok: false, error: 'Для remove_day нужен номер дня (day).' };
  }
  if (kind === 'move_day') {
    const day = readDayNum(args.day);
    const to = readDayNum(args.to_day);
    return day && to ? { ok: true, edit: { kind, day, to } } : { ok: false, error: 'Для move_day нужны номер дня (day) и новое место (to_day).' };
  }
  if (kind === 'add_day') {
    const interest = readInterest(args.interest, 'add_day');
    return interest.ok ? { ok: true, edit: { kind, interest: interest.interest } } : interest;
  }
  if (kind === 'replace_day') {
    const day = readDayNum(args.day);
    if (!day) return { ok: false, error: 'Для replace_day нужны номер дня (day) и новое занятие (interest).' };
    const interest = readInterest(args.interest, 'replace_day');
    return interest.ok ? { ok: true, edit: { kind, day, interest: interest.interest } } : interest;
  }
  if (kind === 'set_party') {
    const adultsRaw = (args.adults ?? '').trim();
    const childrenGiven = (args.children ?? '').trim() !== '';
    if (!adultsRaw && !childrenGiven) {
      return { ok: false, error: 'Для set_party нужен состав: сколько взрослых (adults) и/или возраст каждого ребёнка (children; детей больше нет — «нет»).' };
    }
    const edit: Extract<PlanEdit, { kind: 'set_party' }> = { kind };
    if (adultsRaw) {
      const a = readAdults(adultsRaw);
      if (!a.given) return { ok: false, error: `Число взрослых «${adultsRaw}» не разобрал — нужно от 1 до ${MAX_GROUP}.` };
      edit.adults = a.adults;
    }
    if (childrenGiven) {
      const c = readChildren(args.children, opts.surface ?? 'chat');
      if (c.kind === 'unknown') return { ok: false, error: c.refusal.replace(/^План не собран: /, '') };
      edit.children = c.children;
    }
    return { ok: true, edit };
  }
  if (kind === 'shift_dates') {
    const rawStart = (args.start_date ?? '').trim();
    if (rawStart) {
      const start = readShiftStart(rawStart, opts.now ?? Date.now());
      return start.ok ? { ok: true, edit: { kind, startDate: start.startDate, ...(start.length ? { length: start.length } : {}) } } : start;
    }
    const rawShift = (args.shift_days ?? '').trim();
    if (rawShift) {
      const days = readShiftDays(rawShift);
      return days !== null
        ? { ok: true, edit: { kind, days } }
        : { ok: false, error: `shift_days «${rawShift}» не разобрал — нужно целое число дней: 7 — на неделю позже, -3 — на три дня раньше.` };
    }
    return { ok: false, error: 'Для shift_dates нужен новый первый день поездки (start_date: «20 июля», 20.07.2027 или 2027-07-20) или сдвиг в днях (shift_days: 7 — позже, -3 — раньше).' };
  }
  const tier = readBudgetTier(args.lodging);
  return tier.given ? { ok: true, edit: { kind: 'set_lodging', tier: tier.tier } } : { ok: false, error: tier.note ?? 'Для set_lodging нужен уровень жилья (lodging): эконом, комфорт или премиум.' };
}

/** Обработчик edit_trip_plan: прочитать черновик, поправить, записать, показать. */
export async function editTripPlanForKuzmich(args: {
  plan_id?: string; action?: string; day?: string; to_day?: string; interest?: string; lodging?: string;
  delay_days?: string; keep_return?: string;
  adults?: string; children?: string; start_date?: string; shift_days?: string;
}, opts: { surface?: DraftSurface; now?: number } = {}): Promise<string> {
  const id = (args.plan_id ?? '').trim();
  if (!isDraftId(id)) {
    return 'Нужен ID плана из ответа make_trip_plan (вида 1b9d6bcd-…). Плана нет — собери его через make_trip_plan.';
  }
  const parsed = readPlanEdit(args, opts);
  if (!parsed.ok) return `${parsed.error} План не менялся.`;

  const read = await loadDraft(id);
  if (read.kind === 'failed') return 'План сейчас не прочитался — повтори правку чуть позже. Сам план на месте, собирать заново не нужно.';
  if (read.kind === 'missing') {
    return `План ${id} не найден: ID неверный или плану больше 7 дней. Собери новый через make_trip_plan — править нечего, новый план с нуля здесь не строю.`;
  }
  const draft = read.draft;
  const result = await applyPlanEdit({ params: draft.params, days: draft.days }, parsed.edit);
  if (!result.ok) return `Правку не сделал: ${result.reason} План остался прежним.\n\n${planIdLine(draft.id, draft.revision)}`;

  const saved = await updateDraft(draft, result.plan);
  if (saved.kind === 'conflict') {
    return 'План успели изменить другим вызовом — эту правку не записал, чтобы не затереть ту. Повтори правку: она применится к свежей версии.';
  }
  if (saved.kind === 'failed') return 'Правку посчитал, но не сохранил — база не ответила. План остался прежним, повтори правку чуть позже.';

  const plan = result.plan;
  const arrival = new Date(`${plan.params.arrivalDate}T00:00:00Z`);
  const plannedFor = ruDayMonth(arrival);
  const text = formatTripPlanForChat(
    plan.days,
    result.warnings ?? [],
    null,
    {
      refusal: '', plannedFor, arrivalIso: plan.params.arrivalDate,
      keepsSchedule: await scheduleMap(plan.days),
      priceLines: formatPlanPrice(planPrice(plan), plan.params.budgetTier, plan.days.length > 0, planEstimate(plan)),
    },
  );
  return [result.note, rereadLine(result.reread ?? []), toursTouchedLines(result.toursTouched ?? []), text, planIdLine(draft.id, saved.revision)]
    .filter(Boolean).join('\n\n');
}

/**
 * Места и цена туров, которые правка перечитала на новую дату или группу
 * (аудит 07.11, M3). Сами места — в строках дней плана; здесь — что они
 * перечитаны и у каких туров прочитать не удалось.
 */
export function rereadLine(reread: ReadonlyArray<RereadTour>): string {
  if (reread.length === 0) return '';
  const head = 'Места и цену туров, которых коснулась правка, я перечитал на их новые даты и состав группы — они в строках дней ниже.';
  const unread = reread.filter((r) => r.availability === 'unread');
  if (unread.length === 0) return head;
  return `${head} Места не прочитались: ${unread.map((r) => `«${r.title}» (ID${r.tourId})`).join(', ')} — проверь через get_tour_availability по ID, прежде чем обещать.`;
}

const TOUCHED_HOW: Record<TouchedTour['how'], string> = {
  dropped: 'выпал из плана',
  shifted: 'попал на другие даты',
  party: 'идёт другим составом группы',
};

/**
 * Туры, которых коснулась правка (#2231). План брони не меняет и оператору
 * сам не пишет: брони туриста по плану не видно — тот анонимен. Поэтому ответ
 * прямо говорит, кому и что сказать.
 */
export function toursTouchedLines(tours: ReadonlyArray<TouchedTour>): string {
  if (tours.length === 0) return '';
  const after: string[] = [];
  if (tours.some((t) => t.how === 'dropped')) after.push('Не обещай, что оператор вернёт деньги: это решают его условия отмены.');
  if (tours.some((t) => t.how !== 'dropped')) after.push('Места в строках дней ниже — то, что видно в системе сейчас; подтверждает их оператор.');
  return [
    'Туры операторов, которых это касается:',
    ...tours.map((t) => `- «${t.title}» (ID${t.tourId}) — ${TOUCHED_HOW[t.how]}`),
    `Если тур уже забронирован, бронь сама не меняется: сообщи оператору об изменении — по контактам на странице брони или кнопкой «Написать оператору» на карточке тура (контакты — в get_tour_details). ${after.join(' ')}`,
  ].join('\n');
}
