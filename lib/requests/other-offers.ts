/**
 * lib/requests/other-offers.ts — «другие компании к этому месту на вашу дату»
 * (план «после отказа», этап 4а; слова владельца 11.11: «передавать другим —
 * да», «карт-бланш по плану действуй»).
 *
 * После отказа оператора человек получал его ответ и свободные даты ТОГО ЖЕ
 * тура. Кто ещё может взять его в этот день, он должен был искать сам. Этот
 * модуль отвечает на один вопрос: какие туры ДРУГИХ компаний идут к тому же
 * месту и могут принять на дату заявки.
 *
 * Правила — те, что уже есть на платформе, новых нет:
 *  - «к тому же месту» — только записанная связь: главное место отказанного
 *    тура (`operator_tours.main_place_id`) и туры, которые карточка места
 *    показывает в «Туры к этому месту» (lib/places/place-tours, `goesToPlace`).
 *    Связь по имени или по близости не выводится (§4.1);
 *  - «может принять на дату» — календарь тура, тем же условием свободы, что у
 *    всех витрин (lib/tours/nearest-free-date): мест хватает на число людей
 *    заявки. Тур без календаря («даты по заявке») в списке остаётся, если дата
 *    не выходит из записанного сезона и не закрыта в его календаре, и назван
 *    так: дату подтверждает оператор. Тур с календарём, но без мест на эту
 *    дату, и тур, у которого эта дата закрыта (оператором или платформой), не
 *    называются;
 *  - список — по компаниям: человек выбирает, кому оставить заявку. У
 *    компании назван один тур (первый по правилу 1в) и сказано, сколько у неё
 *    ещё подходящих;
 *  - порядок — правило 1в (lib/tours/offer-order, группы по компаниям):
 *    сначала компании, у которых в календаре есть места на дату, затем
 *    остальные; внутри каждой группы — жребий дня компании. Продавца Ведар не
 *    выбирает: список с номерами, заявку человек оставляет сам;
 *  - телефон и имя человека сюда не читаются и никому не передаются: в списке
 *    — ссылка на форму тура с подставленными датой и числом людей, и заявку
 *    другой компании человек оставляет сам, со своим согласием.
 *
 * Три исхода (§4.0): есть / нет / «не прочиталось». Третий не выдаётся за
 * второй — вызывающий решает, что с ним делать (в сообщении блока просто нет,
 * отказ записан в лог).
 *
 * Только сервер. Сторожа: tests/unit/other-offers.test.ts (правило — вызовом),
 * tests/integration/request-chat.pg.test.ts (сцена «другие компании на дату»).
 */
import { pool } from '@/lib/db-pool';
import { getPublicBaseUrl } from '@/lib/config';
import { logText } from '@/lib/log/log-text';
import { goesToPlace, loadPlaceTours, type PlaceTourOffer, type PlaceToursResult } from '@/lib/places/place-tours';
import { loadToursOnDate, type ToursOnDate } from '@/lib/tours/nearest-free-date';
import { groupOffersByCompany, offerOrderDay } from '@/lib/tours/offer-order';
import { priceWithUnitWords } from '@/lib/tours/price-label';
import { tourBookingFormPath } from '@/lib/tours/tour-url';
import { ruPlacePath } from '@/lib/zh/pages';

/** Сколько компаний называется в списке; остальные — числом и ссылкой на карточку места. */
export const OTHER_OFFERS_MAX = 5;

/** Строка списка: компания и её первый по правилу 1в тур, который может принять на дату. */
export interface OtherOffer {
  partnerName: string;
  tourId: string;
  title: string;
  /** Цена словами с единицей; null — не записана. */
  price: string | null;
  /**
   * `calendar` — в календаре тура на эту дату хватает мест на всю группу;
   * `by_request` — календаря у тура нет, дату подтверждает оператор.
   */
  seats: 'calendar' | 'by_request';
  /** Полный адрес формы заявки тура с датой и числом людей. */
  url: string;
  /** Сколько ещё туров этой компании к месту могут принять на дату. */
  moreTours: number;
}

export type OtherOffers =
  | {
    state: 'ok';
    placeName: string;
    /** Полный адрес «Туры к этому месту» на карточке места. */
    placeUrl: string;
    offers: OtherOffer[];
    /** Сколько компаний с подходящими турами в список не вошло. */
    more: number;
  }
  | { state: 'none' }
  | { state: 'failed' };

export interface OtherOffersDeps {
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  placeTours?: (placePk: string, opts?: { now?: Date }) => Promise<PlaceToursResult>;
  onDate?: (tourIds: readonly string[], date: string, people: number) => Promise<ToursOnDate>;
  now?: Date;
}

/**
 * Отказанный тур: чей он и к какому месту идёт. Место — только видимое и не
 * слитое, как у строки «к месту ещё N предложений» карточки тура.
 */
export const OTHER_OFFERS_TOUR_SQL = `
  SELECT ot.operator_id::text AS operator_id,
         pl.id::text AS place_id, pl.name AS place_name, pl.slug AS place_slug, pl.ark_id::text AS place_ark_id
    FROM operator_tours ot
    JOIN places pl ON pl.id = ot.main_place_id AND pl.is_visible = TRUE AND pl.merged_into_id IS NULL
   WHERE ot.id = $1::bigint`;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Тур «по заявке» вне записанного сезона на эту дату не называется: сезон —
 * слова оператора о том, когда он ходит. Сезон не записан — границы нет.
 */
