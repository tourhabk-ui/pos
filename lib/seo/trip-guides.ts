/**
 * Две страницы-ответа на самые частые вопросы о поездке (разбор видимости
 * Ведара в ответах ИИ, 19.11, слово владельца «Делай оба»):
 *
 *   «Сколько стоит поездка на Камчатку»  — /skolko-stoit-poezdka-na-kamchatku
 *   «Когда ехать на Камчатку»            — /kogda-ehat-na-kamchatku
 *
 * Google сам показывает оба вопроса в «Вопросах по теме» (7 и 4 выдачи из 20),
 * а страницы у Ведара не было. Обе страницы считаются из тех же туров, что
 * каталог и посадочные (lib/seo/query-landings-data, витрина publicTourSql):
 * своих цифр и вилок здесь нет (CLAUDE.md §24). Чего база не знает — цен
 * перелёта, итога поездки, — то страница называет словами и ведёт к тем, кто
 * эту цену называет.
 *
 * Здесь — только чистые функции над строками базы: сторож проверяет их
 * вызовом, без базы и без рендера.
 */
import { plural } from '@/lib/home/data-freshness';
import { activityLabel, canonicalActivity, knownActivityLabel } from '@/lib/tours/labels';
import { FISH_SPECIES } from '@/lib/fish-species';
import { QUERY_LANDINGS, type LandingFaq, type LandingTopic, type QueryLanding } from '@/lib/seo/query-landings';
import { matchesTopic, type LandingTourRow } from '@/lib/seo/query-landings-data';
import { monthsWords, seasonMonths } from '@/lib/seo/query-landing-faq';
import { TITLE_LIMIT } from '@/lib/seo/title-fit';
import type { Metadata } from 'next';
import { defaultOgImages } from '@/lib/seo/og-image';

export interface TripGuide { key: 'cost' | 'season'; path: string; h1: string; label: string; description: string }

export const TRIP_COST: TripGuide = {
  key: 'cost',
  path: '/skolko-stoit-poezdka-na-kamchatku',
  h1: 'Сколько стоит поездка на Камчатку',
  label: 'Сколько стоит поездка',
  description: 'Цены туров на Камчатку по видам — из туров операторов на Ведаре: за человека и за группу, сколько туров в каждой цене. Жильё по ценам хозяев, перелёт и трансфер — кто называет цену.',
};

export const TRIP_SEASON: TripGuide = {
  key: 'season',
  path: '/kogda-ehat-na-kamchatku',
  h1: 'Когда ехать на Камчатку',
  label: 'Когда ехать на Камчатку',
  description: 'Камчатка по месяцам: какие туры идут — по сезонам, которые записали операторы на Ведаре, туры к медведям, сезоны рыбы по справочнику и ссылки на туры.',
};

export const TRIP_GUIDES: readonly TripGuide[] = [TRIP_COST, TRIP_SEASON];

export const RU_MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'] as const;

// ── Цены ────────────────────────────────────────────────────────────────────

