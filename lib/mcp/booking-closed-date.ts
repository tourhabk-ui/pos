/**
 * lib/mcp/booking-closed-date.ts — заявка на дату, которую закрыл Ведар, и
 * другие компании к месту на дату (план «после отказа», этап 6).
 *
 * До этого дня create_booking_request отвечал на такую дату «нет свободных
 * мест — заявка не создана… предложите другой тур». Мест на ней никто не
 * занимал: дату закрыл Ведар по описанию тура (миграция 1421), оператора
 * никто не спрашивал. Теперь заявка уходит оператору вопросом — «ходите ли вы
 * в этот день?» — тем же путём, что обычная заявка, а человеку и агенту
 * сказано, что это за дата и что места заявка не закрепляет.
 *
 * Вторая половина — для любого отказа «на дату нет»: вместо совета
 * «предложите другой тур» названы компании, чьи туры идут к тому же месту и
 * по календарю Ведара могут принять на эту дату (тот же отбор и порядок, что
 * после отказа оператора, lib/requests/other-offers).
 *
 * Здесь слова и чтение со сроком; базы своей нет. Сторож:
 * tests/unit/mcp-closed-date.test.ts (вызовом роута).
 */
import { OFFER_ORDER_NOTE_ON_DATE_RU } from '@/lib/tours/offer-order';
import { otherOfferSeatsWords } from '@/lib/requests/other-offers-words';
import type { OtherOffers } from '@/lib/requests/other-offers';

/** Сколько вызов ждёт список других компаний: заявка и её ответ важнее списка. */
export const BOOKING_OFFERS_TIMEOUT_MS = 4_000;

/** Оператору в заявку: кто закрыл дату и что от него нужно. */
export const PLATFORM_CLOSED_LEAD_NOTE =
  ' Дату в календаре закрыл Ведар по описанию тура (зимой тур под вопросом) — вы её не закрывали.'
  + ' Ходите ли вы в этот день? Если да — откройте дату в календаре.';

/**
 * Агенту и человеку: что принято и что это за дата. Мест заявка не закрепляет.
 * Что оператор ответит и перезвонит — не обещается: система этого не держит;
 * сказано, где появится его ответ.
 */
export function platformClosedAccepted(a: { title: string; date: string; phone: string }): string {
  return `Заявка оператору отправлена вопросом: "${a.title}", ${a.date}. `
    + 'Эту дату в календаре закрыл Ведар по описанию тура — оператор её не закрывал и не подтверждал, поэтому мест на неё в системе нет. '
    + `Оператору задан вопрос, ходит ли он в этот день: его ответ появится в статусе заявки, связаться он может по телефону ${a.phone}. `
    + 'Места заявка не закрепляет. Это заявка, не оплата.';
}

/** Пробному вызову: что сделал бы настоящий. */
export function platformClosedTrial(a: { title: string; id: number | string; date: string; participants: number }): string {
  return `заявка оператору вопросом: тур "${a.title}" (ID${a.id}), ${a.date}, участников ${a.participants} — `
    + 'дату в календаре закрыл Ведар по описанию тура, оператор её не закрывал; он ответит, ходит ли в этот день';
}

/**
 * Другие компании к тому же месту на дату — строками для агента. Пусто, когда
 * называть некого или список не прочитался: «других нет» при этом не говорится.
 */
export function otherCompaniesNote(o: OtherOffers | null, date: string, people: number): string {
  if (!o || o.state !== 'ok' || o.offers.length === 0) return '';
  const lines = o.offers.map((x, i) => (
    `${i + 1}. «${x.partnerName}» — тур "${x.title}" (ID${x.tourId}), ${x.price ?? 'цена не указана'}; ${otherOfferSeatsWords(x.seats, people)}.`
  ));
  return [
    '',
    `К тому же месту («${o.placeName}») на ${date} есть туры других компаний:`,
    ...lines,
    o.more > 0 ? `И ещё компаний: ${o.more} — на карточке места: ${o.placeUrl}` : '',
    'Это не ответ этих компаний, а их календарь на Ведаре: места и дату каждая подтверждает сама. '
      + 'Тур и компанию выбирает человек — назовите ему список как есть; новая заявка — create_booking_request с номером выбранного тура, после его согласия.',
    OFFER_ORDER_NOTE_ON_DATE_RU,
  ].filter((l, i) => i === 0 || l !== '').join('\n');
}

/** Список других компаний со сроком; не уложился или упал — null (в лог), ответ идёт без списка. */
export async function otherCompaniesInTime(
  load: () => Promise<OtherOffers>, ms: number = BOOKING_OFFERS_TIMEOUT_MS,
): Promise<OtherOffers | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([load().catch((err: unknown) => {
      const code = (err as { code?: unknown })?.code;
      console.error('[mcp] другие компании на дату не прочитаны, SQLSTATE', typeof code === 'string' ? code : 'нет SQLSTATE');
      return null;
    }), late]);
  } finally {
    clearTimeout(timer);
  }
}
