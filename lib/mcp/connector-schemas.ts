/**
 * Схемы пары `search` / `fetch` для коннекторов ChatGPT — без базы.
 *
 * Отдельный модуль намеренно: реестр публичных инструментов
 * (lib/mcp/public-tools) читают страницы, которые Next собирает на сборке
 * (/mcp), а сборка на Timeweb идёт без DATABASE_URL — модуль с пулом в цепочке
 * импортов такой страницы запечёт отказ базы в страницу (сторож
 * no-build-time-db). Исполнение с SQL живёт в lib/mcp/connector-tools и
 * импортирует имена и схемы отсюда.
 *
 * Форма — по документации OpenAI (developers.openai.com/docs/mcp):
 *   search(query)  → { results: [{ id, title, url }] }
 *   fetch(id)      → { id, title, text, url, metadata? }
 * Описания параметров здесь русские, как у Кузьмича; английская фраза впереди
 * накладывается реестром (PARAM_ENGLISH в public-tools), и сторож
 * mcp-tool-descriptions-en держит обе половины.
 */

export const SEARCH_TOOL_NAME = 'search';
export const FETCH_TOOL_NAME = 'fetch';
export const CONNECTOR_TOOL_NAMES: ReadonlySet<string> = new Set([SEARCH_TOOL_NAME, FETCH_TOOL_NAME]);

export const SEARCH_RESULTS_MAX = 10;
export const QUERY_MIN_CHARS = 2;
export const QUERY_MAX_CHARS = 200;
/** Потолок текста документа в fetch — ChatGPT режет длинные, а турист читает карточку. */
export const FETCH_TEXT_MAX = 12_000;

const RESULT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Идентификатор документа для fetch: tour:<id>, place:<slug>, stay:<uuid>, route:<slug>' },
    title: { type: 'string', description: 'Название для человека' },
    url: { type: 'string', description: 'Каноническая страница на vedarai.ru — для цитаты' },
  },
  required: ['id', 'title', 'url'],
} as const;

export const SEARCH_TOOL = {
  name: SEARCH_TOOL_NAME,
  description:
    'Поиск по витрине Ведара для коннекторов ChatGPT: туры операторов Камчатки, места, жильё и маршруты '
    + `по словам запроса (русский или английский). Отдаёт до ${SEARCH_RESULTS_MAX} результатов с id для fetch, названием и `
    + 'адресом страницы. Для живой занятости тура и обстановки есть get_tour_availability и safety_status.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: `Слова запроса, от ${QUERY_MIN_CHARS} до ${QUERY_MAX_CHARS} символов, по-русски или по-английски.` },
    },
    required: ['query'],
  },
  outputSchema: {
    type: 'object',
    properties: { results: { type: 'array', items: RESULT_ITEM_SCHEMA } },
    required: ['results'],
  },
} as const;

export const FETCH_TOOL = {
  name: FETCH_TOOL_NAME,
  description:
    'Полный текст одной записи витрины Ведара по id из search (tour:<id>, place:<slug>, stay:<uuid>, '
    + 'route:<slug>): описание, цена и состав тура, факты о месте и его опасностях, жильё, маршрут. '
    + 'Только опубликованное; записи, которой нет на витрине, — отказ с объяснением.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Идентификатор записи из search: tour:<id>, place:<slug>, stay:<uuid> или route:<slug>.' },
    },
    required: ['id'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      text: { type: 'string', description: 'Полный текст записи' },
      url: { type: 'string', description: 'Каноническая страница на vedarai.ru' },
      metadata: { type: 'object', description: 'Род записи и факты: kind, price, duration, season…' },
    },
    required: ['id', 'title', 'text', 'url'],
  },
} as const;
