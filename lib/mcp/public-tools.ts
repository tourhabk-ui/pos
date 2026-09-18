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
  description: 'Оставить заявку на подбор тура по Камчатке: менеджер платформы свяжется по телефону. Обязательны имя, телефон и описание запроса (даты, состав группы, интересы). Не бронь и не оплата — только заявка. Имя и телефон — персональные данные: спроси у человека согласие на их обработку и передай consent: true, иначе заявка не создаётся.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для связи (обязателен)' },
      comment: { type: 'string', description: 'Запрос: даты, сколько человек, что интересует' },
      interest: { type: 'string', description: 'Название тура/маршрута, если уже выбран' },
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
  description: 'Заявка на бронь конкретного тура на дату. Перед вызовом проверь свободные даты через get_tour_availability. Заявку подтверждает оператор по телефону — это не мгновенная бронь и не оплата. Если на дату нет мест, заявка не создаётся и в ответе будут ближайшие свободные даты. Имя и телефон — персональные данные: спроси согласие на их обработку и передай consent: true.',
  inputSchema: {
    type: 'object',
    properties: {
      tour: { type: 'string', description: 'Название тура или числовой ID (из get_tours / get_tour_availability)' },
      date: { type: 'string', description: 'Дата тура, YYYY-MM-DD' },
      participants: { type: 'string', description: 'Сколько человек (1–30). Не сказано — 1.' },
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для подтверждения (обязателен)' },
      comment: { type: 'string', description: 'Пожелания, вопросы, состав группы' },
      consent: { type: 'boolean', description: 'Человек согласен на обработку своих персональных данных (имя, телефон) для связи по этой заявке. Спроси прямо и передай true. Без согласия заявка не создаётся.' },
    },
    required: ['tour', 'date', 'name', 'phone', 'consent'],
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
 *     вызова. Почти всё читает нашу базу; наружу в момент вызова идёт только
 *     погода.
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
  search_accommodations: READ,
  search_transfers:      READ,
  search_gear:           READ,
  make_trip_plan:        READ,
  create_lead:           WRITE,
  create_booking_request: WRITE,
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
  get_tours:             { title: 'Tour catalogue',        lead: 'Kamchatka tour catalogue: operator tours with prices and dates; live availability via get_tour_availability.' },
  get_tour_details:      { title: 'Tour details',          lead: 'Kamchatka tour details: program, what is included, what to bring, safety notes.' },
  get_tour_availability: { title: 'Tour availability',     lead: 'Kamchatka tour live availability by date: free seats and nearest open dates.' },
  get_guardian_context:  { title: 'Place safety',          lead: 'Kamchatka safety context for a place or route: hazards, active alerts, advice.' },
  get_place_info:        { title: 'Place info',            lead: 'Kamchatka place facts: type, coordinates, hazards, nearby places.' },
  safety_status:         { title: 'Regional safety status', lead: 'Kamchatka regional safety status: active alerts (seismic, volcanic, weather, MChS) with their source.' },
  get_weather:           { title: 'Weather',               lead: 'Weather for a Kamchatka place or coordinates.' },
  search_accommodations: { title: 'Stays',                 lead: 'Stays in Kamchatka from platform partners.' },
  search_transfers:      { title: 'Transfers',             lead: 'Transfers in Kamchatka from platform partners.' },
  search_gear:           { title: 'Gear rental',           lead: 'Gear rental in Kamchatka from platform partners.' },
  make_trip_plan:        { title: 'Trip plan',             lead: 'Day-by-day Kamchatka trip plan with weather and live availability.' },
  create_lead:           { title: 'Tour request',          lead: 'Tour-selection request for Kamchatka, human-confirmed by a manager; not a booking, no payment.' },
  create_booking_request: { title: 'Booking request',      lead: 'Booking request for a Kamchatka tour on a date, human-confirmed by the operator; live availability is checked first; no payment.' },
};

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
  const described = en ? { ...tool, title: en.title, description: `${en.lead} ${tool.description}` } : tool;
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
  version: '2.3.0',
  description: 'Ведар — данные Камчатки: обстановка в крае и безопасность мест, туры и их реальная занятость, жильё, снаряжение, трансферы, погода, план поездки. Записи две: заявка на подбор (create_lead) и заявка на бронь тура на дату (create_booking_request) — обе подтверждает человек.',
} as const;