/** Единицы цены, которые сравниваются только сами с собой. */
export const PRICE_UNITS = ['per_person', 'per_tour', 'per_day_per_person'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

const UNIT_WORDS: Record<PriceUnit, string> = {
  per_person: 'за человека',
  per_tour: 'за группу',
  per_day_per_person: 'за человека в день',
};

export interface PriceSpan { unit: PriceUnit; min: number; max: number; n: number }

function positive(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Вилки цен по единицам; единицы не смешиваются, туры без цены — не в вилке. */
export function priceSpans(tours: readonly LandingTourRow[]): PriceSpan[] {
  const out: PriceSpan[] = [];
  for (const unit of PRICE_UNITS) {
    const ps = tours.filter((t) => t.price_unit === unit).map((t) => positive(t.base_price)).filter((n): n is number => n !== null);
    if (ps.length) out.push({ unit, min: Math.min(...ps), max: Math.max(...ps), n: ps.length });
  }
  return out;
}

export function rub(n: number): string {
  return `${Math.round(n).toLocaleString('ru-RU')} ₽`;
}

/** «от 15 000 ₽ до 97 000 ₽» — так же, как цены в вопросах посадочных; одно число — «15 000 ₽». */
function rubSpan(min: number, max: number): string {
  return min === max ? rub(min) : `от ${rub(min)} до ${rub(max)}`;
}

export function toursWord(n: number): string {
  return `${n} ${plural(n, 'тур', 'тура', 'туров')}`;
}

/** «от 15 000 до 97 000 ₽ за человека (6 туров)»; один тур или одна цена — без «от … до». */
export function spanWords(s: PriceSpan): string {
  const sum = rubSpan(s.min, s.max);
  return `${sum} ${UNIT_WORDS[s.unit]} (${toursWord(s.n)})`;
}

/** Сколько туров с ценой не попало ни в одну вилку: цены нет или единица не записана. */
export function unpricedCount(tours: readonly LandingTourRow[]): number {
  return tours.length - priceSpans(tours).reduce((a, s) => a + s.n, 0);
}

export interface ActivityCost {
  /** Канонический вид (lib/tours/labels); не записан — ''. */
  activity: string;
  label: string;
  count: number;
  spans: PriceSpan[];
  unpriced: number;
}

/** Подпись вида; вид не записан или не знаком словарю — «Другие туры», а не служебное слово. */
function activityGroupLabel(activity: string): string {
  return knownActivityLabel(activity) ?? 'Другие туры';
}

/**
 * Цены по видам туров. Порядок видов — по числу туров, при равенстве — по
 * подписи; это порядок разделов, а не туров и не компаний, и он назван на
 * странице словами (`COST_ORDER_NOTE`).
 */
export function costByActivity(tours: readonly LandingTourRow[]): ActivityCost[] {
  const groups = new Map<string, LandingTourRow[]>();
  for (const t of tours) {
    const raw = t.activity_type ? canonicalActivity(t.activity_type) : '';
    const key = raw && knownActivityLabel(raw) ? raw : '';
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()]
    .map(([activity, ts]) => ({ activity, label: activityGroupLabel(activity), count: ts.length, spans: priceSpans(ts), unpriced: unpricedCount(ts) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));
}

export const COST_ORDER_NOTE = 'Виды идут по числу туров. Цены — те, что операторы записали в карточках туров на Ведаре; итог называет оператор при подтверждении заявки.';

/** Русские посадочные по темам, кроме общей и трансфера: к ним ведут ссылки обеих страниц. */
export function topicLandings(): QueryLanding[] {
  return QUERY_LANDINGS.filter((l) => l.lang === 'ru' && l.topic !== 'all' && l.topic !== 'transfer' && Boolean(l.subject));
}

function inTopic(t: LandingTourRow, topic: LandingTopic): boolean {
  return matchesTopic({ activity_type: t.activity_type ?? null, title: t.title, location_name: t.location_name ?? null }, topic);
}

export interface TopicCost { landing: QueryLanding; count: number; spans: PriceSpan[] }

/** Цены по направлениям — тем же отбором, что у посадочной; тема без туров не называется. */
export function costByTopic(tours: readonly LandingTourRow[]): TopicCost[] {
  return topicLandings()
    .map((landing) => {
      const ts = tours.filter((t) => inTopic(t, landing.topic));
      return { landing, count: ts.length, spans: priceSpans(ts) };
    })
    .filter((x) => x.count > 0);
}

/** Цены жилья, как их указали хозяева в карточках объектов (`price_per_night_from`). */
export interface StayPrices {
  /** Объектов на витрине. */
  total: number;
  /** Из них с нижней ценой за ночь в рублях. */
  priced: number;
  min: number | null;
  max: number | null;
}

export function stayPriceWords(s: StayPrices): string {
  if (s.priced === 0 || s.min === null || s.max === null) {
    return s.total > 0
      ? `На Ведаре ${s.total} ${plural(s.total, 'объект', 'объекта', 'объектов')} жилья, цену за ночь хозяева в карточках не записали — её называет хозяин в ответ на заявку.`
      : 'Жилья на витрине Ведара сейчас нет.';
  }
  const span = rubSpan(s.min, s.max);
  const objects = `${s.priced} ${plural(s.priced, 'объект', 'объекта', 'объектов')}`;
  const rest = s.total - s.priced;
  const tail = rest > 0 ? ` У ${rest} ${plural(rest, 'объекта', 'объектов', 'объектов')} цена не записана.` : '';
  return `Нижняя цена за ночь, которую хозяева указали в карточках, — ${span} (${objects} на Ведаре). Что в неё входит — номер или место, сколько гостей, — написано в карточке объекта; даты и итог подтверждает хозяин.${tail}`;
}

export const FLIGHT_PRICE_WORDS = 'Цен авиабилетов на Ведаре нет: их называют авиакомпании и продавцы билетов, и цена зависит от даты и города вылета. На Ведаре — табло аэропорта Елизово: задержки и отмены рейсов.';
export const TRANSFER_PRICE_WORDS = 'Трансфер — машина целиком, а не место в ней. Цена за машину — в прайсе каждого перевозчика на Ведаре: по направлению, за час или за день.';
export const TOTAL_PRICE_WORDS = 'Итога поездки Ведар не складывает: в него входят туры, жильё, перелёт и трансфер, а цены перелёта и трансфера на ваши даты здесь не записаны. Сумма, собранная из чисел, которых нет, была бы выдумкой.';

/** Самая низкая цена за человека; таких туров нет — null. */
export function cheapestPerPerson(tours: readonly LandingTourRow[]): number | null {
  return priceSpans(tours).find((s) => s.unit === 'per_person')?.min ?? null;
}

/** Заголовок с числом из базы; не помещается или числа нет — без него. */
export function costTitle(tours: readonly LandingTourRow[] | null): string {
  const min = tours && tours.length ? cheapestPerPerson(tours) : null;
  const base = TRIP_COST.h1;
  const variants = min !== null
    ? [`${base}: туры от ${rub(min)} за человека`, `${base}: туры от ${rub(min)}`, base]
    : [base];
  return variants.find((v) => v.length <= TITLE_LIMIT) ?? base;
}

/** Первая строка страницы цен — с числами; туров нет или не прочитались — null. */
export function costLead(tours: readonly LandingTourRow[] | null): string | null {
  if (!tours || tours.length === 0) return null;
  const operators = new Set(tours.map((t) => t.operator_slug ?? t.operator_name)).size;
  const spans = priceSpans(tours);
  const prices = spans.length ? `: ${spans.map(spanWords).join('; ')}` : ', цены у них не записаны';
  return `Сейчас на Ведаре ${toursWord(tours.length)} от ${operators} ${plural(operators, 'компании', 'компаний', 'компаний')}${prices}.`;
}

export function costFaq(tours: readonly LandingTourRow[] | null, stay: StayPrices | null): LandingFaq[] {
  const out: LandingFaq[] = [];
  if (tours && tours.length > 0) {
    const spans = priceSpans(tours);
    const rest = unpricedCount(tours);
    const head = spans.length
      ? `По турам операторов на Ведаре — ${spans.map(spanWords).join('; ')}. Это цены из карточек туров; итог называет оператор при подтверждении заявки.`
      : 'У туров на Ведаре цена с понятной единицей не записана — её называет оператор в ответ на заявку.';
    const tail = spans.length && rest > 0 ? ` У ${rest} ${plural(rest, 'тура', 'туров', 'туров')} цена записана иначе или не записана.` : '';
    out.push({ q: 'Сколько стоит тур на Камчатку?', a: head + tail });
  }
  if (stay) out.push({ q: 'Сколько стоит жильё на Камчатке?', a: stayPriceWords(stay) });
  out.push({ q: 'Сколько стоит перелёт на Камчатку?', a: FLIGHT_PRICE_WORDS });
  out.push({ q: 'Сколько нужно денег на поездку на Камчатку?', a: TOTAL_PRICE_WORDS });
  out.push({ q: 'Как оплачивается тур?', a: 'Ведар оплату не принимает: заявку подтверждает оператор, и тур оплачивается ему напрямую.' });
  return out;
}

// ── Месяцы ──────────────────────────────────────────────────────────────────

export interface MonthActivity { label: string; count: number }
export interface MonthTopic { landing: QueryLanding; count: number }
export interface MonthFish { id: string; name: string }

export interface MonthRow {
  month: number;
  name: string;
  /** Туров, у которых записанный сезон захватывает месяц. */
  tours: number;
  activities: MonthActivity[];
  topics: MonthTopic[];
  fish: MonthFish[];
}

export interface SeasonTable {
  months: MonthRow[];
  /** Туров с записанным сезоном. */
  withSeason: number;
  /** Туров, у которых сезон не записан: их нет ни в одном месяце. */
  withoutSeason: number;
}

/**
 * Таблица по месяцам. Месяц тура — месяц его сезона, записанного оператором
 * (`season_start`–`season_end`, через Новый год — по кругу): год сезона не
 * учитывается, ответ — «в каком месяце этот тур идёт». Рыба — из справочника
 * рыб Ведара (lib/fish-species), туры к медведям и другие темы — тем же
 * отбором, что у посадочных.
 */
export function seasonTable(tours: readonly LandingTourRow[]): SeasonTable {
  const seasons = tours.map((t) => ({ t, ms: seasonMonths(t) }));
  const known = seasons.filter((x): x is { t: LandingTourRow; ms: number[] } => x.ms !== null);
  const topics = topicLandings();
  const months: MonthRow[] = RU_MONTH_NAMES.map((name, i) => {
    const month = i + 1;
    const running = known.filter((x) => x.ms.includes(month)).map((x) => x.t);
    const byActivity = new Map<string, number>();
    for (const t of running) {
      const raw = t.activity_type ? canonicalActivity(t.activity_type) : '';
      const label = raw && knownActivityLabel(raw) ? activityLabel(raw) : 'Другие туры';
      byActivity.set(label, (byActivity.get(label) ?? 0) + 1);
    }
    return {
      month,
      name,
      tours: running.length,
      activities: [...byActivity.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru')),
      topics: topics.map((landing) => ({ landing, count: running.filter((t) => inTopic(t, landing.topic)).length })).filter((x) => x.count > 0),
      fish: FISH_SPECIES.filter((f) => f.seasonMonths.includes(month)).map((f) => ({ id: f.id, name: f.name })),
    };
  });
  return { months, withSeason: known.length, withoutSeason: tours.length - known.length };
}

/** Месяцы, в которые идёт больше всего туров; туров с сезоном нет — []. */
export function busiestMonths(t: SeasonTable): number[] {
  const top = Math.max(0, ...t.months.map((m) => m.tours));
  return top > 0 ? t.months.filter((m) => m.tours === top).map((m) => m.month) : [];
}

/** Месяцы, в которые идёт хоть один тур темы (медведи, рыбалка, снегоходы…). */
export function topicMonths(t: SeasonTable, topic: LandingTopic): number[] {
  return t.months.filter((m) => m.topics.some((x) => x.landing.topic === topic)).map((m) => m.month);
}

/** Первая строка страницы «когда ехать»; туров с сезоном нет — null. */
export function seasonLead(t: SeasonTable | null): string | null {
  if (!t || t.withSeason === 0) return null;
  const top = busiestMonths(t);
  const most = t.months.find((m) => m.month === top[0])!.tours;
  const year = t.months.filter((m) => m.tours > 0).map((m) => m.month);
  return `По сезонам, которые записали операторы на Ведаре, туры идут: ${monthsWords(year, 'ru')}. Больше всего туров — ${monthsWords(top, 'ru')}: ${toursWord(most)} из ${t.withSeason}.`;
}

export function seasonTitle(t: SeasonTable | null): string {
  const base = TRIP_SEASON.h1;
  // «медведи» — только когда туры к медведям в таблице есть: заголовок не
  // обещает того, чего на странице нет.
  const bears = t && t.withSeason > 0 && topicMonths(t, 'bears').length > 0;
  const variants = t && t.withSeason > 0
    ? [bears ? `${base}: туры по месяцам, рыба и медведи` : `${base}: туры по месяцам и рыба`, `${base}: туры по месяцам`, base]
    : [base];
  return variants.find((v) => v.length <= TITLE_LIMIT) ?? base;
}

function fishMonthsWords(): string {
  return FISH_SPECIES
    .filter((f) => f.seasonMonths.length > 0 && f.seasonMonths.length < 12)
    .map((f) => `${f.name.toLowerCase()} — ${monthsWords(f.seasonMonths, 'ru')}`)
    .join('; ');
}

export function seasonFaq(t: SeasonTable | null): LandingFaq[] {
  const out: LandingFaq[] = [];
  if (t && t.withSeason > 0) {
    const top = busiestMonths(t);
    const unknown = t.withoutSeason > 0 ? ` У ${t.withoutSeason} ${plural(t.withoutSeason, 'тура', 'туров', 'туров')} сезон не записан.` : '';
    out.push({
      q: 'В каком месяце лучше ехать на Камчатку?',
      a: `Это зависит от того, что хочется увидеть. По сезонам туров на Ведаре больше всего предложений — ${monthsWords(top, 'ru')}. У туров к медведям, рыбалки и снегоходов свои месяцы — они в таблице по месяцам на этой странице.${unknown}`,
    });
    const bears = topicMonths(t, 'bears');
    out.push({
      q: 'Когда на Камчатке туры к медведям?',
      a: bears.length
        ? `Туры с наблюдением медведей у операторов на Ведаре идут: ${monthsWords(bears, 'ru')}. Это месяцы сезонов туров, записанные операторами; где и когда медведи выходят к воде, оператор говорит в описании тура.`
        : 'Сезон туров с наблюдением медведей у операторов на Ведаре сейчас не записан.',
    });
    const snow = topicMonths(t, 'snowmobile');
    if (snow.length) out.push({ q: 'Можно ли поехать на Камчатку зимой?', a: `Да. Снегоходные туры у операторов на Ведаре идут: ${monthsWords(snow, 'ru')}.` });
  }
  const fish = fishMonthsWords();
  if (fish) out.push({ q: 'Когда на Камчатке ловится рыба?', a: `По справочнику рыб Ведара: ${fish}. Сроки и правила ловли на конкретной реке называет оператор рыболовного тура.` });
  return out;
}

/**
 * Метаданные страницы-ответа: заголовок и описание с числами из базы (через
 * `costTitle`/`seasonTitle` и вводную), canonical на свой адрес, OG. Чистая
 * функция — данные приходят готовыми.
 */
export function guideMetadata(
  g: TripGuide,
  title: string,
  lead: string | null,
  site = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://vedarai.ru',
): Metadata {
  const self = `${site}${g.path}`;
  const description = lead ?? g.description;
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: self },
    openGraph: { url: self, title, description, images: defaultOgImages(), locale: 'ru_RU', type: 'website', siteName: 'Ведар' },
    robots: { index: true, follow: true },
  };
}
