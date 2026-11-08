/**
 * Жильё и машина к плану в ответе make_trip_plan — настоящие варианты с
 * платформы рядом с оценкой сметы (аудит планировщика 07.11, заявка 4.3 в
 * #3076). Пруф с прода 06.11: на «план на 5 дней, жильё и машина» в ответе
 * стоял только ориентир цены, и агент шёл искать жильё и машину заново.
 *
 * Подбора здесь нет — он тот же, что у экрана планера «Что ещё нужно»
 * (lib/planner/trip-extras-data): жильё витрины в зоне ночёвки, свободное на
 * все ночи стоянки, с ценой на группу по правилу брони; перевозчики «под
 * заказ» — машина целиком, цена за машину; прокатчики — машина без водителя,
 * цена за сутки. Слова цены тоже общие (lib/planner/trip-extras-words).
 *
 * У каждого три исхода (§4.0): варианты; «на платформе нет»; «не смогли
 * проверить» — это не «нет».
 *
 * Путь заявки зависит от поверхности:
 *  - номер жилья бронируется на карточке объекта — ссылка несёт даты
 *    стоянки, гостей и номер, на любой поверхности. create_stay_request
 *    объекты со своими номерами не принимает, агенту это сказано, чтобы он не
 *    тратил вызов;
 *  - машина и прокат: агенту по MCP — инструмент заявки с plan_id, человеку
 *    в чате — форма на странице партнёра. Инструментов заявки у Кузьмича в
 *    чате нет: отсылать к ним значило бы обещать путь, которого нет;
 *  - прокатчик под паузой сайта (lib/rental/site-pause) в чат не идёт, агенту
 *    по MCP — идёт (решение владельца 23.10).
 *
 * ПД здесь нет: только объекты, партнёры, цены и даты плана.
 */

import { ZONE_NAMES } from '@/lib/planner/constants';
import { dateOfTripDay } from '@/lib/planner/flow-balance';
import {
  lodgingStays, groupSeats, CAR_RENTAL_ANSWER, carRentalPausedAnswer,
  type ExtrasDay, type LodgingStay,
} from '@/lib/planner/trip-extras';
import {
  findLodgingForStay, findRequestLodgingForStay, countUnzonedPublicLodging, findCharterOffers, findCarRentalOffers,
  type CheckOutcome, type LodgingOption, type RequestLodgingOption, type CharterOffer, type RentalOfferSummary,
} from '@/lib/planner/trip-extras-data';
import {
  fmtRub, nightsRu, stayRoomsLine, charterOfferPrice, rentalOfferLine,
} from '@/lib/planner/trip-extras-words';
import { ACCOMMODATION_TYPE_LABELS } from '@/lib/stay/accommodation-types';
import { STAY_PAY_ON_SITE } from '@/lib/stay/pay-on-site';
import { stayLink } from '@/lib/stay/stay-link';
import { carrierPagePath } from '@/lib/transfers/charter-format';
import { rentalPagePath } from '@/lib/rental/rental-format';
import type { DraftSurface } from '@/lib/planner/plan-drafts';

/** Стоянок в ответе; остальные — в планировщике, и это сказано. */
export const PLAN_OFFER_STAYS_SHOWN = 4;
/** Перевозчиков и прокатчиков в ответе; остальные — на витрине, и это сказано. */
export const PLAN_OFFER_PARTNERS_SHOWN = 3;

export type RentalOutcome = CheckOutcome<RentalOfferSummary> | { state: 'paused'; returnsOn: string };

export interface PlanOffers {
  /**
   * `result` — объекты с номерами на платформе; `byRequest` — по заявке
   * хозяину (дом целиком, «Кутха»; 08.11). Нет поля — не искали (старые
   * вызовы и тесты), а не «нет».
   */
  stays: Array<{ stay: LodgingStay; result: CheckOutcome<LodgingOption>; byRequest?: CheckOutcome<RequestLodgingOption> }>;
  /** Объектов витрины без разметки зоны: планер их не предлагает. null — не посчитали. */
  unzonedCount?: number | null;
  /** Стоянок сверх показанных. */
  moreStays: number;
  /** Ночи в турах с проживанием — на них жильё не ищется. */
  nightsInTours: number;
  /** Ночи дней, которые движок не заполнил: зоны ночёвки у них нет, жильё не искали. */
  gapNights: number;
  charter: CheckOutcome<CharterOffer>;
  rental: RentalOutcome;
}

