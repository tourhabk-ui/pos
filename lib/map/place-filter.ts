/**
 * Чип фильтра мест на /map → роды мест, которые он показывает. Один
 * источник для списка мест над картой и для слоя самой карты.
 *
 * ── «Леса и парки» без парков (14.10) ─────────────────────────────────────
 *
 * Чип сверял род места равенством: `forest` — только `forest`. Пока
 * заповедники и парки числились «лесными массивами», он их показывал.
 * Миграции 1240, 1243 и 1246 дали Кроноцкому и Корякскому заповедникам,
 * Командорам и «Быстринскому» свои роды — `reserve`, `national_park`,
 * `park`, — и чип с подписью «Леса и парки» перестал показывать парки.
 * Состав чипа назван здесь словами, а не выведен из подписи.
 */

export const PLACE_FILTER_KINDS: Readonly<Record<string, readonly string[]>> = {
  forest: ['forest', 'park', 'reserve', 'national_park'],
};

/** Роды мест чипа: свой состав, если он назван, иначе один род по имени чипа. */
export function placeFilterKinds(filter: string): readonly string[] {
  return PLACE_FILTER_KINDS[filter] ?? [filter];
}

/** Попадает ли место в чип — по его роду (`location_type`). */
export function placeMatchesFilter(kind: string | null | undefined, filter: string): boolean {
  return kind != null && placeFilterKinds(filter).includes(kind);
}

/** Выражение фильтра MapLibre по `kind` слоя мест — тот же состав чипа. */
export function placeKindFilterExpr(filter: string): unknown[] {
  const kinds = placeFilterKinds(filter);
  return kinds.length === 1
    ? ['==', ['get', 'kind'], kinds[0]]
    : ['in', ['get', 'kind'], ['literal', [...kinds]]];
}
