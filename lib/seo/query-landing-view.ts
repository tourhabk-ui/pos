/**
 * Подписи и разметка посадочных страниц — чистые функции над строками базы,
 * чтобы сторож проверял их без рендера и без базы.
 */
import { priceFromUnit } from '@/lib/tours/price-label';
import { priceZh, durationZh, seasonZh } from '@/lib/zh/entry';
import { tourPath } from '@/lib/tours/tour-url';
import type { LandingTourRow } from '@/lib/seo/query-landings-data';
import type { LandingLang, QueryLanding } from '@/lib/seo/query-landings';

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
  if (lang === 'ru') return priceFromUnit(t.base_price, t.price_unit);
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

/** ItemList из TouristTrip + FAQPage; без туров (null/пусто) — только FAQ. */
export function landingJsonLd(l: QueryLanding, tours: LandingTourRow[] | null, site: string): Record<string, unknown> {
  const graph: Record<string, unknown>[] = [{
    '@type': 'FAQPage',
    inLanguage: l.lang,
    mainEntity: l.faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
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
  return { '@context': 'https://schema.org', '@graph': graph };
}
