/**
 * Заявка на машину целиком (MCP `request_charter`, решение владельца 10.10:
 * «трансфер работает не по маршруту, а по заказам»). Машина — вахтовка
 * «Шатуна» с прайсом по направлениям или микроавтобус «ИП Желтухин» с ценой
 * за час и за день (1292).
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
  carrierPagePath,
  charterFootnote,
  describeFleet,
  fleetCapacity,
  matchDestinations,
  rateWords,
  vehiclesNeeded,
  type CharterCarrier,
  type CharterPriceLine,
  type CharterRate,
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
  /**
   * Направления в прайсе нет, но у перевозчика есть цена за час или за день
   * (1292): направление задаёт заказчик, а сумма зависит от времени, которого
   * прайс не знает.
   */
  | { kind: 'rated'; rates: CharterRate[]; vehicles: number | null }
  /** Такого направления в прайсе нет: заказ нестандартный, цену называет перевозчик. */
  | { kind: 'custom'; vehicles: number | null }
  /** Под слова запроса подходит несколько строк прайса: уточнить, не выбирать. */
  | { kind: 'ambiguous'; options: string[] }
  /** Людей больше, чем мест во всех машинах перевозчика. */
  | { kind: 'too_many'; seatsTotal: number };

/**
 * Что делать с заявкой, зная прайс и парк. Порядок проверок важен: вместимость
 * — факт парка и отказывает сразу, неоднозначное направление — вопрос агенту,
 * и лишь потом цена по прайсу, цена за время работы либо «нестандартный заказ».
 * Число мест не записано (1292) — вместимость неизвестна, и отказа «мест не
 * хватит» нет: решает перевозчик.
 */
export function planCharterRequest(carrier: CharterCarrier, destination: string, passengers: number): CharterPlan {
  const cap = fleetCapacity(carrier.vehicles);
  if (cap && passengers > cap.total) return { kind: 'too_many', seatsTotal: cap.total };
  const vehicles = vehiclesNeeded(carrier.vehicles, passengers);

  const hits = matchDestinations(carrier.destinations, destination);
  if (hits.length > 1) return { kind: 'ambiguous', options: hits.map((h) => h.to) };
  if (hits.length === 1) return { kind: 'priced', line: hits[0]!, vehicles };
  if (carrier.rates.length > 0) return { kind: 'rated', rates: carrier.rates, vehicles };
  return { kind: 'custom', vehicles };
}

