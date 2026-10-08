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
import { applyPlanEdit, planPrice, type PlanEdit, type PlanParams } from '@/lib/planner/plan-edit';
import { saveDraft, loadDraft, updateDraft, isDraftId, type DraftSurface } from '@/lib/planner/plan-drafts';

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
 * Когда считать поездку.
 *
 * До 19.09 старт был зашит как `now + 30 дней`, и спросить план на июль было
 * нельзя ничем: Кузьмич всегда считал на месяц вперёд. В сентябре это значило
 * октябрь — то есть закрытый сезон вулканов, рыбалки и медведей у КАЖДОГО
 * туриста, кто спрашивал про Камчатку летом следующего года.
 *
 * Четыре исхода вместо двух (§4.0): взяли по умолчанию, разобрали сказанное,
 * не разобрали, сказанное уже прошло. Три последних различимы снаружи —
 * `kind` читает тот, кто пишет ответ человеку.
 */
export type PlanStart =
  | { kind: 'default'; date: Date }
  | { kind: 'parsed'; date: Date }
  | { kind: 'unparsed'; date: Date; raw: string }
  | { kind: 'past'; date: Date; raw: string };

/**
 * Формы месяцев — явным списком, а не корнем.
 *
 * Корень «ма» поймал бы и «март», и «маршрут»; общего корня у «мае» и «май»
 * нет. Список короткий и проверяемый, догадка — нет.
 */
const MONTH_FORMS: string[][] = [
  ['январ'], ['феврал'], ['март'], ['апрел'], ['мае', 'май', 'маю'], ['июн'],
  ['июл'], ['август'], ['сентябр'], ['октябр'], ['ноябр'], ['декабр'],
];

/** День месяца для «хочу в июле»: середина, а не край с его погодой. */
const MONTH_ANCHOR_DAY = 10;

export function parsePlanStart(raw: string | undefined, now: number): PlanStart {
  const fallback = new Date(now + 30 * 86400000);
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return { kind: 'default', date: fallback };

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[0]}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return { kind: 'unparsed', date: fallback, raw: text };
    // Дата в прошлом — не «не понял», а «так нельзя»: починка разная, и
    // сказать надо разное.
    if (d.getTime() <= now) return { kind: 'past', date: fallback, raw: text };
    return { kind: 'parsed', date: d };
  }

  for (let m = 0; m < 12; m++) {
    if (!MONTH_FORMS[m].some((f) => text.includes(f))) continue;
    let year = new Date(now).getUTCFullYear();
    if (Date.UTC(year, m, MONTH_ANCHOR_DAY) <= now) year += 1;
    return { kind: 'parsed', date: new Date(Date.UTC(year, m, MONTH_ANCHOR_DAY)) };
  }

  return { kind: 'unparsed', date: fallback, raw: text };
}

/**
 * Что сказать человеку про выбранную дату. Пусто — когда говорить нечего.
 *
 * Молча подставлять `now + 30 дней` вместо неразобранного «через полгодика»
 * нельзя: турист спросил про одно, получил план про другое и не узнал об
 * этом. Само число дня при этом всё равно называется в первой строке плана —
 * здесь объясняется ПОЧЕМУ оно такое.
 */
