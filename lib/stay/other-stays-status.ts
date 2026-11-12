/**
 * lib/stay/other-stays-status.ts — «другое жильё на ваши даты» в виде заявки
 * на жильё: ответ get_request_status ИИ-агенту и страница заявки (план «после
 * отказа», этап 5).
 *
 * Гость без подключённого MAX читает ответ хозяина на странице заявки, а
 * заявка от ИИ-агента чатов не имеет вовсе: её ответ доходит чтением статуса.
 * Поэтому тот же список, что уходит сообщением в чат (lib/stay/other-stays-notice),
 * стоит и здесь — одним загрузчиком и одними словами.
 *
 * Исходы (§4.0):
 *   listed — жильё названо;
 *   none   — Ведар проверил и не нашёл;
 *   failed — не прочиталось или не уложилось в срок: это не «не нашёл»;
 *   null   — к этой заявке не относится: хозяин не отвечал «Занято», заезд
 *            прошёл, либо зона объекта не размечена и «рядом» искать негде.
 *
 * Имя и телефон гостя сюда не читаются: в чтение идут объект, ночи и число
 * гостей. Только сервер. Сторож: tests/unit/other-stays.test.ts.
 */
import type { RequestCore, StatusRow } from '@/lib/mcp/request-status';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import { loadOtherStays, type OtherStayDates, type OtherStaysArgs } from '@/lib/stay/other-stays';
import { OTHER_STAYS_LIMIT_NOTE_RU, OTHER_STAYS_ORDER_NOTE_RU, otherStayTypeWords } from '@/lib/stay/other-stays-words';

/** Срок чтения: статус читают живьём (агент ждёт ответа инструмента, человек — страницу). */
export const STATUS_STAYS_TIMEOUT_MS = 5_000;

export interface RequestOtherStay {
  name: string;
  /** Номер объекта — им оставляют заявку: create_stay_request. */
  accommodation_id: string;
  /** Тип словами («Гостевой дом»); null — не записан знакомым словом. */
  type: string | null;
  dates: OtherStayDates;
  /** Цена за ночь «от», ₽; null — не названа. */
  price_from: number | null;
  /** Цена всех ночей на всю группу по формуле брони, ₽; null — не посчитана. */
  stay_total: number | null;
  /** Карточка объекта с подставленными датами и числом гостей. */
  url: string;
}

export interface RequestOtherStays {
  state: 'listed' | 'none' | 'failed';
  /** Зона, в которой искали («Авачинская зона»); не `listed` — null. */
  zone: string | null;
  check_in: string;
  check_out: string;
  /** На сколько гостей считали; null — в заявке не записано, считали на одного. */
  guests: number | null;
  stays: RequestOtherStay[];
  /** Что это за список и что с ним делать — словами для агента. */
  how: string;
}

/** То же без слов для агента: страница заявки говорит с человеком своими словами. */
export type PageOtherStays = Omit<RequestOtherStays, 'how'>;

const HOW_LISTED =
  'Это другое жильё в той же зоне на те же ночи — не ответ хозяев этих объектов: даты и цену каждый подтверждает сам. '
  + 'dates: calendar — по календарю Ведара номера свободны на все ночи (stay_total — цена всех ночей на группу, если она помещается); '
  + 'by_request — номеров на Ведаре нет, хозяин эти ночи не закрывал: даты и цену подтверждает он. '
  + 'Назовите их человеку как есть, без «лучше» и «дешевле»: жильё выбирает человек, не вы. '
  + 'Заявку выбранному хозяину оставляет человек по url или вы — create_stay_request с accommodation_id, только после его согласия: '
  + 'имя и телефон получит только этот хозяин. '
  + `${OTHER_STAYS_LIMIT_NOTE_RU} Искать шире — search_accommodations. `
  + OTHER_STAYS_ORDER_NOTE_RU;

const HOW_NONE =
  'Ведар не нашёл в той же зоне другого жилья, которое по его данным может принять на эти ночи. '
  + 'Искать шире — search_accommodations: другая зона или другие даты.';

