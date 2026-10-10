/**
 * Заявка на вахтовку целой машиной (MCP `request_charter`, решение владельца
 * 10.10: «трансфер работает не по маршруту, а по заказам»).
 *
 * Поездка (lib/transfers/service) — это машина, дата и места. У перевозчика
 * «под заказ» (миграция 1185) другое: дат нет, направление и дни задаёт
 * заказчик, цена — за машину по прайсу. Поэтому заявка здесь — не «займи место
 * в рейсе», а «вот куда, когда и сколько нас; подтвердите».
 *
 * Модуль чистый: ни базы, ни сети. Допуск к записи, согласие и сам лид — в
 * роуте MCP (`app/api/mcp/route.ts`), там же, где у обеих прежних заявок.
 *
 * Чего здесь нет намеренно (§4.0):
 *   · итоговой суммы. Прайс говорит «цена за машину», но не говорит, сколько
 *     дней в неё входит и что включено; умножить на число машин или дней значило
 *     бы выдать догадку за цену. Называются строки прайса как есть;
 *   · занятости машин. Система её не ведёт — «нет машин на эти даты» была бы
 *     ложью. Подтверждает перевозчик;
 *   · контактов перевозчика в ответе агенту. Они уходят менеджеру в заявку.
 */

import {
  charterFootnote,
  describeFleet,
  fleetCapacity,
  matchDestinations,
  vehiclesNeeded,
  type CharterCarrier,
  type CharterPriceLine,
} from '@/lib/transfers/charter-format';

/** Чем начинается комментарий лида: по этому префиксу ищется повтор и узнаётся заявка на машину. */
export const CHARTER_LEAD_TAG = '[Заявка на машину]';

/** Сколько дней вперёд принимаем дату выезда: прайс годовой, дальше года перевозчик не загадывает. */
export const CHARTER_MAX_DAYS_AHEAD = 400;
/** Самая длинная поездка в одной заявке. */
export const CHARTER_MAX_TRIP_DAYS = 30;

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').trim();
}

export type CarrierPick =
  | { kind: 'picked'; carrier: CharterCarrier }
  /** Перевозчиков несколько, а агент не сказал, какой: спросить, а не выбирать за человека. */
  | { kind: 'ambiguous'; names: string[] }
  /** Названного перевозчика нет среди тех, у кого есть прайс. */
  | { kind: 'unknown'; names: string[] }
  | { kind: 'none' };

/**
 * Выбор перевозчика: по названию или slug, а если перевозчик один и агент
 * ничего не назвал — он и есть. Несколько перевозчиков без указания — вопрос,
 * не жребий: заявка уходит конкретному человеку.
 */
export function pickCarrier(carriers: CharterCarrier[], query: string | undefined): CarrierPick {
  if (carriers.length === 0) return { kind: 'none' };
  const names = carriers.map((c) => c.name);
  const q = norm(query ?? '');
  if (!q) return carriers.length === 1 ? { kind: 'picked', carrier: carriers[0]! } : { kind: 'ambiguous', names };
  const hits = carriers.filter((c) => norm(c.slug) === q || norm(c.name) === q);
  const loose = hits.length > 0 ? hits : carriers.filter((c) => norm(c.name).includes(q) || norm(c.slug).includes(q));
  if (loose.length === 1) return { kind: 'picked', carrier: loose[0]! };
  return loose.length > 1 ? { kind: 'ambiguous', names: loose.map((c) => c.name) } : { kind: 'unknown', names };
}

export type CharterPlan =
  /** Направление названо и однозначно сопоставилось со строкой прайса. */
  | { kind: 'priced'; line: CharterPriceLine; vehicles: number | null }
  /** Такого направления в прайсе нет: заказ нестандартный, цену называет перевозчик. */
  | { kind: 'custom'; vehicles: number | null }
  /** Под слова запроса подходит несколько строк прайса: уточнить, не выбирать. */
  | { kind: 'ambiguous'; options: string[] }
  /** Людей больше, чем мест во всех машинах перевозчика. */
  | { kind: 'too_many'; seatsTotal: number };

/**
 * Что делать с заявкой, зная прайс и парк. Порядок проверок важен: вместимость
 * — факт парка и отказывает сразу, неоднозначное направление — вопрос агенту,
 * и лишь потом цена по прайсу либо «нестандартный заказ».
 */
export function planCharterRequest(carrier: CharterCarrier, destination: string, passengers: number): CharterPlan {
  const cap = fleetCapacity(carrier.vehicles);
  if (cap && passengers > cap.total) return { kind: 'too_many', seatsTotal: cap.total };
  const vehicles = vehiclesNeeded(carrier.vehicles, passengers);

  const hits = matchDestinations(carrier.destinations, destination);
  if (hits.length > 1) return { kind: 'ambiguous', options: hits.map((h) => h.to) };
  if (hits.length === 1) return { kind: 'priced', line: hits[0]!, vehicles };
  return { kind: 'custom', vehicles };
}

export interface CharterRequestFacts {
  carrier: CharterCarrier;
  plan: Extract<CharterPlan, { kind: 'priced' | 'custom' }>;
  destination: string;
  dateFrom: string;
  dateTo: string | null;
  passengers: number;
  comment: string | null;
}

