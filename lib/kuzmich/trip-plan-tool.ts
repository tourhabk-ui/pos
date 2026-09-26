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
} from '@/lib/planner';
import { PLAN_PRESETS, type PlanPreset } from '@/lib/plans/presets';
// Словарь переехал в чистый модуль без зависимостей: те же слова читает
// клиент планировщика, а сюда тянется `pool` (см. шапку interest-words).
import { INTEREST_WORDS, parseInterestWords } from '@/lib/planner/interest-words';
import { parseTravelPreferences } from '@/lib/planner/travel-style-words';
import { MAX_REST_DAYS, type TravelStyle } from '@/lib/planner/travel-style';

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
): string {
  const open = inSeasonInterests(month, catalogueOpen);
  const closed = asked.filter((k) => !open.includes(k));

  const monthWord = MONTH_NAME[month - 1] ?? 'этом месяце';
  const openWords = open.map((k) => ACTIVITY_NAMES[k]).filter(Boolean).join(', ');

  const why = closed.length > 0
    ? `В ${monthWord} это уже не сезон: ${closed.map((k) => ACTIVITY_NAMES[k] ?? k).join(', ')}.`
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

/** Свободный текст интересов → ключи движка. Пусто — классика первой поездки. */
export function parseChatInterests(raw: string): string[] {
  const text = (raw || '').toLowerCase();
  const found = new Set<string>(parseInterestWords(text));
  // parseInterestsFromText движка ловит то, что словарь не покрыл
  try {
    const parsed = parseInterestsFromText(text);
    for (const k of parsed.interests ?? []) found.add(k);
  } catch { /* словаря достаточно */ }
  if (found.size === 0) return ['volcano', 'bears', 'thermal'];
  return [...found];
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
): { slug: string; title: string } | null {
  let best: { slug: string; title: string; score: number } | null = null;

  for (const p of presets) {
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
  context?: { refusal: string; plannedFor: string },
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
  for (const d of days) {
    const price = d.priceFrom > 0 ? ` — от ${d.priceFrom.toLocaleString('ru-RU')} ₽` : '';
    lines.push(`День ${d.day}. ${d.title}${price}`);
  }
  if (warnings.length > 0) {
    lines.push('', `Важно: ${warnings.slice(0, 2).join(' ')}`);
  }
  lines.push('');
  if (preset) {
    lines.push(`Готовая страница этого формата с турами и бронью: ${SITE}/plans/${preset.slug}`);
  }
  lines.push(`Пересобрать под свои даты и состав: ${SITE}/planner`);
  return lines.join('\n');
}

/** Обработчик инструмента: собрать план и отдать текст с ссылками. */
export async function makeTripPlanForKuzmich(
  args: { days?: string; interests?: string; when?: string; travel_style?: string; rest_days?: string },
): Promise<string> {
  const daysNum = Math.min(21, Math.max(3, Number(args.days) || 7));
  const interests = parseChatInterests(args.interests ?? '');

  const start = parsePlanStart(args.when, Date.now());
  const arrival = start.date;
  const departure = new Date(arrival.getTime() + daysNum * 86400000);

  const rec = await recommendTrip({
    interests,
    arrivalDate: arrival.toISOString().slice(0, 10),
    departureDate: departure.toISOString().slice(0, 10),
    adults: 2,
    children: [],
    fitnessLevel: 'moderate',
    budgetTier: 'comfort',
    riskMode: 'safe_only',
    travelStyle: readTravelStyle(args.travel_style),
    restDays: readRestDays(args.rest_days),
  });

  const month = arrival.getUTCMonth() + 1;
  const plannedFor = arrival.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  const text = formatTripPlanForChat(
    rec.days,
    [
      // Что вышло из просьбы «как ехать / дни отдыха» — первым: турист об
      // этом просил, и частичное исполнение не должно читаться как полное.
      ...(rec.preferences?.notes ?? []).filter((n) => n.status !== 'honoured').map((n) => n.message),
      ...rec.warnings.filter((w) => w.severity !== 'info').map((w) => w.message),
    ],
    matchPreset(daysNum, interests),
    { refusal: buildRefusal(month, interests, SITE, rec.catalogueOpen), plannedFor },
  );

  const note = startNote(start, plannedFor);
  return note ? `${note}\n\n${text}` : text;
}
