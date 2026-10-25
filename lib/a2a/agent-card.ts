/**
 * Визитка A2A-агента (Agent Card) — из того же реестра инструментов, что
 * MCP-сервер и манифест (lib/mcp/public-tools.ts): навык на каждый
 * публичный инструмент плюс навык свободного разговора. Обещать в карточке
 * то, чего нет в сервере, — худший вид молчаливой лжи (та же мысль, что у
 * /.well-known/mcp.json), поэтому карточка не держит своего списка.
 *
 * Две карточки, потому что клиенты ищут по двум адресам:
 *  - 1.0 — `/.well-known/agent-card.json`: `supportedInterfaces[]` с
 *    `protocolBinding` и `protocolVersion`, без `url` на верхнем уровне;
 *  - 0.3 — `/.well-known/agent.json`: `url` + `preferredTransport`,
 *    `protocolVersion: "0.3.0"`, `additionalInterfaces[]`.
 * По переписи APIs.io (07.2026) 15 из 65 опубликованных карточек лежали
 * только по старому пути и для клиентов 1.0 не существовали; у 40 не было
 * `protocolVersion`. Здесь оба адреса и обе версии.
 *
 * Сторож: tests/unit/a2a-agent-card.test.ts.
 */

import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, WRITE_TOOL_NAMES, TOOL_ENGLISH, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { A2A_DESCRIPTION_ZH, A2A_CHAT_EXAMPLE_ZH } from '@/lib/mcp/zh-layer';

export const A2A_PROTOCOL_VERSION = '1.0';
export const A2A_LEGACY_PROTOCOL_VERSION = '0.3.0';

export const AGENT_CARD_PATH = '/.well-known/agent-card.json';
export const LEGACY_AGENT_CARD_PATH = '/.well-known/agent.json';
export const A2A_JSONRPC_PATH = '/api/a2a';
export const A2A_REST_PATH = '/api/a2a/v1';
/**
 * База HTTP+JSON в карточке 0.3. Пути REST версии 0.3 сами несут `/v1`
 * (`POST /v1/message:send`, раздел 3.2.3 спецификации 0.3.0) и дописываются
 * к url интерфейса, а пути 1.0 — без него (`POST /message:send`, раздел 11.3).
 * Поэтому интерфейс 0.3 — `/api/a2a`: клиент 0.3 придёт на
 * `/api/a2a/v1/message:send`, в тот же роут, что клиент 1.0. До 22.10 здесь
 * стоял `/api/a2a/v1`, и клиент 0.3 получал 404 на `/api/a2a/v1/v1/message:send`.
 */
export const A2A_LEGACY_REST_BASE = '/api/a2a';

export const A2A_AGENT_NAME = 'Vedar Kamchatka';

export const A2A_INPUT_MODES = ['text/plain', 'application/json'] as const;
export const A2A_OUTPUT_MODES = ['text/plain', 'application/json'] as const;

/** Навык свободного разговора — мозг Кузьмича с инструментами. */
export const CHAT_SKILL_ID = 'kuzmich-chat';

// Английский абзац первым (17.10): каталоги и реестры агентов (a2aregistry,
// awesome-a2a) показывают начало описания, а читают его англоязычные агенты.
// Русский текст — следом, без сокращений; китайский хвост — последним.
export const A2A_DESCRIPTION =
  'Vedar Kamchatka is a Kamchatka travel information portal and AI guide (Russia). It is not a travel agency and not a tour operator. '
  + 'Live tours from local operators and their availability, safety alerts and conditions, '
  + 'places, weather, volcano status, stays, gear, transfers, self-drive car rental and trip plans. Free-text questions (Russian or English) '
  + 'or exact tool calls via DataPart {"tool", "arguments"} using the schemas from tools/list at /api/mcp; '
  + 'five human-confirmed requests (create_lead, create_booking_request, create_stay_request, request_charter, create_car_rental_request, '
  + 'consent: true required), no instant booking, no payment through the guide, no auth. '
  + 'Русский: информационный портал «Ведар Камчатка» и ИИ-проводник, не турагентство и не туроператор. '
  + 'Туры местных операторов с живой занятостью, безопасность мест и обстановка в крае, '
  + 'жильё, снаряжение, трансферы, прокат машин без водителя, погода, план поездки. Понимает свободный текст (по-русски или по-английски): '
  + 'отвечает Кузьмич, хранитель Камчатки, с теми же инструментами, что у MCP-сервера. Точный вызов инструмента — '
  + 'DataPart {"tool": "<имя>", "arguments": {...}} по схемам из tools/list на /api/mcp. Записей пять, и все — '
  + 'заявки, которые подтверждает человек: create_lead, create_booking_request, create_stay_request, request_charter, create_car_rental_request '
  + '(нужен consent: true — согласие человека на обработку имени и телефона). Брони и оплаты через агента нет. '
  + 'Анонимно, лимиты по адресу; задача завершается в ответе на SendMessage и хранится час. '
  // Китайский хвост (12.10) — текст в lib/mcp/zh-layer, один на все поверхности.
  + A2A_DESCRIPTION_ZH;