export interface PlanOffersInput {
  days: readonly ExtrasDay[];
  arrivalIso: string;
  departureIso: string;
  adults: number;
  children: readonly number[];
  surface: DraftSurface;
}

/** Ночи до отъезда, у которых нет дня плана (разрыв нумерации, 19.09). */
function gapNightsOf(days: readonly ExtrasDay[], arrivalIso: string, departureIso: string): number {
  const keys = new Set(days.map((d) => d.day));
  const last = days.reduce((m, d) => Math.max(m, d.day), 0);
  let n = 0;
  for (let k = 1; k <= last; k++) {
    if (keys.has(k)) continue;
    const night = dateOfTripDay(arrivalIso, k);
    if (night && night < departureIso) n++;
  }
  return n;
}

/** Варианты к плану — тем же подбором, что экран планера. */
export async function loadPlanOffers(input: PlanOffersInput): Promise<PlanOffers> {
  const { stays, nightsInTours } = lodgingStays(input.days, input.arrivalIso, input.departureIso);
  const shown = stays.slice(0, PLAN_OFFER_STAYS_SHOWN);
  const people = groupSeats(input.adults, input.children);
  const [results, byRequest, unzonedCount, charter, rental] = await Promise.all([
    Promise.all(shown.map((s) => findLodgingForStay(s, people))),
    Promise.all(shown.map((s) => findRequestLodgingForStay(s))),
    stays.length > 0 ? countUnzonedPublicLodging() : Promise.resolve(null),
    findCharterOffers(),
    findCarRentalOffers({ agents: input.surface === 'mcp' }),
  ]);
  return {
    stays: shown.map((stay, i) => ({
      stay,
      result: results[i] ?? { state: 'unavailable' },
      byRequest: byRequest[i] ?? { state: 'unavailable' },
    })),
    unzonedCount,
    moreStays: stays.length - shown.length,
    nightsInTours,
    gapNights: gapNightsOf(input.days, input.arrivalIso, input.departureIso),
    charter,
    rental,
  };
}

function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

function lowerFirst(t: string): string {
  return t ? t.charAt(0).toLocaleLowerCase('ru-RU') + t.slice(1) : t;
}

function staysRu(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} стоянка`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} стоянки`;
  return `${n} стоянок`;
}

const NOT_CHECKED = 'не смогли проверить — сбой на нашей стороне; это не значит, что вариантов нет';

/** Строка объекта по заявке хозяину: цены стоянки нет, вместимость числом не записана. */
function requestLodgingLine(o: RequestLodgingOption, stay: LodgingStay, party: { adults: number; children: readonly number[]; surface: DraftSurface }, site: string): string {
  const type = ACCOMMODATION_TYPE_LABELS[o.type as keyof typeof ACCOMMODATION_TYPE_LABELS];
  const name = `«${o.name}»${party.surface === 'mcp' ? ` (accommodation: ${o.id})` : ''}${type ? `, ${type.toLocaleLowerCase('ru-RU')}` : ''}${o.isVerified ? ', проверено платформой' : ''}`;
  const price = o.priceFrom === null ? 'цена не указана' : `от ${fmtRub(o.priceFrom)} за ночь`;
  const href = stayLink(o.id, { checkIn: stay.checkIn, checkOut: stay.checkOut, adults: party.adults, children: party.children.length });
  return `- ${name} — по заявке хозяину, ${price}; свободно ли на эти ночи и сколько человек примет, подтверждает хозяин. ${site}${href}`;
}

function lodgingLine(o: LodgingOption, stay: LodgingStay, party: { adults: number; children: readonly number[] }, site: string): string {
  const type = ACCOMMODATION_TYPE_LABELS[o.type as keyof typeof ACCOMMODATION_TYPE_LABELS];
  const name = `«${o.name}»${type ? `, ${type.toLocaleLowerCase('ru-RU')}` : ''}${o.isVerified ? ', проверено платформой' : ''}`;
  const price = o.stay.kind === 'priced'
    ? `${fmtRub(o.stay.total)} на группу за ${nightsRu(stay.nights)}`
    : o.priceFrom === null ? 'цена не указана' : `от ${fmtRub(o.priceFrom)} за номер в ночь`;
  const href = stayLink(o.id, {
    checkIn: stay.checkIn, checkOut: stay.checkOut, adults: party.adults, children: party.children.length,
    ...(o.stay.kind === 'priced' ? { roomId: o.stay.roomId, rooms: o.stay.rooms } : {}),
  });
  return `- ${name} — ${price}: ${lowerFirst(stayRoomsLine(o.stay))}. ${site}${href}`;
}