export interface CharterRequestFacts {
  carrier: CharterCarrier;
  plan: Extract<CharterPlan, { kind: 'priced' | 'rated' | 'custom' }>;
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
 * Сезон и проходимость — «не знаем», сказанное вслух. Прайс называет цену за
 * машину, но не называет, ходит ли она в эти даты: зимой, в межсезонье, при
 * закрытой дороге или переправе ответ может быть «нет». Система этого не
 * знает и не должна ни обещать, ни отказывать за перевозчика (проверка
 * владельца 10.10: заявка на Горелый на ноябрь принята молча, и агент не
 * услышал, что дату надо согласовывать). Фраза одна и та же для любой даты:
 * делить даты на «летние» и «зимние» было бы своей догадкой о дорогах края.
 */
export const SEASON_UNKNOWN_AGENT =
  'Сезонность и проходимость дороги прайс не называет: пойдёт ли машина в эти даты, подтверждает перевозчик — человеку стоит спросить об этом прямо.';
export const SEASON_UNKNOWN_MANAGER =
  'в прайсе нет сезонности и проходимости — уточнить у перевозчика, ходит ли машина в эти даты';

/**
 * Комментарий лида — то, что видит менеджер в уведомлении и в админке.
 * Телефон перевозчика здесь есть намеренно: менеджеру нужно кому звонить.
 */
export function charterLeadComment(f: CharterRequestFacts): string {
  const tail: string[] = [];
  tail.push(f.dateTo ? `по ${f.dateTo}` : 'дата возвращения не указана');
  tail.push(`направление «${f.destination}»`, `человек: ${f.passengers}`);
  if (f.plan.kind === 'priced') tail.push(`по прайсу: ${priceWords(f.plan.line)}`);
  else if (f.plan.kind === 'rated') tail.push(`цена за время работы машины: ${ratesWords(f.plan.rates).join(', ')} — сколько часов займёт поездка, уточнить у перевозчика`);
  else tail.push('в прайсе такого направления нет — цену назовёт перевозчик');
  if (f.plan.vehicles && f.plan.vehicles > 1) tail.push(`по числу мест нужно не меньше ${f.plan.vehicles} машин (цена в прайсе — за одну)`);
  tail.push(SEASON_UNKNOWN_MANAGER);
  if (f.carrier.phone) tail.push(`телефон перевозчика: ${f.carrier.phone}`);
  if (f.comment) tail.push(`пожелания: ${f.comment}`);
  return `${charterDedupPrefix(f.carrier.name, f.dateFrom)} ${tail.join('; ')}.`;
}

/** Тарифы словами, с видом машины у каждого, когда видов несколько. */
function ratesWords(rates: readonly CharterRate[]): string[] {
  return rates.map((r) => rateWords(r, rates));
}

/** Тарифы числами: один вид машины — по единице («hour», «day»), несколько — «вид/единица». */
function ratesRub(rates: readonly CharterRate[]): Record<string, number> {
  const kinds = new Set(rates.map((r) => r.vehicleKind));
  return Object.fromEntries(rates.map((r) => [kinds.size > 1 ? `${r.vehicleKind}/${r.unit}` : r.unit, r.priceRub]));
}

/**
 * Факты заявки для САМОГО перевозчика (личное уведомление в MAX/Telegram,
 * lib/notifications/partner-request-notify): без его же телефона и без заметок
 * менеджеру («уточнить у перевозчика») — комментарий лида для него не годится
 * дословно. ПД заказчика здесь нет: их добавляет уведомление в текст для MAX.
 */
export function charterRequestLines(f: CharterRequestFacts): string[] {
  const lines = [
    `Направление: ${f.destination}`,
    `Даты: ${dateSpan(f)}`,
    `Человек: ${f.passengers}`,
  ];
  if (f.plan.kind === 'priced') lines.push(`По прайсу: ${priceWords(f.plan.line)}`);
  else if (f.plan.kind === 'rated') lines.push(`По прайсу: ${ratesWords(f.plan.rates).join('; ')} — часов поездки заказчик не называл`);
  else lines.push('Такого направления в прайсе нет — цену называете вы');
  if (f.plan.vehicles && f.plan.vehicles > 1) lines.push(`По числу мест нужно не меньше ${f.plan.vehicles} машин`);
  return lines;
}

/** Чьей дверью пришла заявка: форма на странице перевозчика или инструмент MCP. */
export type CharterDoor = 'form' | 'mcp';

/** Структурные поля в source_data лида — чтобы заявку можно было разобрать, не парся комментарий. */
export function charterSourceData(f: CharterRequestFacts, door: CharterDoor = 'mcp'): Record<string, unknown> {
  return {
    ...(door === 'mcp' ? { source: 'mcp', tool: 'request_charter' } : { source: 'transfer_page' }),
    kind: 'charter',
    carrier_id: f.carrier.partnerId,
    carrier_slug: f.carrier.slug,
    destination: f.destination,
    date_from: f.dateFrom,
    date_to: f.dateTo,
    passengers: f.passengers,
    price_line_rub: f.plan.kind === 'priced' ? f.plan.line.priceRub : null,
    in_price_list: f.plan.kind === 'priced',
    // Цена за час и за день (1292) — числами, как строка прайса: менеджер
    // разбирает заявку, не парся комментарий. Тарифы на разные виды машин
    // (1318) — ключ «вид/единица», иначе два «day» затёрли бы друг друга.
    rates_rub: f.plan.kind === 'rated'
      ? ratesRub(f.plan.rates)
      : null,
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
    : f.plan.kind === 'rated'
      ? ` Цена у перевозчика — за время работы машины, направление задаёт заказчик: ${ratesWords(f.plan.rates).join('; ')}. Сколько часов займёт поездка и что входит в цену, прайс не говорит — это уточняется у перевозчика; итоговой суммы платформа не называет.`
      : ` Направления «${f.destination}» в прайсе нет — это заказ вне прайса, цену называет перевозчик. Прайс: ${c.destinations.map(priceWords).join('; ')}.${extra}`;
  const cars = f.plan.vehicles && f.plan.vehicles > 1
    ? ` По числу мест нужно не меньше ${f.plan.vehicles} машин (в парке ${describeFleet(c.vehicles, c.seatClasses)}); цена в прайсе — за одну машину.`
    : '';
  const note = charterFootnote(c);
  return `${head}${price}${cars}`
    + ` Машина этим НЕ закреплена, занятость на даты система не ведёт: менеджер Ведара свяжется по телефону ${phone}, согласует поездку с перевозчиком и подтвердит.`
    + ` ${SEASON_UNKNOWN_AGENT}`
    + ` Это заявка, не оплата: расчёт с перевозчиком напрямую, через платформу не оплачивается.`
    + `${note ? ` ${note}` : ''} Карточка перевозчика: ${baseUrl}${carrierPagePath(c.slug)}`;
}
