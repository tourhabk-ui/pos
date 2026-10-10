/**
 * Что публичный MCP-сервер показывает наружу — один список на всех.
 *
 * Раньше набор инструментов собирался прямо в `/api/mcp/route.ts`, и это было
 * нормально, пока читатель был один. Теперь их два: сам сервер и манифест
 * `/.well-known/mcp.json`, по которому чужой агент нас находит. Два списка
 * разошлись бы в первый же день — манифест обещал бы инструменты, которых нет,
 * или молчал бы о новых.
 *
 * Инструменты берутся из реестра Кузьмича: один мозг — два протокола. Внешний
 * агент видит те же данные, что турист в чате, и не отстаёт от него.
 */

import { TOOL_REGISTRY } from '@/lib/kuzmich/tool-schemas';

/**
 * Не для анонимного публичного входа: жгут внешние квоты и пишут учёт
 * использования (search_kamchatka — платный веб-поиск, search_taaft — внешний
 * каталог с трекингом).
 */
export const EXCLUDED_TOOLS = new Set(['search_kamchatka', 'search_taaft']);

/**
 * create_lead — единственный ПИШУЩИЙ инструмент наружу. Бронь и оплату
 * анонимному агенту не отдаём сознательно: чужие деньги и спам. Заявка
 * безопасна — идёт в общий createLead() со скорингом и дедупом.
 */
export const CREATE_LEAD_TOOL = {
  name: 'create_lead',
  description: 'Оставить заявку на подбор тура по Камчатке: менеджер платформы свяжется по телефону. Обязательны имя, телефон и описание запроса (даты, состав группы, интересы). Это только заявка: оплаты через платформу нет. Имя и телефон — персональные данные: спроси у человека согласие на их обработку и передай consent: true, иначе заявка не создаётся.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для связи (обязателен)' },
      comment: { type: 'string', description: 'Запрос: даты, сколько человек, что интересует' },
      interest: { type: 'string', description: 'Название тура/маршрута, если уже выбран' },
      plan_id: { type: 'string', description: 'Номер плана из make_trip_plan, если заявка — на этот план: менеджер получит план целиком (состав, туры по дням, смету) и не будет переспрашивать.' },
      consent: { type: 'boolean', description: 'Человек согласен на обработку своих персональных данных (имя, телефон) для связи по этой заявке. Спроси прямо и передай true. Без согласия заявка не создаётся.' },
    },
    required: ['name', 'phone', 'comment', 'consent'],
  },
} as const;

/**
 * create_booking_request — заявка на бронь КОНКРЕТНОГО тура на дату
 * (Эволюция 3.0, п.4 — MCP-бронирование, владелец 08.08: «делай»).
 *
 * Это ЗАЯВКА, не бронь: исполнение проверяет реальную занятость на дату
 * (движок планера — тот же расчёт, что у гейта брони) и создаёт лид через
 * общий createLead() (скоринг, дедуп, уведомление менеджеру). Оператор
 * подтверждает голосом/чатом; слоты фантомными бронями не блокируются,
 * платёжный контур не задет.
 */
export const BOOKING_REQUEST_TOOL = {
  name: 'create_booking_request',
  description: 'Заявка оператору на конкретный тур и дату. Перед вызовом проверь свободные даты через get_tour_availability. Заявку подтверждает оператор по телефону — мгновенного подтверждения нет, оплаты через платформу нет. Если на дату нет мест, заявка не создаётся и в ответе будут ближайшие свободные даты. Если у тура вообще нет расписания в системе (оператор берёт туристов без календаря), вместо отказа оператору уходит запрос мест: в ответе будет ссылка на страницу статуса — передай её человеку; места этим не закрепляются. Имя и телефон — персональные данные: спроси согласие на их обработку и передай consent: true.',
  inputSchema: {
    type: 'object',
    properties: {
      tour: { type: 'string', description: 'Название тура или числовой ID (из get_tours / get_tour_availability)' },
      date: { type: 'string', description: 'Дата тура, YYYY-MM-DD' },
      participants: { type: 'string', description: 'Сколько человек (1–30). Не сказано — 1.' },
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для подтверждения (обязателен)' },
      comment: { type: 'string', description: 'Пожелания, вопросы, состав группы' },
      plan_id: { type: 'string', description: 'Номер плана из make_trip_plan, если тур — из этого плана: оператор увидит, частью какой поездки он стоит.' },
      consent: { type: 'boolean', description: 'Человек согласен на обработку своих персональных данных (имя, телефон) для связи по этой заявке. Спроси прямо и передай true. Без согласия заявка не создаётся.' },
    },
    required: ['tour', 'date', 'name', 'phone', 'consent'],
  },
} as const;