/**
 * Блок «Жильё и машина к этому плану» текстом. Чистая, под тестом.
 * Пустой массив — сказать нечего (плана нет).
 */
export function formatPlanOffers(
  o: PlanOffers,
  ctx: { surface: DraftSurface; adults: number; children: readonly number[]; site: string },
): string[] {
  const agent = ctx.surface === 'mcp';
  const { site } = ctx;
  const lines = ['Жильё и машина к этому плану — настоящие варианты на платформе, не оценка из сметы:'];

  // ── Жильё ──────────────────────────────────────────────────────────────
  // «Не нужно» — только когда искать было нечего: ночи незаполненных дней
  // жилья требуют, хотя зоны у них нет, и «ночей нет» было бы неправдой.
  if (o.stays.length === 0 && o.gapNights === 0) {
    lines.push(o.nightsInTours > 0
      ? 'Жильё: все ночи плана — в турах с проживанием, отдельное жильё не нужно.'
      : 'Жильё: ночей в плане нет — жильё не нужно.');
  }
  for (const { stay, result, byRequest } of o.stays) {
    const head = `Жильё — ${ZONE_NAMES[stay.zone]}, ${ddmm(stay.checkIn)} — ${ddmm(stay.checkOut)} (${nightsRu(stay.nights)})`;
    const req = byRequest ?? { state: 'empty' as const };
    const items = [
      ...(result.state === 'ok' ? result.items.map((x) => lodgingLine(x, stay, ctx, site)) : []),
      ...(req.state === 'ok' ? req.items.map((x) => requestLodgingLine(x, stay, ctx, site)) : []),
    ];
    const failed = result.state === 'unavailable' || req.state === 'unavailable';
    if (items.length > 0) {
      lines.push(`${head}:`, ...items);
      // Половина подбора не прочиталась — так и сказано: показанное не всё.
      if (failed) lines.push(`- остальное ${NOT_CHECKED}.`);
    } else if (failed) {
      lines.push(`${head}: ${NOT_CHECKED}.`);
    } else {
      // Прежде здесь стояло «номеров, свободных на все эти ночи, не нашли» —
      // читалось как «всё занято», хотя жилья в зоне на платформе нет вовсе
      // или есть только неразмеченное (08.11).
      lines.push(`${head}: в этой зоне жилья, свободного на все эти ночи, на платформе нет. Каталог жилья: ${site}/accommodations`);
    }
  }
  if (o.unzonedCount && o.unzonedCount > 0) {
    lines.push(`Ещё объектов жилья без разметки зоны: ${o.unzonedCount} — планер их не предлагает, они есть в каталоге: ${site}/accommodations`);
  }
  if (o.moreStays > 0) {
    lines.push(`Ещё ${staysRu(o.moreStays)} — жильё на них подберёт планировщик: ${site}/planner`);
  }
  const lead = o.stays.length > 0 ? 'Ещё' : 'Жильё:';
  if (o.nightsInTours > 0 && (o.stays.length > 0 || o.gapNights > 0)) {
    lines.push(`${lead} ${nightsRu(o.nightsInTours)} — в турах с проживанием, на них жильё не искали.`);
  }
  if (o.gapNights > 0) {
    lines.push(`${o.stays.length > 0 || o.nightsInTours > 0 ? 'Ещё' : lead} ${nightsRu(o.gapNights)} — у незаполненных дней плана: зоны ночёвки у них нет, жильё не искали.`);
  }
  if (agent && o.stays.some((s) => s.byRequest?.state === 'ok')) {
    lines.push('Заявка хозяину — create_stay_request (accommodation, даты стоянки, гости) с согласия человека или форма на карточке; даты и цену подтверждает хозяин.');
  }
  if (o.stays.some((s) => s.result.state === 'ok')) {
    lines.push(`Бронь номера — на карточке по ссылке: даты стоянки, гости и номер уже подставлены. ${STAY_PAY_ON_SITE}.`
      + (agent ? ' create_stay_request такие объекты не принимает: у них свои номера на платформе.' : ''));
  }

  // ── Машина с водителем под заказ ───────────────────────────────────────
  if (o.charter.state === 'ok') {
    const shown = o.charter.items.slice(0, PLAN_OFFER_PARTNERS_SHOWN);
    lines.push('Машина с водителем под заказ — машина целиком, цена за машину, не за место:');
    for (const c of shown) {
      lines.push(`- «${c.name}»${agent ? ` (carrier: ${c.slug})` : ''}${c.fleet ? `, ${c.fleet}` : ''} — ${charterOfferPrice(c)}. ${site}${carrierPagePath(c.slug)}`);
    }
    if (o.charter.items.length > shown.length) {
      lines.push(`- ещё ${o.charter.items.length - shown.length} — ${site}/transfers`);
    }
    lines.push(agent
      ? 'Заявка на машину — request_charter: куда (destination), дата выезда (date_from), перевозчик (carrier); с plan_id число людей возьмётся из плана. Направления и цены прайса — search_transfers. Машину подтверждает менеджер Ведара, расчёт — напрямую с перевозчиком.'
      : 'Заявка на машину — формой на странице перевозчика: куда и когда пишет заказчик. Машину подтверждает менеджер Ведара, расчёт — напрямую с перевозчиком.');
  } else if (o.charter.state === 'empty') {
    lines.push(`Машина с водителем под заказ: перевозчиков с прайсом на платформе пока нет. Трансферы: ${site}/transfers`);
  } else {
    lines.push(`Машина с водителем под заказ: ${NOT_CHECKED}.`);
  }

  // ── Прокат без водителя ────────────────────────────────────────────────
  const r = o.rental;
  if (r.state === 'ok') {
    const shown = r.items.slice(0, PLAN_OFFER_PARTNERS_SHOWN);
    lines.push('Прокат без водителя — цена за сутки за машину:');
    for (const c of shown) {
      lines.push(`- «${c.name}»${agent ? ` (company: ${c.slug})` : ''} — ${rentalOfferLine(c)}. ${site}${rentalPagePath(c.slug)}`);
    }
    if (r.items.length > shown.length) {
      lines.push(`- ещё ${r.items.length - shown.length} — ${site}/car-rental`);
    }
    lines.push(agent
      ? 'Заявка на прокат — create_car_rental_request: машина как в прайсе (car), прокатчик (company); с plan_id даты аренды возьмутся из плана. Машины и цены — search_car_rental. Машину подтверждает менеджер Ведара, расчёт — напрямую с прокатчиком.'
      : 'Заявка на прокат — формой на странице прокатчика: машина и даты. Машину подтверждает менеджер Ведара, расчёт — напрямую с прокатчиком.');
  } else if (r.state === 'paused') {
    // Пауза — не «проката нет»: называется, когда вернётся (те же слова, что у экрана).
    lines.push(`${carRentalPausedAnswer(r.returnsOn).message}.`);
  } else if (r.state === 'empty') {
    lines.push(`${CAR_RENTAL_ANSWER.message}. ${CAR_RENTAL_ANSWER.hint}`);
  } else {
    lines.push(`Прокат без водителя: ${NOT_CHECKED}.`);
  }
  return lines;
}

/**
 * Загрузить и сказать. Сбой самой сборки блока (не одной проверки — те
 * отвечают «не смогли» сами) план не роняет: план уже собран и сохранён, и
 * без блока он верен. Но молча блок не пропадает (§4.0) — одна строка
 * «не смогли проверить» и лог с именем проверки.
 */
export async function planOfferLines(
  input: PlanOffersInput,
  site: string,
): Promise<string[]> {
  try {
    const offers = await loadPlanOffers(input);
    return formatPlanOffers(offers, { surface: input.surface, adults: input.adults, children: input.children, site });
  } catch (err) {
    console.error('[kuzmich/plan-offers] варианты к плану не собраны:', err instanceof Error ? err.message : String(err));
    return [`Жильё и машину к этому плану ${NOT_CHECKED}. Планировщик: ${site}/planner`];
  }
}
