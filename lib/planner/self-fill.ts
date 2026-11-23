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
import { NO_SELF_ROUTE_DAY_TITLE, NO_TOUR_DAY_TITLE } from '@/lib/planner/honest-days';
import {
  emptyLedger, noteGap, noteVariety, pickVariedPlace, placeVarietyKey, varietyKey,
  type VarietyLedger,
} from '@/lib/planner/day-variety';

/**
 * Типы мест для дня без гида: город и окрестности, без восхождений.
 * Зимой бухта и мыс — смотреть океан, не купаться: пляж по-прежнему только
 * в тёплый сезон. Ездовых собак отдельным типом места нет — день про них
 * появляется, только если такое место или тур уже есть в каталоге.
 */
const SELF_TYPES_ALL_YEAR = ['museum', 'historical', 'ethnic', 'viewpoint', 'hot_spring', 'settlement', 'bay', 'cape'];
const SELF_TYPES_WARM = ['beach', 'park', 'waterfall'];
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

/** Тёплый сезон — май…октябрь: пляж зимой не прогулка. Бухта и мыс остаются. */
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
          AND p.slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND COALESCE(sp.registration_required, FALSE) = FALSE
          AND COALESCE(sp.sat_communicator_required, FALSE) = FALSE
          AND 111.0 * sqrt(power(p.lat - $2, 2) + power((p.lng - $3) * cos(radians($2)), 2)) <= $4
        ORDER BY power(p.lat - $2, 2) + power((p.lng - $3) * cos(radians($2)), 2), p.name
        LIMIT $5`,
      [selfTypesFor(month), PKC[0], PKC[1], SELF_RADIUS_KM, limit],
    );
    return rows.flatMap((r) => {
      const href = publicPlacePath(r.slug);
      if (!href) return [];
      return [{
        name: r.name,
        href,
        type: r.location_type,
        lat: Number(r.lat),
        lng: Number(r.lng),
      }];
    });
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
    placeKind: place.type,
  };
}

/** День с туром или местом каталога учитывается в разнообразии. Остальное — разрыв. */
function absorbDay(ledger: VarietyLedger, day: DayPlan): void {
  if (day.type === 'activity' && day.realTour) {
    noteVariety(ledger, varietyKey(day.activityType), 1);
    return;
  }
  if (day.type === 'activity' && day.placeKind) {
    noteVariety(ledger, placeVarietyKey(day.placeKind), 1);
    return;
  }
  noteGap(ledger);
}

/**
 * Дни 1..tripDays: недостающие — самостоятельными местами по кругу (место
 * не повторяется, пока есть другие). Нечем заполнить — дни как были.
 * Порядок дней — по номеру.
 */
export function fillEmptyDays(days: readonly DayPlan[], tripDays: number, places: readonly SelfPlace[] | null, site: string): { days: DayPlan[]; filled: number[] } {
  const pool = places ?? [];
  if (pool.length === 0) return { days: [...days], filled: [] };
  const taken = new Set<string>();
  for (const d of days) {
    if (!d.placeHref) continue;
    taken.add(d.placeHref.startsWith(site) ? d.placeHref.slice(site.length) : d.placeHref);
  }
  const byDay = new Map(days.map((d) => [d.day, d]));
  const ledger = emptyLedger();
  const out: DayPlan[] = [];
  const filled: number[] = [];
  for (let n = 1; n <= tripDays; n++) {
    const existing = byDay.get(n);
    if (existing) {
      out.push(existing);
      absorbDay(ledger, existing);
      continue;
    }
    const place = pickVariedPlace(pool, ledger, taken, tripDays);
    if (!place) {
      noteGap(ledger);
      continue;
    }
    taken.add(place.href);
    noteVariety(ledger, placeVarietyKey(place.type), 1);
    out.push(selfPlaceDay(n, place, site));
    filled.push(n);
  }
  for (const d of days) {
    if (d.day < 1 || d.day > tripDays) out.push(d);
  }
  out.sort((a, b) => a.day - b.day);
  return { days: out, filled };
}

const PLACE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Адрес места по записанному slug. UUID и пустой slug ссылкой не становятся: страница по ним есть, но в плане такой адрес уже рвался. */
export function publicPlacePath(slug: string | null | undefined): string | null {
  const s = (slug ?? '').trim();
  if (!s || UUID_RE.test(s) || !PLACE_SLUG.test(s) || s.length > 80) return null;
  return `/places/${s}`;
}

const FREE_DAY_TITLES = new Set([NO_TOUR_DAY_TITLE, NO_SELF_ROUTE_DAY_TITLE]);

/**
 * Дни с заголовком «на своё усмотрение» в Авачинской зоне получают место из
 * каталога (музей, смотровая, источник). Это не тур и не бронь. Мест нет
 * или база не ответила (`null`) — дни как были.
 */
export function assignCatalogFreeDays(days: readonly DayPlan[], places: readonly SelfPlace[] | null, site: string): DayPlan[] {
  if (!places || places.length === 0) return [...days];
  const used = new Set(days.map((d) => d.placeHref).filter((h): h is string => Boolean(h)));
  const pool = places.filter((p) => p.href.startsWith('/places/') && !used.has(`${site}${p.href}`));
  if (pool.length === 0) return [...days];
  const taken = new Set<string>();
  const ledger = emptyLedger();
  const indexed = days.map((d, i) => ({ d, i }));
  indexed.sort((a, b) => a.d.day - b.d.day);
  const out = [...days];
  for (const item of indexed) {
    const d = item.d;
    const freeHere = FREE_DAY_TITLES.has(d.title) && (d.zone === 'avachinsky' || d.zoneShown === 'avachinsky');
    if (!freeHere) {
      absorbDay(ledger, d);
      continue;
    }
    const place = pickVariedPlace(pool, ledger, taken, Math.max(...days.map((x) => x.day), 1));
    if (!place) {
      noteGap(ledger);
      continue;
    }
    taken.add(place.href);
    noteVariety(ledger, placeVarietyKey(place.type), 1);
    const made = selfPlaceDay(d.day, place, site);
    out[item.i] = {
      ...made,
      zone: d.zone,
      ...(d.zoneShown ? { zoneShown: d.zoneShown } : {}),
      weatherPoint: [place.lat, place.lng] as [number, number],
    };
  }
  return out;
}
