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
 *
 * Беда — Кузьмичу туриста (проверка качества 24.10): «помогите, мы
 * заблудились» от гида в поле уходило помощнику CRM, у которого нет блока
 * 112, а администратору отвечало «Не понял команду». Признаки беды —
 * lib/safety/sos-detector, то же правило, что ставит блок 112. Исключения —
 * команда кабинета своей формой («описание Hilux: …», «календарь Jimny»,
 * «покажи брони») и запись в CRM, начатая словом дела, о чужой беде
 * («запиши: у клиента сломана нога»; «Запишите координаты: мы заблудились» —
 * своя беда, она к Кузьмичу). Они остаются кабинетом, а блок 112 ставит
 * отправитель ответа привязанного чата поверх любого ответа (Telegram:
 * role-telegram, cabinet-telegram; MAX: ветка партнёра в роуте; оба кабинета
 * администратора).
 *
 * После своей беды чат два часа отвечается Кузьмичом туриста
 * (`boundChatLaneFor`): «стоим у ручья», «нас четверо, один ранен» — ответы
 * на его вопрос, а не дела кабинета, и у кабинета нет ни 112, ни разговора.
 */

import { VEHICLE_WORDS } from '@/lib/ai/vehicle-words';
import { isFleetAsk } from '@/lib/kuzmich/operator-rental-fleet';
import { detectEmergency } from '@/lib/safety/sos-detector';
import { rentalCabinetAsk } from '@/lib/rental/cabinet-bar';
import { calendarAsk } from '@/lib/rental/car-calendar';
import { isRentalPilotSlug } from '@/lib/rental/operator-pilot';
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

const OWN = word('мои|мой|моя|мое|свои|свой|своя|свое|наш|наша|наше|наши|у меня|у нас');
// «хочу поменять цену тура», «исправить описание» — правка своего, не просьба туриста.
const EDIT_OWN = /(?:поменя|измен|исправ|обнов)\p{L}*\s+(?:\p{L}+\s+)?(?:цен|описан|прайс)/u;
// «какой джип свободен 30 октября» у прокатчика — его календарь, а не аренда.
const FREE = word('свобод\\p{L}*|занят\\p{L}*');
const CRM = word('клиент\\p{L}*|задач\\p{L}*|касани\\p{L}*|входящ\\p{L}*|напомни\\p{L}*|перезвон\\p{L}*|запиш\\p{L}*|заведи\\p{L}*');
const WHO = word('кто');
const SHOW_LIST = word('покажи|список');
const BOOKING_WORD = word('брон\\p{L}*');
const BOOKING_SHORT = word('брон(?:и|ей|ь)?');
const OPEN_DATES = /(?:открой|открыть|закрой|закрыть|выставь)/u;
const DATE_WORD = word('дат\\p{L}*|суббот\\p{L}*|воскресен\\p{L}*|понедельник\\p{L}*|вторник\\p{L}*|сред\\p{L}*|четверг\\p{L}*|пятниц\\p{L}*|мест\\p{L}*|июл\\p{L}*|август\\p{L}*|сентябр\\p{L}*|октябр\\p{L}*|ноябр\\p{L}*|декабр\\p{L}*|январ\\p{L}*|феврал\\p{L}*|март\\p{L}*|апрел\\p{L}*|ма[йя]\\p{L}*|июн\\p{L}*');
const RENTAL = word('аренд\\p{L}*|прокат\\p{L}*') ;
const RENTAL_EN = /rent a car|car rental|car hire/u;
// Словарь вида машины — общий с isCarRentalAsk (lib/ai/vehicle-words).
const VEHICLE = word(VEHICLE_WORDS);
const TOUR = word('тур(?:а|ы|ов|е|у|ом)?|экскурси\\p{L}*');
const TRANSFER = word('трансфер\\p{L}*|transfer');
const WITH_DRIVER = /машин\p{L}*\s+с\s+водител\p{L}*/u;
const PLAN = /(?:спланиру\p{L}*|составь(?:те)?\s+план|план\s+поездк\p{L}*|поездк\p{L}*\s+на\s+\d+|маршрут\s+на\s+\d+)/u;
const ASK = word('найд\\p{L}*|подбер\\p{L}*|хочу|хотим|нужен|нужна|нужно|нужны|ищу|ищем|снять|сниму|снимем|возьму|возьмем|покажи|какие|какой|какая|какое|заброниру\\p{L}*');
const HOW_MUCH = /сколько\s+стоит/u;

/** Команда кабинета своей формой — её не перебивает и беда в той же фразе. */
function isCabinetCommand(raw: string, t: string): boolean {
  if (isFleetAsk(raw) || calendarAsk(raw) !== null || isOfferEditAsk(raw) || rentalCabinetAsk(raw) !== null) return true;
  if (isSummaryCommand(raw) || isNextCommand(raw)) return true;
  return /^(?:покажи|список)\s+брон/u.test(t);
}