/** «с 2027-07-10 по 2027-07-12» либо «с 2027-07-10 (дату возвращения назовёт заказчик)». */
function dateSpan(f: Pick<CharterRequestFacts, 'dateFrom' | 'dateTo'>): string {
  return f.dateTo ? `с ${f.dateFrom} по ${f.dateTo}` : `с ${f.dateFrom}, дата возвращения не указана`;
}

/**
 * Префикс комментария лида: по нему ищется повтор заявки того же человека
 * (телефон + перевозчик + дата выезда за сутки). Детерминирован — агент при
 * ретрае переформулирует хвост, а префикс остаётся.
 */
export function charterDedupPrefix(carrierName: string, dateFrom: string): string {
  return `${CHARTER_LEAD_TAG} «${carrierName}», с ${dateFrom},`;
}

/**
 * Деньги в тексте для агента — «75000 руб», как в search_transfers: тот же
 * прайс, прочитанный в двух ответах, не должен выглядеть по-разному (на экране
 * — «75 000 ₽» с неразрывным пробелом, но в ответ модели он не годится).
 */
function rub(n: number): string {
  return `${n} руб`;
}

/** Строка прайса словами: «Вулкан Горелый 75000 руб за машину (плюс переправы)». */
function priceWords(line: CharterPriceLine): string {
  return `${line.to} ${rub(line.priceRub)} за машину${line.note ? ` (${line.note})` : ''}`;
}

/**
 * Комментарий лида — то, что видит менеджер в уведомлении и в админке.
 * Телефон перевозчика здесь есть намеренно: менеджеру нужно кому звонить.
 */
export function charterLeadComment(f: CharterRequestFacts): string {
  const tail: string[] = [];
  tail.push(f.dateTo ? `по ${f.dateTo}` : 'дата возвращения не указана');
  tail.push(`направление «${f.destination}»`, `человек: ${f.passengers}`);
  if (f.plan.kind === 'priced') tail.push(`по прайсу: ${priceWords(f.plan.line)}`);
  else tail.push('в прайсе такого направления нет — цену назовёт перевозчик');
  if (f.plan.vehicles && f.plan.vehicles > 1) tail.push(`по числу мест нужно не меньше ${f.plan.vehicles} машин (цена в прайсе — за одну)`);
  if (f.carrier.phone) tail.push(`телефон перевозчика: ${f.carrier.phone}`);
  if (f.comment) tail.push(`пожелания: ${f.comment}`);
  return `${charterDedupPrefix(f.carrier.name, f.dateFrom)} ${tail.join('; ')}.`;
}

/** Структурные поля в source_data лида — чтобы заявку можно было разобрать, не парся комментарий. */
export function charterSourceData(f: CharterRequestFacts): Record<string, unknown> {
  return {
    source: 'mcp',
    tool: 'request_charter',
    kind: 'charter',
    carrier_id: f.carrier.partnerId,
    carrier_slug: f.carrier.slug,
    destination: f.destination,
    date_from: f.dateFrom,
    date_to: f.dateTo,
    passengers: f.passengers,
    price_line_rub: f.plan.kind === 'priced' ? f.plan.line.priceRub : null,
    in_price_list: f.plan.kind === 'priced',
    vehicles_needed: f.plan.vehicles,
  };
}

/**
 * Ответ агенту. Один и тот же для новой заявки и для повтора: любое различие
 * — оракул «этот телефон уже просил эту машину на эту дату» (та же причина,
 * что у заявки на бронь, проверка MCP 29.09).
 */
export function charterAcceptedText(f: CharterRequestFacts, phone: string, baseUrl: string): string {
  const c = f.carrier;
  const head = `Заявка на машину принята: «${c.name}», ${f.destination}, ${dateSpan(f)}, человек: ${f.passengers}.`;
  const extra = c.extraDay
    ? ` Доплата ${rub(c.extraDay.priceRub)} в день${c.extraDay.note ? ` (${c.extraDay.note})` : ''}.`
    : '';
  const price = f.plan.kind === 'priced'
    ? ` По прайсу: ${priceWords(f.plan.line)}.${extra} Сколько дней входит в цену и что в неё включено, прайс не говорит — это уточняется у перевозчика; итоговой суммы платформа не называет.`
    : ` Направления «${f.destination}» в прайсе нет — это заказ вне прайса, цену называет перевозчик. Прайс: ${c.destinations.map(priceWords).join('; ')}.${extra}`;
  const cars = f.plan.vehicles && f.plan.vehicles > 1
    ? ` По числу мест нужно не меньше ${f.plan.vehicles} машин (в парке ${describeFleet(c.vehicles)}); цена в прайсе — за одну машину.`
    : '';
  const note = charterFootnote(c);
  return `${head}${price}${cars}`
    + ` Машина этим НЕ закреплена, занятость на даты система не ведёт: менеджер Ведара свяжется по телефону ${phone}, согласует поездку с перевозчиком и подтвердит.`
    + ` Это заявка, не оплата: расчёт с перевозчиком напрямую, через платформу не оплачивается.`
    + `${note ? ` ${note}` : ''} Карточка перевозчика: ${baseUrl}/operators/${c.slug}`;
}
