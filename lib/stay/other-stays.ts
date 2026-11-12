/**
 * lib/stay/other-stays.ts — «другое жильё на ваши даты» после ответа хозяина
 * «Занято» (план «после отказа», этап 5; слова владельца 11.11: «карт-бланш
 * по плану действуй»).
 *
 * До этого дня гость получал слова хозяина «на эти даты занято» и совет
 * «выбрать другое жильё на Ведаре». Что свободно в те же ночи, он искал сам.
 * Этот модуль отвечает на один вопрос: какое жильё в той же зоне может
 * принять на те же ночи.
 *
 * Правила — те, что уже есть на платформе, новых нет:
 *  - «рядом» — зона планера объекта заявки (`accommodations.planner_zone`,
 *    миграция 1031). Зона не размечена — «рядом» сказать нечем, и список не
 *    строится: по адресу и по названию зона не угадывается;
 *  - подбор — тот же, что у плана поездки (lib/planner/trip-extras-data):
 *    жильё с номерами, свободными на ВСЕ ночи по формуле каталога и брони, и
 *    жильё без номеров на Ведаре, где хозяин не закрыл ни одной из этих ночей.
 *    Второе свободным не называется: даты и цену подтверждает хозяин;
 *  - объект, по которому ответили «Занято», в список не идёт;
 *  - порядок — как у подбора плана: сначала жильё с номерами по календарю,
 *    затем жильё «по заявке хозяину»; внутри — сначала проверенные Ведаром,
 *    затем по оценке гостей и цене за ночь. Порядок назван человеку словами
 *    (lib/stay/other-stays-words);
 *  - имя и телефон гостя сюда не читаются и никому не передаются: в строке —
 *    ссылка на карточку объекта с подставленными датами и числом гостей, и
 *    заявку другому хозяину гость оставляет сам, со своим согласием.
 *
 * Исходы (§4.0): есть / нет / зона не размечена / «не прочиталось». Последний
 * не выдаётся за «нет».
 *
 * Только сервер. Сторожа: tests/unit/other-stays.test.ts (правило — вызовом),
 * tests/integration/request-chat.pg.test.ts (сцена «другое жильё на даты»).
 */
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';
import { ZONE_IDS, ZONE_NAMES, type ZoneId } from '@/lib/planner/constants';
import {
  findLodgingForStay, findRequestLodgingForStay, type CheckOutcome, type LodgingOption, type RequestLodgingOption,
} from '@/lib/planner/trip-extras-data';
import { stayLink } from '@/lib/stay/stay-link';

/** Что известно о ночах у объекта. */
export type OtherStayDates =
  /** По календарю Ведара номера свободны на все ночи. */
  | 'calendar'
  /** Номеров на Ведаре нет: хозяин эти ночи не закрывал, даты и цену подтверждает он. */
  | 'by_request';

/** Строка списка: объект, который может принять на те же ночи. */
export interface OtherStay {
  id: string;
  name: string;
  /** Тип из словаря объекта (`hotel`, `guesthouse`…) — слова ставит текст. */
  type: string;
  dates: OtherStayDates;
  /** Цена за ночь «от», ₽, как записана у объекта; null — не названа. */
  priceFrom: number | null;
  /**
   * Цена всех ночей на всю группу по формуле брони, ₽ — только у жилья с
   * номерами и только если группа помещается; иначе null (раскладку решает
   * хозяин, цену у жилья без номеров называет он).
   */
  stayTotal: number | null;
  /** Полный адрес карточки объекта с датами и числом гостей. */
  url: string;
}

export type OtherStays =
  | { state: 'ok'; zoneName: string; items: OtherStay[] }
  /** Искали и не нашли. */
  | { state: 'none' }
  /** У объекта заявки зона не размечена (или объекта уже нет): искать «рядом» негде. */
  | { state: 'unzoned' }
  | { state: 'failed' };

export interface OtherStaysArgs {
  /** Объект, по которому хозяин ответил «Занято». */
  accommodationId: string;
  checkIn: string;
  checkOut: string;
  /** Гостей в заявке; null — не записано (места считаются на одного). */
  guests: number | null;
}

