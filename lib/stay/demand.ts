/**
 * Словарь счётчика спроса на жильё (решение владельца 29.09).
 *
 * Зачем. Вопрос «подключаться ли к TravelLine» стоит денег: 100 000 ₽ за
 * подключение и минимум 200 000 ₽ в год, при нуле продаж тоже. Ответ на него
 * — не мнение, а число: ищут ли у нас жильё, где и находят ли. До этого дня
 * спрос на жильё было нечем увидеть: просмотры каталога считались, но поиск
 * с условиями, пустой ответ Кузьмича и касание формы брони — нет.
 *
 * Событие одно — шаг воронки `stay_search`, а в `entity_id` лежит пара
 * «канал:исход». Отдельных шагов на каждую пару не заводится: словарь шагов
 * общий для всей воронки, и восемь новых имён ради одного вопроса размыли бы
 * его.
 *
 * Модуль чистый — без базы: его читают и клиентский маяк каталога, и серверная
 * запись поиска агента. Запись — `lib/stay/demand-record.ts`.
 */

/** Откуда пришёл поиск. */
export const STAY_SEARCH_CHANNELS = [
  /** Каталог /accommodations: посетитель задал хоть одно условие. */
  'web',
  /**
   * Инструмент `search_accommodations`: Кузьмич (веб, Telegram, MAX) и
   * публичный MCP идут через ОДНУ функцию и здесь неразличимы. Доля MCP
   * видна отдельно — в `mcp_tool_calls`; вычитать её отсюда перепись НЕ
   * должна: MCP-вызов может упасть до поиска, и разность соврёт.
   */
  'agent',
] as const;

/**
 * Чем кончился поиск. Три исхода, а не два (§4.0): «витрина не ответила» —
 * факт о нас, а не о спросе, и склеить его с «ничего не нашлось» значит
 * выдать поломку за пустую витрину.
 */
export const STAY_SEARCH_OUTCOMES = ['found', 'empty', 'failed'] as const;

export type StaySearchChannel = (typeof STAY_SEARCH_CHANNELS)[number];
export type StaySearchOutcome = (typeof STAY_SEARCH_OUTCOMES)[number];

/** Значение `funnel_events.entity_id` для шага `stay_search`. */
export function staySearchEntity(channel: StaySearchChannel, outcome: StaySearchOutcome): string {
  return `${channel}:${outcome}`;
}

/** Обратный разбор; чужая строка — null, а не угаданный исход. */
export function parseStaySearchEntity(
  entity: string | null,
): { channel: StaySearchChannel; outcome: StaySearchOutcome } | null {
  if (!entity) return null;
  const [channel, outcome, ...rest] = entity.split(':');
  if (rest.length > 0) return null;
  if (!(STAY_SEARCH_CHANNELS as readonly string[]).includes(channel)) return null;
  if (!(STAY_SEARCH_OUTCOMES as readonly string[]).includes(outcome)) return null;
  return { channel: channel as StaySearchChannel, outcome: outcome as StaySearchOutcome };
}

/** Строка группировки `funnel_events` по `entity_id` для шага `stay_search`. */
export interface StaySearchRow {
  entity_id: string | null;
  searches: number;
  visitors: number;
}

export type StaySearchTable = Record<StaySearchChannel, Record<StaySearchOutcome, number>>;

/**
 * Раскладка поисков по каналам и исходам. Нулевые клетки присутствуют:
 * отсутствие строки — не «нет такого исхода», а ноль, и в ответе переписи он
 * обязан быть виден числом. Чужие `entity_id` не угадываются, а возвращаются
 * отдельным счётом — иначе опечатка в маяке тихо ушла бы в чей-то исход.
 */
export function summarizeStaySearches(rows: readonly StaySearchRow[]): {
  searches: StaySearchTable;
  web_visitors: number;
  unrecognized: number;
} {
  const zero = (): Record<StaySearchOutcome, number> =>
    Object.fromEntries(STAY_SEARCH_OUTCOMES.map(o => [o, 0])) as Record<StaySearchOutcome, number>;
  const searches = Object.fromEntries(
    STAY_SEARCH_CHANNELS.map(c => [c, zero()]),
  ) as StaySearchTable;
  let webVisitors = 0;
  let unrecognized = 0;
  for (const r of rows) {
    const key = parseStaySearchEntity(r.entity_id);
    if (!key) { unrecognized += r.searches; continue; }
    searches[key.channel][key.outcome] += r.searches;
    if (key.channel === 'web') webVisitors += r.visitors;
  }
  return { searches, web_visitors: webVisitors, unrecognized };
}
