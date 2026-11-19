/**
 * Подписи и разметка посадочных страниц — чистые функции над строками базы,
 * чтобы сторож проверял их без рендера и без базы.
 */
import { priceWithUnitWords } from '@/lib/tours/price-label';
import { priceZh, durationZh, seasonZh } from '@/lib/zh/entry';
import { tourPath } from '@/lib/tours/tour-url';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import type { LandingFaq, LandingLang, QueryLanding } from '@/lib/seo/query-landings';
import { carrierPagePath, type CharterCarrier } from '@/lib/transfers/charter-format';
import { openYearsLabel } from '@/lib/tours/nearest-free-date';
import { plural } from '@/lib/home/data-freshness';
import { TITLE_LIMIT } from '@/lib/seo/title-fit';

const EN_UNIT: Record<string, string> = { per_person: 'per person', per_tour: 'per group', per_day_per_person: 'per person per day' };
const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function month(v: string | null): number | null {
  const m = v ? /^\d{4}-(\d{2})-\d{2}/.exec(v) : null;
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

export function landingPrice(t: LandingTourRow, lang: LandingLang): string | null {
  if (lang === 'zh-CN') return priceZh(t);
  if (lang === 'ru') return priceWithUnitWords(t.base_price, t.price_unit);
  const n = Number(t.base_price);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = EN_UNIT[t.price_unit ?? ''];
  return `from ${n.toLocaleString('en-US')} RUB ${unit ?? '(price basis not specified)'}`;
}

export function landingDuration(t: LandingTourRow, lang: LandingLang): string | null {
  if (lang === 'zh-CN') return durationZh(t);
  const h = Number(t.duration_hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  const days = Math.round(h / 24);
  if (lang === 'ru') return h >= 24 ? `≈ ${days} дн.` : `≈ ${Math.round(h)} ч`;
  return h >= 24 ? `≈ ${days} day${days === 1 ? '' : 's'}` : `≈ ${Math.round(h)} h`;
}

export function landingSeason(t: LandingTourRow, lang: LandingLang): string | null {
  if (lang === 'zh-CN') { const s = seasonZh(t.season_start, t.season_end); return s ? `季节：${s}` : null; }
  const a = month(t.season_start); const b = month(t.season_end);
  if (!a || !b) return null;
  return lang === 'ru' ? `сезон: ${RU_MONTHS[a - 1]}–${RU_MONTHS[b - 1]}` : `season: ${EN_MONTHS[a - 1]}–${EN_MONTHS[b - 1]}`;
}

/** Ближайшая открытая дата или честное «по запросу» — не «нет мест» и не «в наличии». */
export function landingDates(t: LandingTourRow, lang: LandingLang): string {
  const d = t.next_open_date && /^\d{4}-\d{2}-\d{2}/.test(t.next_open_date) ? t.next_open_date.slice(0, 10) : null;
  if (lang === 'zh-CN') return d ? `最近开放日期：${d}` : '日期需向旅行社询问';
  if (lang === 'ru') return d ? `ближайшая открытая дата: ${d.split('-').reverse().join('.')}` : 'даты по запросу';
  return d ? `next open date: ${d}` : 'dates on request';
}

/**
 * ItemList из TouristTrip + FAQPage; без туров (null/пусто) — только FAQ.
 * Посадочная о трансфере вместо туров перечисляет перевозчиков (Organization
 * со ссылкой на их страницу); цен в разметке нет — прайс у каждого свой и за
 * машину, а не «от» за место.
 */
export function landingJsonLd(
  l: QueryLanding, tours: LandingTourRow[] | null, site: string, carriers: Pick<CharterCarrier, 'slug' | 'name'>[] | null = null,
  /** Вопросы, показанные на странице (landingFaq); нет — постоянные `l.faq`. */
  faq: readonly LandingFaq[] = l.faq,
): Record<string, unknown> {
  const graph: Record<string, unknown>[] = [{
    '@type': 'FAQPage',
    inLanguage: l.lang,
    mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  }];
  if (tours && tours.length > 0) {
    graph.push({
      '@type': 'ItemList',
      name: l.h1,
      numberOfItems: tours.length,
      itemListElement: tours.map((t, i) => {
        const price = Number(t.base_price);
        return {
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'TouristTrip',
            name: (l.lang === 'zh-CN' && t.title_zh) || t.title,
            url: `${site}${tourPath(t)}`,
            provider: { '@type': 'Organization', name: t.operator_name },
            ...(Number.isFinite(price) && price > 0
              ? { offers: { '@type': 'Offer', price: String(price), priceCurrency: 'RUB', url: `${site}${tourPath(t)}` } }
              : {}),
          },
        };
      }),
    });
  }
  if (carriers && carriers.length > 0) {
    graph.push({
      '@type': 'ItemList',
      name: l.h1,
      numberOfItems: carriers.length,
      itemListElement: carriers.map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        item: { '@type': 'Organization', name: c.name, url: `${site}${carrierPagePath(c.slug)}` },
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

// ── Числа страницы из её же туров (разбор видимости в ответах ИИ, 19.11) ────
//
// Ответы ИИ цитируют страницы, у которых число туров и цена «от» стоят в
// заголовке и первой строке. У посадочных Ведара заголовок был статичным
// («…: туры, цены от, даты» — без единого числа), а первая фраза одна на все.
// Числа берутся из тех же туров, что показаны списком ниже, — других
// источников у них нет, и разойтись со списком они не могут.

/** Цена «от» по туру с единицей; единицы не смешиваются. */
export interface LandingCheapest { price: number; unit: 'per_person' | 'per_tour' }

export interface LandingSummary {
  count: number;
  /** Сколько разных компаний ведут эти туры. */
  operators: number;
  /**
   * Самая низкая цена среди туров с ценой за человека; таких нет — среди
   * туров с ценой за группу; нет и их — null. «За человека» и «за группу» не
   * сравниваются: 30 000 за группу не дешевле 20 000 за человека.
   */
  cheapest: LandingCheapest | null;
  /** Ближайшая свободная дата среди туров, 'YYYY-MM-DD'; нет — null. */
  nearest: string | null;
  /** Годы свободных дат туров страницы словами («2026–2027»); дат нет или не прочитались — ''. */
  years: string;
}

function cheapestOf(tours: readonly LandingTourRow[], unit: LandingCheapest['unit']): LandingCheapest | null {
  let best: number | null = null;
  for (const t of tours) {
    if (t.price_unit !== unit) continue;
    const n = Number(t.base_price);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (best === null || n < best) best = n;
  }
  return best === null ? null : { price: best, unit };
}

/**
 * Сводка по турам страницы; не прочитались (null) или пусто — null.
 * `openYears` — годы, на которые у этих туров есть свободная дата
 * (`loadOpenDateYears`); null — не прочитались, и года в сводке нет.
 */
export function landingSummary(tours: readonly LandingTourRow[] | null, openYears: readonly number[] | null): LandingSummary | null {
  if (!tours || tours.length === 0) return null;
  const operators = new Set(tours.map((t) => t.operator_slug ?? t.operator_name)).size;
  const dates = tours
    .map((t) => (t.next_open_date && /^\d{4}-\d{2}-\d{2}/.test(t.next_open_date) ? t.next_open_date.slice(0, 10) : null))
    .filter((d): d is string => d !== null)
    .sort();
  return {
    count: tours.length,
    operators,
    cheapest: cheapestOf(tours, 'per_person') ?? cheapestOf(tours, 'per_tour'),
    nearest: dates[0] ?? null,
    years: openYearsLabel(openYears),
  };
}

function rub(n: number, lang: 'ru' | 'en'): string {
  return lang === 'ru' ? `${n.toLocaleString('ru-RU')} ₽` : `${n.toLocaleString('en-US')} RUB`;
}

function cheapestWords(c: LandingCheapest, lang: 'ru' | 'en'): string {
  if (lang === 'ru') return `от ${rub(c.price, 'ru')} ${c.unit === 'per_person' ? 'за человека' : 'за группу'}`;
  return `from ${rub(c.price, 'en')} ${c.unit === 'per_person' ? 'per person' : 'per group'}`;
}

function toursWord(n: number, lang: 'ru' | 'en'): string {
  return lang === 'ru' ? plural(n, 'тур', 'тура', 'туров') : (n === 1 ? 'tour' : 'tours');
}

/**
 * Заголовок страницы с числами: «Экскурсия в Долину гейзеров: 7 туров от
 * 45 000 ₽, 2026–2027». Туров нет или не прочитались — прежний заголовок без
 * чисел: число, которого нет, не пишется. Китайские страницы — без изменений.
 * Не помещается в TITLE_LIMIT — сперва без годов, потом без цены: число туров
 * остаётся всегда, обрезанный выдачей хвост хуже короткого целого.
 */
export function landingTitle(l: QueryLanding, s: LandingSummary | null): string {
  if (!s || !l.subject || l.lang === 'zh-CN') return l.title;
  const lang = l.lang;
  const price = s.cheapest ? ` ${lang === 'ru' ? 'от' : 'from'} ${rub(s.cheapest.price, lang)}` : '';
  const years = s.years ? `, ${s.years}` : '';
  const suffix = lang === 'en' ? ' | Vedar' : '';
  const count = `${l.h1}: ${s.count} ${toursWord(s.count, lang)}`;
  const variants = [`${count}${price}${years}`, `${count}${price}`, count].map((v) => `${v}${suffix}`);
  return variants.find((v) => v.length <= TITLE_LIMIT) ?? variants[variants.length - 1]!;
}

/**
 * Первая строка страницы — самостоятельное предложение с числами, которое
 * можно процитировать целиком: «Сейчас на Ведаре 7 туров в Долину гейзеров от
 * 3 компаний, цены от 45 000 ₽ за человека, ближайшая свободная дата —
 * 12.12.2026.» Без туров или без темы — null: первой строки из базы нет.
 */
export function landingLead(l: QueryLanding, s: LandingSummary | null): string | null {
  if (!s || !l.subject || l.lang === 'zh-CN') return null;
  if (l.lang === 'ru') {
    const parts = [`Сейчас на Ведаре ${s.count} ${toursWord(s.count, 'ru')} ${l.subject} от ${s.operators} ${plural(s.operators, 'компании', 'компаний', 'компаний')}`];
    if (s.cheapest) parts.push(`цены ${cheapestWords(s.cheapest, 'ru')}`);
    parts.push(s.nearest
      ? `ближайшая свободная дата — ${s.nearest.split('-').reverse().join('.')}`
      : 'свободных дат в расписании нет, даты — по запросу');
    return `${parts.join(', ')}.`;
  }
  const parts = [`Vedar currently lists ${s.count} ${toursWord(s.count, 'en')} ${l.subject} from ${s.operators} local ${s.operators === 1 ? 'operator' : 'operators'}`];
  if (s.cheapest) parts.push(`prices ${cheapestWords(s.cheapest, 'en')}`);
  parts.push(s.nearest ? `next open date ${s.nearest}` : 'no open dates in the schedule, dates on request');
  return `${parts.join(', ')}.`;
}
