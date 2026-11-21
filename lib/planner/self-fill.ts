/**
 * Пустые дни плана — самостоятельными местами из базы (тест планировщика
 * владельца 21.11).
 *
 * Было: план «на 7 дней» приходил с «День 6. Не заполнен — придумывать не
 * стали», а страница /trip/… показывала шесть дней: дня в черновике не было
 * вовсе. Человек просил неделю и получал дыру.
 *
 * Стало: каждый день 1..N есть и в чате, и в черновике. День, который движок
 * не наполнил, получает место из нашей базы мест (/places/…), куда можно
 * без гида и без регистрации в МЧС: музей, смотровая, пляж, источник рядом
 * с Петропавловском. Это не тур и не цена — день так и подписан
 * «самостоятельно», у него нет суммы. Не нашлось мест (база не ответила) —
 * день остаётся пустым, как раньше, и об этом сказано (§4.0).
 */
import { pool } from '@/lib/db-pool';
import type { DayPlan } from '@/lib/planner/engine';

/** Типы мест для дня без гида: город и окрестности, без восхождений. */
const SELF_TYPES_ALL_YEAR = ['museum', 'historical', 'ethnic', 'viewpoint', 'hot_spring', 'settlement'];
const SELF_TYPES_WARM = ['beach', 'bay', 'park', 'waterfall'];
/** Не дальше от Петропавловска, км: день без переезда. */
const SELF_RADIUS_KM = 45;
const PKC: [number, number] = [53.0452, 158.6483];

export interface SelfPlace {
  name: string;
  href: string;
  type: string;
  lat: number;
  lng: number;
}

/** Тёплый сезон — май…октябрь: пляж и бухта зимой — не прогулка. */
export function selfTypesFor(month: number): string[] {
  return month >= 5 && month <= 10 ? [...SELF_TYPES_ALL_YEAR, ...SELF_TYPES_WARM] : SELF_TYPES_ALL_YEAR;
}

/**
 * Места для самостоятельного дня: видимые, не слитые, рядом с городом, без
 * требования регистрации и спутниковой связи в профиле безопасности.
 * `null` — база не ответила.
 */
export async function fetchSelfFillPlaces(month: number, limit = 12): Promise<SelfPlace[] | null> {
  try {
    const { rows } = await pool.query<{ name: string; slug: string | null; ark_id: string | null; id: string; location_type: string; lat: string; lng: string }>(
      `SELECT p.id::text AS id, p.slug, p.ark_id::text AS ark_id, p.name, p.location_type, p.lat::text AS lat, p.lng::text AS lng
         FROM places p
         LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
        WHERE p.is_visible = TRUE AND p.merged_into_id IS NULL
          AND p.location_type = ANY($1::text[])
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND COALESCE(sp.registration_required, FALSE) = FALSE
          AND COALESCE(sp.sat_communicator_required, FALSE) = FALSE
          AND 111.0 * sqrt(power(p.lat - $2, 2) + power((p.lng - $3) * cos(radians($2)), 2)) <= $4
        ORDER BY power(p.lat - $2, 2) + power((p.lng - $3) * cos(radians($2)), 2), p.name
        LIMIT $5`,
      [selfTypesFor(month), PKC[0], PKC[1], SELF_RADIUS_KM, limit],
    );
    return rows.map((r) => ({
      name: r.name,
      href: `/places/${(r.slug ?? '').trim() || (r.ark_id ?? '').trim() || r.id}`,
      type: r.location_type,
      lat: Number(r.lat),
      lng: Number(r.lng),
    }));
  } catch (err) {
    console.error('[planner] места для самостоятельного дня не прочитались:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Самостоятельный день по месту. Цены нет: её не у кого спросить. */
export function selfPlaceDay(day: number, place: SelfPlace, site: string): DayPlan {
  return {
    day,
    type: 'activity',
    activityMode: 'self',
    zone: 'avachinsky',
    title: `Самостоятельно: ${place.name}`,
    description: `День без тура: место из нашей базы рядом с Петропавловском, без гида. Карточка места: ${site}${place.href}`,
    activityType: 'self_place',
    priceFrom: 0,
    priceTo: 0,
    coords: [place.lat, place.lng],
    defaultTransport: 'walking',
    allowedTransports: ['walking'],
    difficulty: 'easy',
    childFriendly: true,
    minChildAge: 0,
    dayWarnings: [],
    placeHref: `${site}${place.href}`,
  };
}

/**
 * Дни 1..tripDays: недостающие — самостоятельными местами по кругу (место
 * не повторяется, пока есть другие). Нечем заполнить — дни как были.
 * Порядок дней — по номеру.
 */
export function fillEmptyDays(days: readonly DayPlan[], tripDays: number, places: readonly SelfPlace[] | null, site: string): { days: DayPlan[]; filled: number[] } {
  const have = new Set(days.map((d) => d.day));
  const used = new Set(days.map((d) => d.placeHref).filter(Boolean) as string[]);
  const pool = (places ?? []).filter((p) => !used.has(`${site}${p.href}`));
  const out = [...days];
  const filled: number[] = [];
  if (pool.length === 0) return { days: out, filled };
  let k = 0;
  for (let n = 1; n <= tripDays; n++) {
    if (have.has(n)) continue;
    out.push(selfPlaceDay(n, pool[k % pool.length], site));
    filled.push(n);
    k++;
  }
  out.sort((a, b) => a.day - b.day);
  return { days: out, filled };
}