export interface OtherStaysDeps {
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  rooms?: typeof findLodgingForStay;
  byRequest?: typeof findRequestLodgingForStay;
}

/** Зона объекта заявки. Объект сравнивается текстом: номер приходит из заявки. */
export const OTHER_STAYS_ZONE_SQL = `
  SELECT a.planner_zone
    FROM accommodations a
   WHERE a.id::text = $1::text`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isZone(v: unknown): v is ZoneId {
  return typeof v === 'string' && (ZONE_IDS as readonly string[]).includes(v);
}

function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

/**
 * Отбор и порядок — без базы, судится вызовом. Отказавший объект не
 * называется; сначала жильё с номерами по календарю, затем «по заявке
 * хозяину» — в том порядке, в каком их отдал подбор плана.
 */
export function pickOtherStays(args: {
  rooms: readonly LodgingOption[];
  byRequest: readonly RequestLodgingOption[];
  refusedId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  base: string;
}): OtherStay[] {
  const link = (id: string) => `${args.base}${stayLink(id, {
    checkIn: args.checkIn, checkOut: args.checkOut, adults: Math.min(Math.max(1, args.guests), 20), children: 0,
  })}`;
  const seen = new Set<string>([args.refusedId]);
  const out: OtherStay[] = [];
  for (const r of args.rooms) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id, name: r.name, type: r.type, dates: 'calendar', priceFrom: r.priceFrom,
      stayTotal: r.stay.kind === 'priced' ? r.stay.total : null, url: link(r.id),
    });
  }
  for (const r of args.byRequest) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, name: r.name, type: r.type, dates: 'by_request', priceFrom: r.priceFrom, stayTotal: null, url: link(r.id) });
  }
  return out;
}

/** Жильё в зоне объекта заявки, которое может принять `guests` гостей на те же ночи. */
export async function loadOtherStays(args: OtherStaysArgs, deps: OtherStaysDeps = {}): Promise<OtherStays> {
  if (!args.accommodationId || !ISO_DAY.test(args.checkIn) || !ISO_DAY.test(args.checkOut) || args.checkOut <= args.checkIn) {
    return { state: 'none' };
  }
  const guests = args.guests !== null && Number.isFinite(args.guests) && args.guests > 0 ? Math.trunc(args.guests) : 1;
  const q = deps.query ?? ((sql: string, params?: unknown[]) => pool.query(sql, params));
  let zone: unknown;
  try {
    zone = ((await q(OTHER_STAYS_ZONE_SQL, [args.accommodationId])).rows[0] as { planner_zone: string | null } | undefined)?.planner_zone;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[other-stays] зона объекта заявки не прочитана', { sqlstate: typeof code === 'string' ? logText(code, 10) : null });
    return { state: 'failed' };
  }
  if (!isZone(zone)) return { state: 'unzoned' };

  const stay = { zone, checkIn: args.checkIn, checkOut: args.checkOut, nights: nightsBetween(args.checkIn, args.checkOut) };
  const [rooms, byRequest] = await Promise.all([
    (deps.rooms ?? findLodgingForStay)(stay, guests),
    (deps.byRequest ?? findRequestLodgingForStay)(stay),
  ]);
  // Одна из двух половин не прочиталась — список неполон, и «нет» по нему сказать нельзя.
  if (rooms.state === 'unavailable' || byRequest.state === 'unavailable') return { state: 'failed' };
  const itemsOf = <T,>(o: CheckOutcome<T>): T[] => (o.state === 'ok' ? o.items : []);
  const items = pickOtherStays({
    rooms: itemsOf(rooms), byRequest: itemsOf(byRequest), refusedId: args.accommodationId,
    checkIn: args.checkIn, checkOut: args.checkOut, guests, base: getPublicBaseUrl(),
  });
  if (items.length === 0) return { state: 'none' };
  return { state: 'ok', zoneName: ZONE_NAMES[zone], items };
}
