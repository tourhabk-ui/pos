/**
 * «Похожие маршруты» на карточке маршрута — с сервера и по кольцу (13.10).
 *
 * ── Почему не как было ────────────────────────────────────────────────────
 *
 * Блок собирался в браузере после загрузки (`useEffect` → `/api/routes`),
 * поэтому в первом HTML карточки маршрута не было НИ ОДНОЙ ссылки на другие
 * маршруты. И набор не зависел от самого маршрута: у всех маршрутов одного
 * занятия — одна и та же верхняя четвёрка каталога. Перепись sitemap
 * (прогон 6, 13.10) насчитала 95 маршрутов, на которые не ссылается ни одна
 * страница sitemap: карточки маршрутов друг на друга не ссылались вовсе,
 * а категории, парки и первая страница списка берут по 12–24 первых.
 *
 * ── Правило ───────────────────────────────────────────────────────────────
 *
 * Группа — маршруты того же занятия (`activity_type`; у маршрута без
 * занятия — такие же без занятия). Внутри группы порядок по названию, и
 * карточка показывает K маршрутов, СЛЕДУЮЩИХ за ней, с переходом через
 * конец списка. Так у каждого маршрута группы из n ≥ 2 есть min(K, n − 1)
 * входящих ссылок — от предшественников по кольцу, — и это свойство
 * правила, а не удачи данных. Порядок по названию — потому что он не
 * меняется от просмотров и правок описаний: граф ссылок не перетряхивается
 * при каждом обновлении кэша.
 *
 * Сторож: tests/unit/related-routes.test.tsx.
 */
import { unstable_cache } from 'next/cache';
import { CatalogQuerySchema, queryCatalog, type CatalogItem } from '@/lib/routes/catalog-query';

/** Сколько соседей показывает карточка. */
export const RELATED_K = 4;

/**
 * K элементов, следующих за `id` в упорядоченной группе, с переходом через
 * конец; сам элемент не входит. Нет `id` в группе — первые K: показать
 * похожие всё равно можно, а гарантию входящих даёт только член кольца.
 */
export function ringNeighbors<T extends { id: string }>(ordered: readonly T[], id: string, k: number = RELATED_K): T[] {
  const at = ordered.findIndex((x) => x.id === id);
  const others = ordered.filter((x) => x.id !== id);
  if (others.length === 0 || k <= 0) return [];
  if (at < 0) return others.slice(0, k);
  // Без себя элемент, шедший следом, оказывается на месте `at`.
  return Array.from({ length: Math.min(k, others.length) }, (_, j) => others[(at + j) % others.length]);
}

/** Строка каталога без тяжёлого: линия маршрута и длинное описание карточке соседа не нужны. */
export type RelatedRoute = Omit<CatalogItem, 'geometry'> & { geometry: null };

function light(item: CatalogItem): RelatedRoute {
  return { ...item, geometry: null, description: item.description.slice(0, 300) };
}

/**
 * Все видимые маршруты каталога по названию — одним запросом на всех.
 * Кэш общий для всех карточек: кольцо одно, страницы берут из него соседей.
 */
const loadRing = unstable_cache(
  async (): Promise<RelatedRoute[]> => {
    const filters = CatalogQuerySchema.parse({ kind: 'route', sort: 'title', limit: 2000 });
    const { items } = await queryCatalog(filters);
    return items.filter((i) => i.kind === 'route').map(light);
  },
  ['related-routes-ring-v1'],
  { revalidate: 600 },
);

/** Похожие маршруты карточки: соседи по кольцу в группе того же занятия. */
export async function relatedRoutesFor(route: { id: string; activityType: string | null }, k: number = RELATED_K): Promise<RelatedRoute[]> {
  const ring = await loadRing();
  const group = ring.filter((r) => (r.activityType ?? null) === (route.activityType ?? null));
  return ringNeighbors(group, route.id, k);
}