/**
 * request_charter — заявка на вахтовку ЦЕЛОЙ МАШИНОЙ у перевозчика «под заказ»
 * (решение владельца 10.10: «трансфер работает не по маршруту, а по заказам»).
 *
 * Не рейс и не место: у такого перевозчика нет календаря, направление и дни
 * задаёт заказчик, цена — за машину по прайсу (lib/transfers/charter). Поэтому
 * инструмент не проверяет занятость (её система не ведёт) и не создаёт
 * бронь: заявка идёт общим createLead() к менеджеру, перевозчик подтверждает
 * через него. Оплаты через платформу нет — расчёт напрямую.
 */
export const REQUEST_CHARTER_TOOL = {
  name: 'request_charter',
  description: 'Заявка на вахтовку целой машиной у перевозчика «под заказ»: куда, на какие даты, сколько человек. Прайс и перевозчиков смотри через search_transfers (раздел «под заказ»). Календаря у таких перевозчиков нет, поэтому заявка не проверяет занятость машин: менеджер Ведара свяжется по телефону, согласует поездку с перевозчиком и подтвердит. Цена — за машину по прайсу; направления нет в прайсе — заказ принимается, цену называет перевозчик. Оплаты через платформу нет, расчёт напрямую. Имя и телефон — персональные данные: спроси согласие на их обработку и передай consent: true, иначе заявка не создаётся.',
  inputSchema: {
    type: 'object',
    properties: {
      destination: { type: 'string', description: 'Куда ехать: слово или название из прайса («Горелый», «Толбачик») либо своё направление' },
      date_from: { type: 'string', description: 'Дата выезда, YYYY-MM-DD' },
      date_to: { type: 'string', description: 'Дата возвращения, YYYY-MM-DD, если известна' },
      passengers: { type: 'string', description: 'Сколько человек (1–60)' },
      name: { type: 'string', description: 'Имя заказчика' },
      phone: { type: 'string', description: 'Телефон для связи (обязателен)' },
      carrier: { type: 'string', description: 'Перевозчик: название или slug из search_transfers. Не нужен, пока перевозчик один.' },
      comment: { type: 'string', description: 'Пожелания: сколько дней нужна машина, что везти, откуда забирать' },
      consent: { type: 'boolean', description: 'Человек согласен на обработку своих персональных данных (имя, телефон) для связи по этой заявке. Спроси прямо и передай true. Без согласия заявка не создаётся.' },
    },
    required: ['destination', 'date_from', 'passengers', 'name', 'phone', 'consent'],
  },
} as const;

/**
 * Подсказки хосту о природе инструмента (MCP `ToolAnnotations`).
 *
 * Хост по ним решает, спрашивать ли человека перед вызовом, и каталоги
 * (реестр MCP, каталог коннекторов Claude) требуют их на каждом инструменте.
 * До 17.09 их не было вовсе — хост видел тринадцать одинаковых кнопок и не
 * мог отличить «посмотреть погоду» от «оставить телефон менеджеру».
 *
 * Значения — факты об исполнении, не пожелания:
 *   · `readOnlyHint` — инструмент ничего не меняет;
 *   · `destructiveHint` — может уничтожить или необратимо изменить; у заявок
 *     `false`: они СОЗДАЮТ запись, а не трогают чужие;
 *   · `idempotentHint` — повтор с теми же аргументами ничего не добавляет;
 *     у заявок `false` — каждый вызов ложится к менеджеру отдельно (дедуп
 *     внутри есть, но контракт этого не обещает);
 *   · `openWorldHint` — ходит ли инструмент к внешним сущностям в момент
 *     вызова. Почти всё читает нашу базу; наружу в момент вызова идут погода
 *     и план поездки (он берёт прогноз Open-Meteo на даты плана — строка
 *     «только погода» стояла здесь неверной до проверки MCP 29.09).
 */