/**
 * Теги навыков по имени инструмента. Инструмент без записи здесь — красный
 * сторож: карточка не вправе «забыть» инструмент, который сервер отдаёт.
 */
export const SKILL_TAGS: Record<string, string[]> = {
  get_tours:              ['kamchatka', 'tours', 'catalogue', 'prices'],
  get_tour_details:       ['kamchatka', 'tours', 'program', 'included'],
  get_tour_availability:  ['kamchatka', 'tours', 'availability', 'dates', 'seats'],
  get_guardian_context:   ['kamchatka', 'safety', 'hazards', 'alerts', 'place'],
  get_place_info:         ['kamchatka', 'places', 'coordinates', 'facts'],
  safety_status:          ['kamchatka', 'safety', 'alerts', 'seismic', 'volcanic', 'weather'],
  get_weather:            ['kamchatka', 'weather', 'forecast'],
  get_volcano_status:     ['kamchatka', 'volcano', 'kvert', 'seismicity'],
  search_accommodations:  ['kamchatka', 'stays', 'accommodation', 'hotels'],
  search_transfers:       ['kamchatka', 'transfers', 'charter', 'vakhtovka'],
  search_car_rental:      ['kamchatka', 'car-rental', 'self-drive', 'suv', 'price-per-day'],
  search_gear:            ['kamchatka', 'gear', 'rental'],
  make_trip_plan:         ['kamchatka', 'trip-plan', 'itinerary', 'weather'],
  edit_trip_plan:         ['kamchatka', 'trip-plan', 'itinerary', 'edit'],
  search:                 ['kamchatka', 'search', 'catalogue', 'places', 'stays', 'routes'],
  fetch:                  ['kamchatka', 'document', 'details', 'citation'],
  create_lead:            ['kamchatka', 'request', 'tour-selection', 'human-confirmed', 'consent'],
  create_booking_request: ['kamchatka', 'request', 'booking', 'human-confirmed', 'consent'],
  create_stay_request:    ['kamchatka', 'request', 'stay', 'human-confirmed', 'consent'],
  request_charter:        ['kamchatka', 'request', 'charter', 'vakhtovka', 'human-confirmed', 'consent'],
  create_car_rental_request: ['kamchatka', 'request', 'car-rental', 'self-drive', 'human-confirmed', 'consent'],
  get_request_status:     ['kamchatka', 'request', 'status', 'operator-answer'],
};

/**
 * Пример аргументов для DataPart — там, где форма однозначна; иначе пусто.
 * Имена — из схемы инструмента: до 13.10 четыре примера называли параметры,
 * которых у инструмента нет (`tour` вместо `name`, `name` вместо `volcano`,
 * `query` вместо `zone`, `destination` вместо `place`). Лишнее поле схема
 * молча отбрасывает, и агент, скопировавший пример, получал ответ не на свой
 * вопрос — а get_tour_details без `name` и вовсе отказ.
 * Значения — того типа, что в схеме (у всех параметров `string`): число сервер
 * примет, но агент, сверяющий пример со схемой tools/list, увидит расхождение
 * (внешняя проверка 22.10: `days: 5` при `"type": "string"`).
 */
const ARG_EXAMPLES: Record<string, Record<string, unknown>> = {
  get_tours: { activity_type: 'вулканы' },
  get_tour_details: { name: 'Курильское озеро' },
  get_tour_availability: { tour: 'Курильское озеро', date_from: '2027-08-01', days: '14', people: '2' },
  get_guardian_context: { place: 'Вулкан Горелый' },
  get_place_info: { name: 'Курильское озеро' },
  get_weather: { place: 'Петропавловск-Камчатский' },
  get_volcano_status: { volcano: 'Шивелуч' },
  search_accommodations: { zone: 'Паратунка' },
  search_transfers: { place: 'Горелый' },
  search_car_rental: { query: 'внедорожник' },
  search_gear: { query: 'палатка' },
  make_trip_plan: { days: '5', interests: 'вулканы, медведи', when: 'август' },
  search: { query: 'Курильское озеро медведи' },
  fetch: { id: 'place:kurilskoe-ozero' },
};

/** Примеры свободного текста — для агентов, которые выбирают навык по словам. */
const TEXT_EXAMPLES: Record<string, string[]> = {
  [CHAT_SKILL_ID]: [
    'Какие туры на Курильское озеро есть в августе и безопасно ли там сейчас?',
    'Which Kamchatka tours have free seats next week? Any volcano alerts?',
    A2A_CHAT_EXAMPLE_ZH,
  ],
  get_tours: ['Покажи туры на вулканы с ценами', 'List Kamchatka bear-watching tours'],
  get_tour_availability: ['Есть ли места на Курильское озеро 12 августа на двоих?'],
  safety_status: ['Какая обстановка на Камчатке сейчас: вулканы, землетрясения, погода?'],
  get_guardian_context: ['Опасно ли идти на Горелый в эти выходные?'],
  search_car_rental: ['Сколько стоит взять внедорожник напрокат на сутки без водителя?', 'Rent a self-drive SUV in Kamchatka: price per day and deposit'],
  make_trip_plan: ['Составь план на 5 дней: вулканы и медведи, август, двое взрослых'],
};

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}