const HOW_FAILED =
  'Список другого жилья сейчас не прочитался — это не значит, что его нет. '
  + 'Спросите статус ещё раз позже или найдите жильё сами: search_accommodations.';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Называть ли другое жильё в виде заявки — и по каким фактам. Только после
 * ответа хозяина «Занято» и только пока заезд впереди.
 */
export function otherStaysAsk(
  row: StatusRow, core: Pick<RequestCore, 'kind' | 'state'>, today: string,
): OtherStaysArgs | null {
  if (core.kind !== 'stay_request' || core.state !== 'declined' || row.stay_owner_answer !== 'busy') return null;
  const accommodationId = row.stay_accommodation_id ?? null;
  const checkIn = row.stay_check_in ?? null;
  const checkOut = row.stay_check_out ?? null;
  if (!accommodationId || !checkIn || !checkOut || !ISO_DAY.test(checkIn) || !ISO_DAY.test(checkOut)) return null;
  if (checkOut <= checkIn || checkIn < today) return null;
  const guests = Number(row.stay_guests ?? 0);
  return { accommodationId, checkIn, checkOut, guests: Number.isFinite(guests) && guests > 0 ? Math.trunc(guests) : null };
}

export interface StatusStaysDeps {
  load?: typeof loadOtherStays;
  now?: () => number;
  timeoutMs?: number;
}

/** Срок не отменяет начатое чтение — оно доработает само; исход назван `failed`. */
async function inTime<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'exception' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ ok: false; why: 'timeout' }>((resolve) => { timer = setTimeout(() => resolve({ ok: false, why: 'timeout' }), ms); });
  const done = p.then(
    (value) => ({ ok: true as const, value }),
    () => ({ ok: false as const, why: 'exception' as const }),
  );
  try {
    return await Promise.race([done, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Другое жильё для вида заявки. Никогда не бросает: статус заявки важнее
 * списка — не прочиталось, и вид уходит с `failed`, а не падает целиком.
 */
export async function readStatusOtherStays(
  row: StatusRow, core: Pick<RequestCore, 'kind' | 'state'>, deps: StatusStaysDeps = {},
): Promise<RequestOtherStays | null> {
  const ask = otherStaysAsk(row, core, kamchatkaToday((deps.now ?? Date.now)()));
  if (!ask) return null;
  const base = { zone: null, check_in: ask.checkIn, check_out: ask.checkOut, guests: ask.guests, stays: [] };
  const run = await inTime((deps.load ?? loadOtherStays)(ask), deps.timeoutMs ?? STATUS_STAYS_TIMEOUT_MS);
  if (!run.ok) {
    console.warn(`[other-stays-status] другое жильё на даты не прочиталось (${run.why}) — вид заявки уходит без него`);
    return { ...base, state: 'failed', how: HOW_FAILED };
  }
  const o = run.value;
  // Зона объекта не размечена: «рядом» не искали — это не «не нашёл», поля нет.
  if (o.state === 'unzoned') return null;
  if (o.state === 'failed') return { ...base, state: 'failed', how: HOW_FAILED };
  if (o.state === 'none') return { ...base, state: 'none', how: HOW_NONE };
  return {
    state: 'listed',
    zone: o.zoneName,
    check_in: ask.checkIn,
    check_out: ask.checkOut,
    guests: ask.guests,
    stays: o.items.map((x) => ({
      name: x.name, accommodation_id: x.id, type: otherStayTypeWords(x.type) || null, dates: x.dates,
      price_from: x.priceFrom, stay_total: x.stayTotal, url: x.url,
    })),
    how: HOW_LISTED,
  };
}

/** Для страницы заявки: без слов для агента. */
export function pageOtherStays(o: RequestOtherStays | null | undefined): PageOtherStays | null {
  if (!o) return null;
  const { how: _how, ...rest } = o;
  return rest;
}
