/**
 * Календарная справка для промпта Кузьмича: сегодня, день недели, ближайшие
 * выходные и следующие 14 дней по Камчатке (UTC+12, без перехода на летнее).
 * Экзамен 22.10.2026: в A2A даты в промпте не было вовсе, и модель считала
 * сама («до 15 ноября 15 дней», «суббота 25.10», «ноябрь 2025»).
 */
const TZ_OFFSET_MS = 12 * 3600 * 1000;
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function local(now: number): Date { return new Date(now + TZ_OFFSET_MS); }
function fmt(d: Date): string { return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} (${WD[d.getUTCDay()]})`; }
function addDays(d: Date, n: number): Date { return new Date(d.getTime() + n * 86400000); }

export function kamchatkaDateContext(now: number = Date.now()): string {
  const today = local(now);
  const dow = today.getUTCDay();
  const toSat = dow === 0 ? -1 : 6 - dow; // в воскресенье «ближайшие выходные» — текущие
  const sat = addDays(today, toSat);
  const sun = addDays(sat, 1);
  const hh = String(today.getUTCHours()).padStart(2, '0');
  const mm = String(today.getUTCMinutes()).padStart(2, '0');
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = addDays(today, i + 1);
    return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, '0')} ${WD[d.getUTCDay()].slice(0, 2)}`;
  }).join(', ');
  return [
    `СЕГОДНЯ: ${fmt(today)}, ${hh}:${mm} по Камчатке (UTC+12).`,
    `Ближайшие выходные: ${fmt(sat)} и ${fmt(sun)}.`,
    `Следующие 14 дней: ${days}.`,
    'Дни недели, даты и число дней до даты бери ТОЛЬКО из этой справки или считай от СЕГОДНЯ; год без явного указания — текущий или следующий, никогда не прошедший.',
  ].join('\n');
}
