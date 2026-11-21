/**
 * Строка тревоги места (`location_real_time_status.active_alerts`) и
 * заголовок тревоги (`external_alerts.title`) — как сопоставить (#3607, 21.11).
 *
 * Пересчёт safety-ingest пишет в строку места заголовок тревоги. У закрытия
 * парка, красного по опасности из описания, — заголовок и эту опасность
 * через `: ` («…маршруты закрыты на зимний сезон: передвижение в районах
 * вулканов крайне опасно»): иначе красный не объяснён. Значит, читатель,
 * который ищет тревогу места по заголовку, сравнивает не равенством, а этим
 * правилом. Строгое равенство молча теряло бы такое закрытие — например, из
 * офлайн-пакета маршрута (ревью #3631).
 */

/** Разделитель заголовка и дописанной опасности — тот же, что в SQL пересчёта. */
export const ALERT_HAZARD_SEPARATOR = ': ';

/** Строка места — это тревога с таким заголовком (с дописанной опасностью или без). */
export function alertLineIsTitle(line: string, title: string): boolean {
  return line === title || line.startsWith(title + ALERT_HAZARD_SEPARATOR);
}

/** То же правило в SQL: `line` и `title` — выражения SQL. */
export function alertLineIsTitleSql(line: string, title: string): string {
  return `(${line} = ${title} OR starts_with(${line}, ${title} || '${ALERT_HAZARD_SEPARATOR}'))`;
}
