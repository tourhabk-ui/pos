/**
 * Вкладка «Места»: мест по запросу нет — показываем маршруты по тому же
 * запросу (владелец 21.11). Сколько карточек и как подписать блок.
 */
export const ROUTE_FALLBACK_LIMIT = 8;
export const ROUTE_FALLBACK_HEADING = 'Мест не нашлось — вот маршруты по запросу';

/** Показывать ли блок: вкладка мест, есть запрос, мест ноль, ошибки нет. */
export function showRouteFallback(o: { kind: string; query: string; placesCount: number; loading: boolean; error: boolean }): boolean {
  return o.kind === 'place' && o.query.trim().length > 0 && o.placesCount === 0 && !o.loading && !o.error;
}
