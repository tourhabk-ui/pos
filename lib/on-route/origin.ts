/**
 * lib/on-route/origin.ts — «откуда» отдельно от «куда» (владелец 27.08, PR 4).
 *
 * PR 1-3 развели цель (Destination) и путь (RouteOption) к ней. Но старт
 * пути молчаливо предполагался — «откуда-то», без записи. Origin называет
 * его так же явно, как Destination называет цель: текущая позиция, точка
 * на карте или сохранённое место — три независимых способа сказать
 * «отсюда», не одно неявное умолчание.
 *
 * Explicitly НЕ в этом шаге: построение пути между Origin и Destination
 * (шаг 5 роадмапа — своя инфраструктура, здесь её нет), OriginPicker не
 * запускает ориентирование и не трогает существующий routeOptions[] цели.
 */

export type Origin =
  | { kind: 'current'; lat: number; lon: number; accuracyM?: number }
  | { kind: 'coordinate'; lat: number; lon: number; title?: string }
  | { kind: 'place'; id: string; title: string; lat: number; lon: number };

/** Человеческая подпись старта — для карточки выбора и её сводки. */
export function originLabel(o: Origin): string {
  if (o.kind === 'current') return 'Текущая позиция';
  if (o.kind === 'place') return o.title;
  return o.title ?? 'Точка на карте';
}