export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

/** Подсказки хосту по имени инструмента. Инструмент без записи здесь — красный сторож. */
export const TOOL_ANNOTATIONS: Record<string, Omit<McpToolAnnotations, 'title'>> = {
  get_tours:             READ,
  get_tour_details:      READ,
  get_tour_availability: READ,
  get_guardian_context:  READ,
  get_place_info:        READ,
  safety_status:         READ,
  get_weather:           { ...READ, openWorldHint: true },
  get_volcano_status:    READ,
  search_accommodations: READ,
  search_transfers:      READ,
  search_gear:           READ,
  make_trip_plan:        { ...READ, openWorldHint: true },
  // Правка черновика плана (#2224). Черновик — внутреннее состояние самого
  // инструмента, анонимное и на 7 дней; до человека или оператора он не
  // доходит, в отличие от заявки. Поэтому «только чтение» по смыслу хоста и
  // лимит чтения, а не пять записей в час. Не идемпотентен: повтор
  // add_day добавит ещё один день.
  edit_trip_plan:        { ...READ, idempotentHint: false },
  create_lead:           WRITE,
  create_booking_request: WRITE,
  request_charter:       WRITE,
};

/**
 * Английский слой НАРУЖУ: заголовок и первая фраза описания.
 *
 * Замер 18.09: все 13 описаний в `tools/list` были только по-русски, ни в
 * одном не было слова «Kamchatka» латиницей. Модель семантику через язык
 * переносит, а поиск Smithery, оценка Glama и host с ранжированием по словам
 * смотрят на буквы: агенту, которому сказали «Kamchatka», наши инструменты
 * выглядели как «Каталог туров» и «Обстановка в крае».
 *
 * Граница проведена намеренно: английская фраза добавляется ТОЛЬКО здесь,
 * в публичном реестре MCP. Кузьмич читает свои русские описания из
 * `lib/kuzmich/tool-schemas.ts` без изменений — его выбор инструмента этим
 * слоем не трогается, и сторож держит равенство русской части.
 *
 * Слова — по роли инструмента, а не эссе (решение владельца 18.09):
 * «Kamchatka» у всех; safety/alerts у безопасности; «live availability» у
 * туров и дат; «human-confirmed» у заявок.
 */
export const TOOL_ENGLISH: Record<string, { title: string; lead: string }> = {
  // Пары, которые оценщик путал (Glama TDQS 18.09, Disambiguation 4/5):
  // каждая фраза говорит, когда брать этот инструмент, а когда соседний.
  get_tours:             { title: 'Tour catalogue',        lead: 'Kamchatka tour catalogue: list operator tours with prices and dates; live availability via get_tour_availability. For one tour in depth use get_tour_details.' },
  get_tour_details:      { title: 'Tour details',          lead: 'One Kamchatka tour in depth: program, what is included, what to bring, safety notes. To list or search tours use get_tours.' },
  get_tour_availability: { title: 'Tour availability',     lead: 'Kamchatka tour live availability by date: free seats and nearest open dates.' },
  get_guardian_context:  { title: 'Place safety',          lead: 'Kamchatka safety context for a place or route: hazards, active alerts, advice. For plain facts (type, coordinates) use get_place_info.' },
  get_place_info:        { title: 'Place info',            lead: 'Kamchatka place facts only: what it is, type, coordinates. Does not return hazards, alerts or nearby places — for safety use get_guardian_context.' },
  safety_status:         { title: 'Regional safety status', lead: 'Kamchatka regional safety status: active alerts (seismic, volcanic, weather, MChS) with their source.' },
  get_weather:           { title: 'Weather',               lead: 'Daily weather forecast (Open-Meteo) for a Kamchatka place by name, or for any point by latitude/longitude.' },
  get_volcano_status:    { title: 'Volcano status',        lead: 'Kamchatka volcano activity: KVERT aviation code and KB GS RAS seismicity. No name — all elevated. For one place or route use get_guardian_context.' },
  search_accommodations: { title: 'Stays',                 lead: 'Stays in Kamchatka from platform partners.' },
  search_transfers:      { title: 'Transfers',             lead: 'Kamchatka transfers: free seats in dated carrier trips, plus whole-vehicle charter prices (vakhtovka trucks). No dated trips is normal, not an error.' },
  search_gear:           { title: 'Gear rental',           lead: 'Gear rental in Kamchatka from platform partners. An empty result is normal: the rental shelf may have no partners yet, and the answer says so — do not invent rental shops.' },
  make_trip_plan:        { title: 'Trip plan',             lead: 'Day-by-day Kamchatka trip plan with weather and live availability; returns a plan ID for edit_trip_plan.' },
  edit_trip_plan:        { title: 'Edit trip plan',        lead: 'Edit a Kamchatka trip plan from make_trip_plan by its ID: add, remove or move a day, change lodging level, or apply a flight delay the traveller reports; untouched days stay as they were.' },
  create_lead:           { title: 'Tour request',          lead: 'Tour-selection request for Kamchatka when no tour or date is chosen yet; human-confirmed by a manager, no payment. Needs consent: true from the traveller, otherwise refused and nothing is stored.' },
  create_booking_request: { title: 'Booking request',      lead: 'Booking request for a Kamchatka tour on a date; live availability checked first, human-confirmed by the operator, no payment. Needs consent: true, otherwise refused. No tour yet — use create_lead.' },
  request_charter:       { title: 'Charter request',       lead: 'Whole-vehicle (vakhtovka) request to a Kamchatka charter carrier: destination, dates, group size; human-confirmed by a manager, no payment. Needs consent: true. Prices: search_transfers.' },
};

