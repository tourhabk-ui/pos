/**
 * ПОИСК · туры по свободной строке — для поиска в шапке (`/api/search`) и
 * блока «Туры по запросу» на `/routes` (аудит П7, находки #1/#97/#106/#111).
 *
 * Это НЕ новый движок подбора (§4, «три движка»): здесь нет своего SQL и
 * своего ранжирования. Строка разбирается на два фильтра, которые уже умеет
 * `queryMarketplaceTours` (`lib/search/tour-search`), и выдача двух вызовов
 * склеивается без повторов:
 *
 *   1. `search`        — ILIKE по названию и описанию, как в каталоге;
 *   2. `activity_type` — если слово запроса называет вид активности
 *                        единого словаря `lib/tours/labels` («рыбалка» →
 *                        `fishing`, «сплав» → `rafting`).
 *
 * Зачем второй фильтр. Замер 24.09 на живых турах: «рыбалка» по названию и
 * описанию находит три тура из семи рыболовных — у остальных в тексте
 * «рыболовный тур», «рыбалки», «семейный отдых». Турист, набравший вид
 * отдыха, ищет вид отдыха, а не подстроку.
 *
 * Сопоставление с подписью — по основе слова, а не по равенству: «рыбалку»,
 * «рыбалкой», «сплавы» — один и тот же запрос. Основа — слово без двух
 * последних букв, не короче четырёх; слова короче четырёх букв не
 * сопоставляются вовсе («тур», «на» подошли бы к половине словаря).
 */

import { ACTIVITY_LABELS, ACTIVITY_SHORT } from '@/lib/tours/labels';
import {
  MarketplaceToursQuerySchema,
  queryMarketplaceTours,
  type MarketplaceTourRow,
} from './tour-search';

const MIN_WORD = 4;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/i)
    .filter(w => w.length >= MIN_WORD);
}

function stem(w: string): string {
  return w.slice(0, Math.max(MIN_WORD, w.length - 2));
}

/**
 * Какие `activity_type` называет строка запроса. Пустой массив — ни одного;
 * это не отказ, а «вид активности в запросе не назван».
 */
export function activityTypesForQuery(q: string): string[] {
  const stems = words(q).map(stem);
  if (stems.length === 0) return [];
  const out: string[] = [];
  const dicts = [ACTIVITY_LABELS, ACTIVITY_SHORT];
  const keys = new Set<string>([...Object.keys(ACTIVITY_LABELS), ...Object.keys(ACTIVITY_SHORT)]);
  for (const key of keys) {
    const labelWords = dicts.flatMap(d => (d[key] ? words(d[key]) : []));
    if (labelWords.some(lw => stems.some(s => lw.startsWith(s)))) out.push(key);
  }
  return out;
}

/**
 * Живые туры витрины по строке запроса: сначала совпавшие текстом, затем
 * совпавшие видом активности. Отказ БД не глушится — бросает вызывающему,
 * и тот обязан назвать его (§4.0), а не показать «туров нет».
 */
export async function findToursForQuery(q: string, limit: number): Promise<MarketplaceTourRow[]> {
  const text = q.trim();
  if (!text) return [];
  const base = { limit, sort: 'recommended' as const };
  const calls = [
    queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ ...base, search: text })),
    ...activityTypesForQuery(text).map(activity_type =>
      queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ ...base, activity_type })),
    ),
  ];
  const results = await Promise.all(calls);
  const seen = new Set<string>();
  const out: MarketplaceTourRow[] = [];
  for (const r of results) {
    for (const t of r.tours) {
      const id = String(t.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(t);
    }
  }
  return out.slice(0, limit);
}

/**
 * «от 25 000 ₽» — только из настоящей цены. Нет цены или она не число —
 * null, и подпись цены не рисуется (§4.0: не «от 0 ₽»).
 */
export function tourPriceFrom(price: unknown): string | null {
  const n = typeof price === 'number' ? price : typeof price === 'string' ? Number(price) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `от ${Math.round(n).toLocaleString('ru-RU')} ₽`;
}