function dataPartExample(tool: string): string {
  return JSON.stringify({ tool, arguments: ARG_EXAMPLES[tool] ?? {} });
}

/** Навыки: разговор первым, затем по одному на каждый публичный инструмент. */
export function buildSkills(): AgentSkill[] {
  const chat: AgentSkill = {
    id: CHAT_SKILL_ID,
    name: 'Кузьмич — ответ на вопрос о Камчатке (free-text Kamchatka assistant)',
    description:
      'Свободный вопрос текстом (TextPart), по-русски или по-английски. Отвечает Кузьмич — хранитель Камчатки — '
      + 'данными из инструментов платформы: туры и занятость, безопасность и обстановка, места, погода, жильё, '
      + 'трансферы, прокат машин без водителя, план поездки. Заявки в этом режиме не оформляются: для них — навыки create_* с DataPart. '
      + 'Free-text question in Russian or English, answered with platform data; requests only via create_* skills.',
    tags: ['kamchatka', 'assistant', 'free-text', 'travel', 'safety'],
    examples: TEXT_EXAMPLES[CHAT_SKILL_ID] ?? [],
    inputModes: ['text/plain'],
    outputModes: ['text/plain'],
  };
  const tools: AgentSkill[] = PUBLIC_MCP_TOOLS.map((t) => {
    const write = WRITE_TOOL_NAMES.has(t.name);
    const title = TOOL_ENGLISH[t.name]?.title ?? t.name;
    return {
      id: t.name,
      name: `${title} (${t.name})`,
      description:
        `${t.description} Вызов: DataPart ${dataPartExample(t.name)} — аргументы по схеме инструмента ${t.name} `
        + `(tools/list на ${A2A_JSONRPC_PATH.replace('/a2a', '/mcp')}). Ответ: Task в состоянии completed с текстом инструмента`
        + (write ? '; отказ по входу (нет согласия, нет мест, лимит) — состояние rejected с объяснением.' : '.'),
      tags: SKILL_TAGS[t.name] ?? ['kamchatka'],
      examples: [dataPartExample(t.name), ...(TEXT_EXAMPLES[t.name] ?? [])],
      inputModes: ['application/json'],
      outputModes: ['text/plain', 'application/json'],
    };
  });
  return [chat, ...tools];
}

/** Имена навыков-инструментов — ровно публичные инструменты MCP. */
export function skillToolNames(): string[] {
  return buildSkills().map((s) => s.id).filter((id) => PUBLIC_MCP_TOOL_NAMES.has(id));
}

function provider(base: string) {
  return { organization: 'Ведар Камчатка (vedarai.ru)', url: base };
}

/** Карточка A2A 1.0 — `/.well-known/agent-card.json`. */
export function buildAgentCard(base: string): Record<string, unknown> {
  return {
    name: A2A_AGENT_NAME,
    description: A2A_DESCRIPTION,
    version: MCP_SERVER_INFO.version,
    provider: provider(base),
    documentationUrl: `${base}/mcp`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: [...A2A_INPUT_MODES],
    defaultOutputModes: [...A2A_OUTPUT_MODES],
    skills: buildSkills(),
    // Первый интерфейс — предпочтительный (раздел 8.3.2 спецификации).
    supportedInterfaces: [
      { url: `${base}${A2A_JSONRPC_PATH}`, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION },
      { url: `${base}${A2A_REST_PATH}`, protocolBinding: 'HTTP+JSON', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    // Анонимный вход: схем нет, требований нет — и это сказано явно.
    securitySchemes: {},
    securityRequirements: [],
  };
}

/** Карточка A2A 0.3 — `/.well-known/agent.json`, для клиентов до 1.0. */
export function buildLegacyAgentCard(base: string): Record<string, unknown> {
  return {
    name: A2A_AGENT_NAME,
    description: A2A_DESCRIPTION,
    url: `${base}${A2A_JSONRPC_PATH}`,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [
      { url: `${base}${A2A_JSONRPC_PATH}`, transport: 'JSONRPC' },
      { url: `${base}${A2A_LEGACY_REST_BASE}`, transport: 'HTTP+JSON' },
    ],
    provider: provider(base),
    version: MCP_SERVER_INFO.version,
    protocolVersion: A2A_LEGACY_PROTOCOL_VERSION,
    documentationUrl: `${base}/mcp`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: [...A2A_INPUT_MODES],
    defaultOutputModes: [...A2A_OUTPUT_MODES],
    skills: buildSkills(),
    securitySchemes: {},
    security: [],
  };
}