export function startNote(start: PlanStart, plannedFor: string): string {
  switch (start.kind) {
    case 'unparsed':
      return `Не разобрал «${start.raw}» — считаю на ${plannedFor}. `
        + 'Назови месяц («в июле») или дату (2027-07-10), и пересчитаю.';
    case 'past':
      return `«${start.raw}» уже прошло — считаю на ${plannedFor}.`;
    default:
      return '';
  }
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
 * Дети — возрасты через запятую: «6, 10» (массив от MCP приходит той же
 * строкой «6,10»). Возраст — целое 0..17. Что не разобрано, не выбрасывается
 * молча: называется, и такой ребёнок в план не идёт — выдумывать ему возраст
 * нельзя, а от возраста зависят допуски активностей.
 */
export function readChildren(raw: string | undefined): { children: number[]; note: string | null } {
  const t = (raw ?? '').trim();
  if (!t || /^(нет|0|-|\[\s*\])$/i.test(t)) return { children: [], note: null };
  const parts = t.replace(/^\[|\]$/g, '').split(/[,;\s]+/).filter(Boolean);
  const ages: number[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const n = /^\d{1,2}$/.test(p) ? Number(p) : NaN;
    if (Number.isInteger(n) && n >= 0 && n <= 17) ages.push(n);
    else bad.push(p);
  }
  const kept = ages.slice(0, MAX_GROUP);
  const note = bad.length > 0
    ? `Возраст детей «${bad.join(', ')}» не разобрал (нужно число лет 0–17) — ${kept.length > 0 ? 'считаю только названных числом' : 'считаю без детей'}.`
    : null;
  return { children: kept, note };
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
 */
export function planAssumptions(p: {
  adults: number; adultsGiven: boolean; children: number[]; tier: BudgetTier; tierGiven: boolean;
}): string {
  const group = p.adultsGiven || p.children.length > 0
    ? `Группа: ${[`${p.adults} взр.`, p.children.length > 0 ? childrenWords(p.children) : ''].filter(Boolean).join(', ')}`
    : `Считаю на ${adultsWords(p.adults)}`;
  const level = p.tierGiven
    ? `уровень размещения «${BUDGET_LABEL[p.tier]}»`
    : `уровень размещения «${BUDGET_LABEL[p.tier]}» (не назван — допущение)`;
  return `${group}, средняя подготовка, ${level}, только безопасные варианты — если у вас иначе, пересоберите в планировщике.`;
}

const rub = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₽`;
const range = ([a, b]: [number, number]) => (a === b ? rub(a) : `${rub(a)}–${rub(b)}`);

/**
 * Цена плана словами (#2223): вилка на человека и из чего она сложена.
 *
 * Сумма — `priceBreakdown` движка, своей арифметики здесь нет. Задача этой
 * функции — не дать вилке выглядеть точнее, чем она есть (§4.0): дни по цене
 * тура и дни по справочной вилке названы раздельно, туры с ценой не за
 * человека — исключены и названы, перелёт до Камчатки не входит и сказано.
 * Плана нет — цены нет (пустой массив).
 */
export function formatPlanPrice(pb: PriceBreakdown, tier: BudgetTier, planned: boolean): string[] {
  if (!planned) return [];
  const { tourPriced, estimated, excluded } = pb.activityPricing;
  const parts: string[] = [];
  if (tourPriced > 0) parts.push(`${tourPriced} — по ценам туров операторов`);
  if (estimated > 0) parts.push(`${estimated} — по справочной вилке вида активности, это не цена тура`);
  const lines = [
    `Ориентир на человека: ${range(pb.perPersonTotal)} (уровень «${BUDGET_LABEL[tier]}»). Из чего сложено:`,
    `- активности: ${range(pb.activities)}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`,
    `- жильё: ${range(pb.accommodation)} — оценка за ночи по зоне и уровню размещения; ночи, включённые в туры, не считаны`,
    `- транспорт: ${range(pb.transport)} — трансферы и переезды по краю, оценка`,
  ];
  if (excluded > 0) {
    lines.push(`Без учёта ${excluded} ${excluded === 1 ? 'тура' : 'туров'}: цена у ${excluded === 1 ? 'него' : 'них'} не за человека (за группу или за день) — сумму смотрите в карточке тура.`);
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
 */
export function tourAvailabilityLine(
  d: Pick<DayPlan, 'realTour' | 'availability' | 'availableDate' | 'slotsRemaining' | 'capacityWarning'>,
  planDayIso: string | null,
  keepsSchedule: boolean | null | undefined,
): string | null {
  if (!d.realTour || !d.availability) return null;
  const id = `Тур ID${d.realTour.tourId}${d.realTour.operatorName ? `, ${d.realTour.operatorName}` : ''}`;
  if (d.availability === 'open' && d.availableDate) {
    const seats = d.slotsRemaining != null ? `, свободно мест: ${d.slotsRemaining}` : '';
    const other = planDayIso && d.availableDate !== planDayIso
      ? ` — это не ${ddmm(planDayIso)}, день плана можно сдвинуть под тур`
      : '';
    const warn = d.capacityWarning ? `. ${d.capacityWarning}` : '';
    return `${id}: ближайшая свободная дата в ваши даты — ${ddmm(d.availableDate)}${seats}${other}${warn}`;
  }
  if (d.availability === 'unread') {
    return `${id}: занятость сейчас не прочиталась — даты не называю, проверьте get_tour_availability по ID`;
  }
  if (keepsSchedule === false) {
    return `${id}: расписания в системе нет — это не «мест нет», дату подтверждает оператор по заявке`;
  }
  if (keepsSchedule === true) {
    return `${id}: в ваши даты свободных мест нет — другие даты покажет get_tour_availability по ID`;
  }
  return `${id}: свободных дат в ваши даты не нашли, а ведёт ли тур расписание, проверить не смогли — не утверждайте, что мест нет`;
}

const DAY_WARNINGS_SHOWN = 3;
const WARNINGS_SHOWN = 6;

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
    const price = d.realPrice != null && d.realPrice > 0 ? ` — от ${d.realPrice.toLocaleString('ru-RU')} ₽` : '';
    lines.push(`День ${d.day}. ${capitalize(d.title)}${price}`);
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
  const { days: daysNum, note: daysNote } = readPlanDays(args.days);
  const { interests, defaulted } = parseChatInterestsDetailed(args.interests ?? '');
  // Интересы не разобраны — берётся классика, и это говорится, как у дат.
  const interestsNote = defaulted
    ? (args.interests?.trim()
      ? `Интересы «${args.interests.trim()}» не разобрал — взял классику первой поездки: вулканы, медведи, термальные источники.`
      : 'Интересы не названы — взял классику первой поездки: вулканы, медведи, термальные источники.')
    : null;

  const group = readAdults(args.adults);
  const kids = readChildren(args.children);
  const budget = readBudgetTier(args.budget_tier);

  const start = parsePlanStart(args.when, Date.now());
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

  const keepsSchedule = await scheduleMap(rec.days);

  const month = arrival.getUTCMonth() + 1;
  const plannedFor = arrival.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  const text = formatTripPlanForChat(
    rec.days,
    [
      // Что вышло из просьбы «как ехать / дни отдыха» — первым: турист об
      // этом просил, и частичное исполнение не должно читаться как полное.
      ...(rec.preferences?.notes ?? []).filter((n) => n.status !== 'honoured').map((n) => n.message),
      // Безопасность — даже уровня info: «территория медведей, гид с
      // фальшфейером обязателен» и «нет сотовой связи» отсекались фильтром
      // вместе со справками о загрузке (проверка MCP 29.09).
      ...rec.warnings.filter((w) => w.severity !== 'info' || w.type === 'safety').map((w) => w.message),
    ],
    matchPreset(daysNum, interests, PLAN_PRESETS, month),
    {
      refusal: buildRefusal(month, interests, SITE, rec.catalogueOpen, rec.childBlocked ?? []), plannedFor,
      arrivalIso: arrival.toISOString().slice(0, 10), keepsSchedule,
      priceLines: formatPlanPrice(rec.priceBreakdown, budget.tier, rec.days.length > 0),
    },
  );

  const assumptions = planAssumptions({
    adults: group.adults, adultsGiven: group.given, children: kids.children,
    tier: budget.tier, tierGiven: budget.given,
  });
  const notes = [
    startNote(start, plannedFor), daysNote, interestsNote,
    group.note, kids.note, budget.note, assumptions,
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
  return `${notes.join('\n')}\n\n${text}${idLine ? `\n\n${idLine}` : ''}`;
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
  return `ID плана: ${id}${revision > 1 ? ` (правка ${revision - 1})` : ''}. Изменить — edit_trip_plan с этим ID: добавить день (интерес), убрать или переставить день, сменить уровень жилья. План хранится 7 дней.\n`
    + `Страница плана — карта, GPX для навигатора и сохранение на телефон для поля без связи: ${SITE}/trip/${id}`;
}

const PLAN_ID_RE = /ID плана: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Id плана из ответа make_trip_plan / edit_trip_plan — для ссылки «продолжить
 * в Ведаре» у MCP (lib/mcp/handoff-targets). Разбирается собственный текст
 * инструмента, а не аргумент агента; формат держит planIdLine рядом, и тест
 * сверяет их друг с другом.
 */
export function planIdFromAnswer(answer: string): string | null {
  return PLAN_ID_RE.exec(answer)?.[1] ?? null;
}

const EDIT_ACTIONS: Record<string, PlanEdit['kind']> = {
  add_day: 'add_day', remove_day: 'remove_day', move_day: 'move_day', set_lodging: 'set_lodging',
  добавить: 'add_day', убрать: 'remove_day', удалить: 'remove_day', переставить: 'move_day', жильё: 'set_lodging', жилье: 'set_lodging',
};

/** Номер дня: целое ≥ 1. */
function readDayNum(raw: string | undefined): number | null {
  const m = /^\s*(\d{1,2})\s*$/.exec(raw ?? '');
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Разбор правки из аргументов инструмента. Правка — структура, не свободный
 * текст (#2224): действие, день, место, интерес, уровень жилья. Чего не
 * хватает — ошибка словами, без догадки.
 */
export function readPlanEdit(args: {
  action?: string; day?: string; to_day?: string; interest?: string; lodging?: string;
}): { ok: true; edit: PlanEdit } | { ok: false; error: string } {
  const kind = EDIT_ACTIONS[(args.action ?? '').trim().toLowerCase()];
  if (!kind) return { ok: false, error: 'Не понял действие. Можно: add_day, remove_day, move_day, set_lodging.' };
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
    const keys = parseInterestWords((args.interest ?? '').toLowerCase());
    if (keys.length === 0) {
      return { ok: false, error: args.interest?.trim() ? `Интерес «${args.interest.trim()}» не разобрал — назови занятие: рыбалка, вулканы, медведи, сплав, море, термальные.` : 'Для add_day нужен интерес (interest): «рыбалка», «вулканы»…' };
    }
    return { ok: true, edit: { kind, interest: keys[0] } };
  }
  const tier = readBudgetTier(args.lodging);
  return tier.given ? { ok: true, edit: { kind: 'set_lodging', tier: tier.tier } } : { ok: false, error: tier.note ?? 'Для set_lodging нужен уровень жилья (lodging): эконом, комфорт или премиум.' };
}

/** Обработчик edit_trip_plan: прочитать черновик, поправить, записать, показать. */
export async function editTripPlanForKuzmich(args: {
  plan_id?: string; action?: string; day?: string; to_day?: string; interest?: string; lodging?: string;
}): Promise<string> {
  const id = (args.plan_id ?? '').trim();
  if (!isDraftId(id)) {
    return 'Нужен ID плана из ответа make_trip_plan (вида 1b9d6bcd-…). Плана нет — собери его через make_trip_plan.';
  }
  const parsed = readPlanEdit(args);
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
  const plannedFor = arrival.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const text = formatTripPlanForChat(
    plan.days,
    result.warnings ?? [],
    null,
    {
      refusal: '', plannedFor, arrivalIso: plan.params.arrivalDate,
      keepsSchedule: await scheduleMap(plan.days),
      priceLines: formatPlanPrice(planPrice(plan), plan.params.budgetTier, plan.days.length > 0),
    },
  );
  return `${result.note}\n\n${text}\n\n${planIdLine(draft.id, saved.revision)}`;
}
