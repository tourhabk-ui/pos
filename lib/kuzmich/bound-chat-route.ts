/**
 * Куда отнести текст в привязанном чате оператора или администратора.
 *
 * Чат владельца в MAX привязан к карточке партнёра (и, отдельно, к роли
 * администратора). До 24.10 любое сообщение такого чата забирал помощник
 * кабинета: на «найди мне в аренду автомобиль» модель ответила, что аренду
 * не подбирает и ждёт вопрос про клиентов. Просьба туриста — аренда машины,
 * тур, трансфер, план поездки — идёт Кузьмичу туриста (у него прайс проката
 * и подбор). Кабинет остаётся кабинетом: CRM, свои туры, прайс и календарь
 * проката, правка цены, открытие дат.
 *
 * Неузнанное остаётся кабинетом. Шире открывать нельзя: «найди Анну» и
 * «запиши звонок» — не турист, и помощник их не должен терять.
 */

import { isFleetAsk } from '@/lib/kuzmich/operator-rental-fleet';
import { rentalCabinetAsk } from '@/lib/rental/cabinet-bar';
import { calendarAsk } from '@/lib/rental/car-calendar';
import { isOfferEditAsk } from '@/lib/rental/offer-edit';
import { isNextCommand } from '@/lib/seat-requests/answer-edit';
import { isSummaryCommand } from '@/lib/seat-requests/summary';

export type BoundChatLane = 'partner' | 'tourist';

function norm(text: string): string {
  return text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

/** Слово целиком: `\b` в JS не видит кириллицу. */
function word(body: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'u');
}

const OWN = word('мои|мой|моя|мое|свои|свой|своя|свое|наш|наша|наше|наши');
const CRM = word('клиент\\p{L}*|задач\\p{L}*|касани\\p{L}*|входящ\\p{L}*|напомни\\p{L}*|перезвон\\p{L}*|запиш\\p{L}*|заведи\\p{L}*');
const WHO = word('кто');
const SHOW_LIST = word('покажи|список');
const BOOKING_WORD = word('брон\\p{L}*');
const BOOKING_SHORT = word('брон(?:и|ей|ь)?');
const OPEN_DATES = /(?:открой|открыть|закрой|закрыть|выставь)/u;
const DATE_WORD = word('дат\\p{L}*|суббот\\p{L}*|воскресен\\p{L}*|понедельник\\p{L}*|вторник\\p{L}*|сред\\p{L}*|четверг\\p{L}*|пятниц\\p{L}*|мест\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*|январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йя]\\p{L}*|июн\\p{L}*');
const RENTAL = word('аренд\\p{L}*|прокат\\p{L}*') ;
const RENTAL_EN = /rent a car|car rental|car hire/u;
const VEHICLE = word('автомобил\\p{L}*|машин\\p{L}*|авто|джип\\p{L}*|внедорожник\\p{L}*|suv|вездеход\\p{L}*');
const TOUR = word('тур(?:а|ы|ов|е|у|ом)?|экскурси\\p{L}*');
const TRANSFER = word('трансфер\\p{L}*|transfer');
const WITH_DRIVER = /машин\p{L}*\s+с\s+водител\p{L}*/u;
const PLAN = /(?:спланиру\p{L}*|составь(?:те)?\s+план|план\s+поездк\p{L}*|поездк\p{L}*\s+на\s+\d+|маршрут\s+на\s+\d+)/u;
const ASK = word('найд\\p{L}*|подбер\\p{L}*|хочу|хотим|нужен|нужна|нужно|нужны|ищу|ищем|снять|сниму|снимем|возьму|возьмем|покажи|какие|какой|какая|какое|заброниру\\p{L}*');
const HOW_MUCH = /сколько\s+стоит/u;

function isCabinet(raw: string, t: string): boolean {
  if (isFleetAsk(raw) || calendarAsk(raw) !== null || isOfferEditAsk(raw) || rentalCabinetAsk(raw) !== null) return true;
  if (isSummaryCommand(raw) || isNextCommand(raw)) return true;
  if (CRM.test(t) || OWN.test(t)) return true;
  if (WHO.test(t) && /ждет/.test(t)) return true;
  if (SHOW_LIST.test(t) && BOOKING_WORD.test(t)) return true;
  if (BOOKING_SHORT.test(t) && t.split(' ').length <= 2) return true;
  if (OPEN_DATES.test(t) && DATE_WORD.test(t)) return true;
  return false;
}

/**
 * «tourist» — просьба как у туриста, её отвечает Кузьмич туриста.
 * «partner» — кабинет или неузнанное.
 */
export function boundChatLane(text: string): BoundChatLane {
  const t = norm(text);
  if (t.length === 0) return 'partner';
  if (isCabinet(text, t)) return 'partner';
  if (RENTAL_EN.test(t)) return 'tourist';
  // «аренда» без машины — тоже просьба туриста, если это вопрос («хочу
  // аренду», «сколько стоит аренда»), а не слово в деле кабинета.
  if (RENTAL.test(t) && (VEHICLE.test(t) || ASK.test(t) || HOW_MUCH.test(t))) return 'tourist';
  if (PLAN.test(t) || WITH_DRIVER.test(t)) return 'tourist';
  const touristObject = TOUR.test(t) || TRANSFER.test(t) || WITH_DRIVER.test(t) || VEHICLE.test(t);
  if ((ASK.test(t) || HOW_MUCH.test(t)) && touristObject) return 'tourist';
  return 'partner';
}