/**
 * Английский слой для ПАРАМЕТРОВ — тем же правилом, что для описаний:
 * английская фраза впереди, русское описание Кузьмича следом целиком, схемы
 * Кузьмича не тронуты. Glama TDQS 18.09: Completeness 4/5 — параметры были
 * только по-русски и без примеров. Пример даётся там, где формат однозначен
 * (дата, число, тип); текстовые поля без примера честнее, чем с выдуманным.
 */
export const PARAM_ENGLISH: Record<string, Record<string, { lead: string; example?: string | boolean }>> = {
  get_tours: {
    activity_type: { lead: 'Activity filter, free text (Russian works best): fishing, volcanoes, bears, geysers, trekking.', example: 'вулканы' },
    page: { lead: 'Catalogue page, 7 tours each, starting at 1; the reply ends with the page count and the next page.', example: '2' },
  },
  get_tour_details: {
    name: { lead: 'Tour title or a keyword from it.', example: 'рыбалка' },
  },
  get_tour_availability: {
    tour: { lead: 'Tour title, keyword or numeric ID from get_tours.' },
    date_from: { lead: 'Start of the window, YYYY-MM-DD; default today.', example: '2027-07-15' },
    days: { lead: 'Window length in days, 1–31; default 14.', example: '14' },
    people: { lead: 'Number of travellers, 1–30. When given, each date shows the full booking total — the same calculation the booking itself uses.', example: '2' },
  },
  get_guardian_context: {
    place: { lead: 'Place or route name.', example: 'Авачинский вулкан' },
  },
  get_place_info: {
    name: { lead: 'Place name.', example: 'Курильское озеро' },
  },
  get_weather: {
    place: { lead: 'Place name from the platform directory (Russian works best).', example: 'Мутновский' },
    lat: { lead: 'Latitude in decimal degrees; use together with lng. Coordinates take precedence over place.', example: '52.45' },
    lng: { lead: 'Longitude in decimal degrees; use together with lat.', example: '158.19' },
    days: { lead: 'Forecast days, 1–7; default 3.', example: '3' },
  },
  get_volcano_status: {
    volcano: { lead: 'Volcano name; empty — all volcanoes elevated on either scale.', example: 'Ключевской' },
  },
  safety_status: {},
  search_accommodations: {
    zone: { lead: 'Area or town name.', example: 'Паратунка' },
    type: { lead: 'Stay type: hotel, hostel, guesthouse, glamping, apartment, cottage.', example: 'hotel' },
    price_max: { lead: 'Maximum price per night, RUB.', example: '8000' },
  },
  search_transfers: {
    from: { lead: 'Window start, YYYY-MM-DD; default today.', example: '2027-07-15' },
    to: { lead: 'Window end, YYYY-MM-DD; default +14 days, at most 60.', example: '2027-07-29' },
    seats: { lead: 'Seats needed; default 1.', example: '2' },
    place: { lead: 'Destination or origin keyword.', example: 'аэропорт' },
  },
  search_gear: {
    query: { lead: 'What to rent: tent, sleeping bag, trekking poles, a brand.', example: 'палатка' },
    category: { lead: 'Gear category, if known.' },
    price_max: { lead: 'Maximum price per day, RUB.', example: '1500' },
  },
  make_trip_plan: {
    days: { lead: 'Trip length in days, 3–21; default 7.', example: '7' },
    interests: { lead: 'Interests in free text.', example: 'вулканы и медведи' },
    when: { lead: 'When the trip starts: a Russian month name or YYYY-MM-DD; season decides what is possible in Kamchatka. Default is one month from today.', example: '2027-07-10' },
    travel_style: { lead: 'How the traveller wants to go: self (no guide, only where our safety data allows), operator (operator tours) or mixed; default mixed.', example: 'self' },
    rest_days: { lead: 'Rest days to add, 0–14; a weather reserve day is added separately when needed.', example: '1' },
    adults: { lead: 'Number of adults, 1–30; default 2, and the answer says it was assumed.', example: '2' },
    children: { lead: 'Children ages, comma-separated; ages decide which activities are allowed.', example: '6, 10' },
    budget_tier: { lead: 'Budget level: economy, comfort or premium; default comfort.', example: 'economy' },
  },
  edit_trip_plan: {
    plan_id: { lead: 'Plan ID from the make_trip_plan answer.' },
    action: { lead: 'add_day, remove_day, move_day, set_lodging or flight_delay.', example: 'add_day' },
    day: { lead: 'Day number in the plan, for remove_day and move_day.', example: '3' },
    to_day: { lead: 'New position of the day, for move_day.', example: '2' },
    interest: { lead: 'Activity for add_day, free text (Russian works best).', example: 'рыбалка' },
    lodging: { lead: 'Lodging level for set_lodging: economy, comfort or premium.', example: 'economy' },
    delay_days: { lead: 'For flight_delay: how many days the arrival flight is delayed, 1–7.', example: '2' },
    keep_return: { lead: 'For flight_delay: yes keeps the return date and shortens the trip (default); no shifts the whole trip.', example: 'yes' },
  },
  create_lead: {
    name: { lead: "Traveller's name." },
    phone: { lead: 'Contact phone, required.' },
    comment: { lead: 'The request: dates, group size, interests.' },
    interest: { lead: 'Tour or route name, if already chosen.' },
    plan_id: { lead: 'Plan ID from make_trip_plan when the request is for that plan: the manager gets the whole plan (group, tours by day, estimate).', example: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' },
    consent: { lead: 'Explicit consent to process name and phone for this request; ask the person and pass true, otherwise the request is not created.', example: true },
  },
  create_booking_request: {
    tour: { lead: 'Tour title or numeric ID from get_tours / get_tour_availability.' },
    date: { lead: 'Tour date, YYYY-MM-DD.', example: '2027-07-15' },
    participants: { lead: 'Number of people, 1–30; default 1.', example: '2' },
    name: { lead: "Traveller's name." },
    phone: { lead: 'Phone for confirmation, required.' },
    comment: { lead: 'Wishes, questions, group composition.' },
    plan_id: { lead: 'Plan ID from make_trip_plan when this tour is part of that plan: the operator sees the whole trip.', example: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' },
    consent: { lead: 'Explicit consent to process name and phone for this request; ask the person and pass true, otherwise the request is not created.', example: true },
  },
  request_charter: {
    destination: { lead: 'Where to go: a word from the carrier price list or your own destination.', example: 'Горелый' },
    date_from: { lead: 'Departure date, YYYY-MM-DD.', example: '2027-07-15' },
    date_to: { lead: 'Return date, YYYY-MM-DD, if known.', example: '2027-07-17' },
    passengers: { lead: 'Number of people, 1–60.', example: '8' },
    name: { lead: "Customer's name." },
    phone: { lead: 'Contact phone, required.' },
    carrier: { lead: 'Carrier name or slug from search_transfers; not needed while there is one carrier.', example: 'shatun' },
    comment: { lead: 'Wishes: how many days the vehicle is needed, what to carry, pickup place.' },
    consent: { lead: 'Explicit consent to process name and phone for this request; ask the person and pass true, otherwise the request is not created.', example: true },
  },
};

interface JsonSchemaLike {
  properties?: Record<string, { description?: string; examples?: unknown[]; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** Копия схемы с английским слоем у каждого параметра; исходная схема Кузьмича не мутируется. */
function withParamEnglish(name: string, schema: unknown): unknown {
  const en = PARAM_ENGLISH[name];
  if (!en || typeof schema !== 'object' || schema === null) return schema;
  const copy = JSON.parse(JSON.stringify(schema)) as JsonSchemaLike;
  for (const [param, prop] of Object.entries(copy.properties ?? {})) {
    const p = en[param];
    if (!p) continue;
    prop.description = prop.description ? `${p.lead} ${prop.description}` : p.lead;
    if (p.example !== undefined) prop.examples = [p.example];
  }
  return copy;
}

export interface PublicMcpTool {
  name: string;
  /** Человеческое имя для каталогов и списков хоста. */
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations?: McpToolAnnotations;
}

function withAnnotations(tool: { name: string; description: string; inputSchema: unknown }): PublicMcpTool {
  const hints = TOOL_ANNOTATIONS[tool.name];
  const en = TOOL_ENGLISH[tool.name];
  // Нет записи — нет подсказок и нет английского слоя, а не выдуманные. По
  // спеке все hint'ы необязательны; отсутствие честнее угаданного
  // `readOnlyHint: true`. Русское описание Кузьмича остаётся целиком.
  const described = en
    ? { ...tool, title: en.title, description: `${en.lead} ${tool.description}`, inputSchema: withParamEnglish(tool.name, tool.inputSchema) }
    : tool;
  return hints && en ? { ...described, annotations: { title: en.title, ...hints } } : described;
}

export const PUBLIC_MCP_TOOLS: PublicMcpTool[] = [
  ...Object.values(TOOL_REGISTRY)
    .filter((t) => !EXCLUDED_TOOLS.has(t.definition.function.name))
    .map((t) => withAnnotations({
      name: t.definition.function.name,
      description: t.definition.function.description,
      // OpenAI-style parameters — это та же JSON-схема, что MCP inputSchema
      inputSchema: t.definition.function.parameters,
    })),
  withAnnotations(CREATE_LEAD_TOOL),
  withAnnotations(BOOKING_REQUEST_TOOL),
  withAnnotations(REQUEST_CHARTER_TOOL),
];

export const PUBLIC_MCP_TOOL_NAMES = new Set(PUBLIC_MCP_TOOLS.map((t) => t.name));

/**
 * Пишущие инструменты — те, чья аннотация говорит `readOnlyHint: false`.
 * Одно правило на лимит записи в роуте и на подсказку хосту: раньше роут
 * держал свой список из двух имён, и третий пишущий инструмент получил бы
 * щедрый лимит чтения, пока кто-то не вспомнил бы про второй список.
 */
export const WRITE_TOOL_NAMES = new Set(
  PUBLIC_MCP_TOOLS.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name),
);

export const MCP_SERVER_INFO = {
  name: 'vedar-mcp',
  // Имя для людей (serverInfo.title, ревизия 2025-06-18) — то, под которым
  // коннектор числится в каталогах.
  title: 'Ведар — Камчатка',
  version: '2.3.0',
  description: 'Ведар — данные Камчатки: обстановка в крае и безопасность мест, туры и их реальная занятость, жильё, снаряжение, трансферы, погода, план поездки. Записи три: заявка на подбор (create_lead), заявка оператору на тур и дату (create_booking_request) и заявка на вахтовку целой машиной (request_charter) — все подтверждает человек.',
} as const;