function inSeason(o: Pick<PlaceTourOffer, 'seasonStart' | 'seasonEnd'>, date: string): boolean {
  const from = o.seasonStart?.slice(0, 10) ?? null;
  const to = o.seasonEnd?.slice(0, 10) ?? null;
  if (from && ISO_DAY.test(from) && date < from) return false;
  if (to && ISO_DAY.test(to) && date > to) return false;
  return true;
}

/**
 * Тур другой компании к этому месту: связь «к месту» записана, это не
 * отказанный тур и не тур отказавшей компании. Одно место на отбор и на
 * вопрос к календарю.
 */
export function isOtherCompanyOffer(
  o: Pick<PlaceTourOffer, 'id' | 'partnerId' | 'linkKind'>, refusedTourId: string, refusedPartnerId: string,
): boolean {
  return goesToPlace(o) && o.id !== refusedTourId && o.partnerId !== refusedPartnerId;
}

/**
 * Отбор и порядок — без базы, судится вызовом. `offers` — туры места,
 * `free` — у кого из них в календаре хватает мест на дату, `closed` — у кого
 * эта дата в календаре закрыта.
 */
export function pickOtherOffers(args: {
  offers: readonly PlaceTourOffer[];
  free: ReadonlySet<string>;
  closed: ReadonlySet<string>;
  refusedTourId: string;
  refusedPartnerId: string;
  date: string;
  people: number;
  day: string;
  base: string;
}): { offers: OtherOffer[]; more: number } {
  const able = args.offers
    .filter((o) => isOtherCompanyOffer(o, args.refusedTourId, args.refusedPartnerId))
    .filter((o) => (o.keepsSchedule ? args.free.has(o.id) : !args.closed.has(o.id) && inSeason(o, args.date)))
    // Ключ правила 1в: «ближайшая свободная дата» здесь — дата заявки, если календарь её подтверждает.
    .map((o) => ({ ...o, nearestFreeDate: o.keepsSchedule ? args.date : null }));
  const companies = groupOffersByCompany(able, { day: args.day });
  const shown = companies.slice(0, OTHER_OFFERS_MAX);
  return {
    offers: shown.map((g) => {
      const o = g.tours[0]!;
      return {
        partnerName: g.partnerName,
        tourId: o.id,
        title: o.title,
        price: priceWithUnitWords(o.basePrice, o.priceUnit),
        seats: o.keepsSchedule ? 'calendar' as const : 'by_request' as const,
        url: `${args.base}${tourBookingFormPath({ id: o.id, slug: o.slug }, args.date, args.people)}`,
        moreTours: g.tours.length - 1,
      };
    }),
    more: companies.length - shown.length,
  };
}

/**
 * Туры других компаний к главному месту отказанного тура, которые могут
 * принять `people` человек на `date`.
 */
export async function loadOtherOffers(
  args: { tourId: number | string; date: string; people: number },
  deps: OtherOffersDeps = {},
): Promise<OtherOffers> {
  const tourId = String(args.tourId);
  if (!/^[0-9]{1,18}$/.test(tourId) || !ISO_DAY.test(args.date)) return { state: 'none' };
  const people = Number.isFinite(args.people) && args.people > 0 ? Math.trunc(args.people) : 1;
  const q = deps.query ?? ((sql: string, params?: unknown[]) => pool.query(sql, params));
  let tour: { operator_id: string; place_id: string; place_name: string; place_slug: string | null; place_ark_id: string | null } | undefined;
  try {
    tour = (await q(OTHER_OFFERS_TOUR_SQL, [tourId])).rows[0] as typeof tour;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[other-offers] тур и его главное место не прочитаны', {
      tourId: logText(tourId, 20), sqlstate: typeof code === 'string' ? logText(code, 10) : null,
    });
    return { state: 'failed' };
  }
  // Главного места нет (облёт, многодневный по районам) или оно скрыто — сравнивать не с чем.
  if (!tour) return { state: 'none' };

  const now = deps.now ?? new Date();
  const place = await (deps.placeTours ?? loadPlaceTours)(tour.place_id, { now });
  if (place.state === 'failed') return { state: 'failed' };
  if (place.state === 'empty') return { state: 'none' };
  const refusedPartnerId = tour.operator_id;
  const others = place.offers.filter((o) => isOtherCompanyOffer(o, tourId, refusedPartnerId));
  if (others.length === 0) return { state: 'none' };

  // Спрашиваются все: закрытая дата есть и у тура, у которого открытых дат в календаре не осталось.
  const onDate = await (deps.onDate ?? loadToursOnDate)(others.map((o) => o.id), args.date, people);
  if (onDate.state === 'failed') return { state: 'failed' };

  const base = getPublicBaseUrl();
  const picked = pickOtherOffers({
    offers: others, free: onDate.free, closed: onDate.closed, refusedTourId: tourId, refusedPartnerId,
    date: args.date, people, day: offerOrderDay(now), base,
  });
  if (picked.offers.length === 0) return { state: 'none' };
  return {
    state: 'ok',
    placeName: tour.place_name,
    placeUrl: `${base}${ruPlacePath({ id: tour.place_id, slug: tour.place_slug, ark_id: tour.place_ark_id })}#tours`,
    offers: picked.offers,
    more: picked.more,
  };
}
