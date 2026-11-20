/**
 * Длина маршрута словами — одно правило на карточку, Кузьмича, MCP и строку
 * маршрутов места (#3568).
 *
 * Паспорт маршрута называет длину вместе с тем, как её мерить: «60 км (в одну
 * сторону)», «7,3 км (в обе стороны)». Пометка лежит в `kamchatka_routes.
 * distance_note` (1472). Без неё «60 км» у озера Толмачева читается как длина
 * всей поездки, а это половина дороги. Пометку пишет миграция со словами
 * паспорта; нет пометки — число идёт как раньше, без догадки о стороне.
 */

function positiveKm(v: unknown): number | null {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** «60 км в одну сторону», «4.3 км»; длины нет — null. */
export function routeDistanceWords(km: unknown, note: string | null | undefined): string | null {
  const n = positiveKm(km);
  if (n === null) return null;
  const tail = (note ?? '').trim();
  return tail ? `${n} км ${tail}` : `${n} км`;
}

/**
 * Официальный паспорт из реестра visitkamchatka.ru, если маршрут записан с
 * ним как с источником, а ссылки на паспорт у маршрута нет (импорт клал PDF в
 * `source_url`, а `pdf_url` оставлял пустым — так у Малкинских источников).
 * Только PDF из каталога паспортов реестра: другой источник паспортом не
 * назовём.
 */
export function registryPassportPdf(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'visitkamchatka.ru') return null;
  return /^\/upload\/route_passports\/[^/]+\.pdf$/i.test(u.pathname) ? u.toString() : null;
}
