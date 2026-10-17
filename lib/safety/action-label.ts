/**
 * Подпись рекомендуемого действия зоны для человека.
 *
 * Расчётная оценка (danger_assessments) эвакуацию не объявляет: слово
 * «эвакуация» вправе показывать только официальное сообщение МЧС об
 * эвакуации. 18.10.2026 расчёт сложил баллы трёх вулканов и дал Северной
 * зоне 80 — «Немедленная эвакуация» при нуле туристов и тексте «угрозы
 * нет» в той же оценке. Поэтому EVACUATE_* от расчёта показывается как
 * «Требуется контроль маршрутов», а настоящее слово остаётся для вызова
 * с officialEvacuation = true.
 */
export const ROUTE_CONTROL_ACTION = 'ROUTE_CONTROL';

const EVACUATE_ACTIONS = new Set(['EVACUATE_PRIORITY_2', 'EVACUATE_IMMEDIATE']);

/** Действие, которое можно показать наружу. Расчёт эвакуацией не становится. */
export function displayRecommendedAction(
  action: string,
  officialEvacuation = false,
): string {
  if (!officialEvacuation && EVACUATE_ACTIONS.has(action)) return ROUTE_CONTROL_ACTION;
  return action;
}

export function actionLabel(action: string, officialEvacuation = false): string {
  const shown = displayRecommendedAction(action, officialEvacuation);
  switch (shown) {
    case 'NORMAL': return '';
    case 'WATCH': return 'Наблюдение';
    case ROUTE_CONTROL_ACTION: return 'Требуется контроль маршрутов';
    case 'EVACUATE_PRIORITY_2': return 'Эвакуация (P2)';
    case 'EVACUATE_IMMEDIATE': return 'Немедленная эвакуация';
    default: return '';
  }
}