/** Запись в CRM, начатая словом дела, о чужой беде. */
const CRM_LEAD = /^(?:запиш|заведи|напомни)/u;
const FIRST_PERSON = word('мы|я|нас|нам|меня|мне');
function isCrmRecordOfOthers(t: string): boolean {
  return CRM_LEAD.test(t) && !FIRST_PERSON.test(t);
}

/** Что о партнёре знает классификатор: прокат ли это (его машины, его календарь). */
export interface BoundChatContext {
  rental?: boolean;
}

/** Прокат: пилот кабинета или категория «машины». */
export function partnerHasRental(partner: { slug?: string | null; category?: string | null }): boolean {
  return isRentalPilotSlug(partner.slug ?? null) || partner.category === 'cars';
}

function isCabinet(raw: string, t: string, ctx: BoundChatContext): boolean {
  if (isCabinetCommand(raw, t)) return true;
  if (SHOW_LIST.test(t) && BOOKING_WORD.test(t)) return true;
  if (CRM.test(t) || OWN.test(t) || EDIT_OWN.test(t)) return true;
  // Прокатчик спрашивает о своих машинах: свободна ли, на какие даты.
  if (ctx.rental && VEHICLE.test(t) && (FREE.test(t) || DATE_WORD.test(t))) return true;
  if (WHO.test(t) && /ждет/.test(t)) return true;
  if (BOOKING_SHORT.test(t) && t.split(' ').length <= 2) return true;
  if (OPEN_DATES.test(t) && DATE_WORD.test(t)) return true;
  return false;
}

/**
 * «tourist» — просьба как у туриста, её отвечает Кузьмич туриста.
 * «partner» — кабинет или неузнанное.
 */
export function boundChatLane(text: string, ctx: BoundChatContext = {}): BoundChatLane {
  const t = norm(text);
  if (t.length === 0) return 'partner';
  if (isCabinetCommand(text, t)) return 'partner';
  if (detectEmergency(text).detected && !isCrmRecordOfOthers(t)) return 'tourist';
  if (isCabinet(text, t, ctx)) return 'partner';
  if (RENTAL_EN.test(t)) return 'tourist';
  // «аренда» без машины — тоже просьба туриста, если это вопрос («хочу
  // аренду», «сколько стоит аренда»), а не слово в деле кабинета.
  if (RENTAL.test(t) && (VEHICLE.test(t) || ASK.test(t) || HOW_MUCH.test(t))) return 'tourist';
  if (PLAN.test(t) || WITH_DRIVER.test(t)) return 'tourist';
  const touristObject = TOUR.test(t) || TRANSFER.test(t) || WITH_DRIVER.test(t) || VEHICLE.test(t);
  if ((ASK.test(t) || HOW_MUCH.test(t)) && touristObject) return 'tourist';
  return 'partner';
}

/** Сколько чат помнит свою беду. */
export const BOUND_CHAT_EMERGENCY_MS = 2 * 60 * 60 * 1000;
const emergencyMarks = new Map<string, number>();

/**
 * Полоса привязанного чата с памятью о беде. Беда, ушедшая Кузьмичу туриста,
 * отмечается; два часа после неё всё, кроме команды кабинета своей формой,
 * тоже идёт Кузьмичу. Администратору (`admin`) беда уходит Кузьмичу при
 * любых словах: CRM у него нет. Память — в процессе: перезапуск её стирает,
 * и это названо (ответ кабинета всё равно несёт 112 при новой беде).
 */
export function boundChatLaneFor(
  channel: 'telegram' | 'max',
  chatId: number,
  text: string,
  opts: { admin?: boolean; nowMs?: number; rental?: boolean } = {},
): BoundChatLane {
  const nowMs = opts.nowMs ?? Date.now();
  const key = `${channel}:${chatId}`;
  const emergency = detectEmergency(text).detected;
  const lane = opts.admin && emergency ? 'tourist' : boundChatLane(text, { rental: opts.rental });
  if (emergency && lane === 'tourist') {
    emergencyMarks.set(key, nowMs);
    return lane;
  }
  const markedAt = emergencyMarks.get(key);
  if (markedAt === undefined) return lane;
  if (nowMs - markedAt > BOUND_CHAT_EMERGENCY_MS) {
    emergencyMarks.delete(key);
    return lane;
  }
  if (lane === 'partner' && !isCabinetCommand(text, norm(text))) return 'tourist';
  return lane;
}

/** Забыть все отметки беды — для тестов (модуль живёт между ними). */
export function clearBoundChatEmergencies(): void {
  emergencyMarks.clear();
}
