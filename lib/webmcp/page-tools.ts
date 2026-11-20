/**
 * WebMCP — инструменты Ведара прямо на странице (слово владельца 20.11
 * «Сделай WebMCP»).
 *
 * Агент, встроенный в Chrome, читает инструменты страницы через
 * `document.modelContext` (черновик спецификации W3C CG от 13.11.2026,
 * webmachinelearning.github.io/webmcp; пробный запуск Chrome 149–156). Наш
 * MCP-сервер ему для этого не нужен.
 *
 * Своих правил здесь нет: инструмент страницы — обёртка над публичным
 * `/api/mcp` того же сайта. Описание и схему берёт из `tools/list`, ответ —
 * из `tools/call`. Поэтому слова, порядок туров (правило 1в), лимиты и
 * журнал те же, что у внешнего агента, и разойтись им не с чем.
 *
 * Отдаются только инструменты чтения (`WEBMCP_TOOL_NAMES`). Заявки сюда не
 * входят: заявку человек оставляет формой на странице, с согласием на ПД, и
 * отправляет сам (атрибуты формы — lib/webmcp/form-attrs).
 *
 * Нет API — нет ничего: ни запроса к серверу, ни ошибки. Обычный посетитель
 * за эту возможность не платит ни байтом сети.
 */

/**
 * Инструменты чтения, которые страница отдаёт агенту в браузере. Каждый
 * обязан быть в публичном MCP и помечен там «только чтение»; заявки и
 * инструменты с ключом заявки сюда не попадают — держит
 * tests/unit/webmcp-page-tools.test.ts.
 */
export const WEBMCP_TOOL_NAMES = [
  'get_tours',
  'get_tour_details',
  'get_tour_availability',
  'get_weather',
  'get_volcano_status',
  'safety_status',
] as const;

export type WebMcpToolName = (typeof WEBMCP_TOOL_NAMES)[number];

const ALLOWED: ReadonlySet<string> = new Set(WEBMCP_TOOL_NAMES);

/** Адрес MCP того же сайта: на чужой домен инструмент страницы не ходит. */
export const WEBMCP_MCP_PATH = '/api/mcp';

/** Описание инструмента в том виде, в каком его отдаёт `tools/list`. */
export interface McpListedTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/** Что страница передаёт в `registerTool` (черновик спецификации). */
export interface WebMcpToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: true };
  execute: (input: unknown) => Promise<string>;
}

export interface ModelContextLike {
  registerTool: (tool: WebMcpToolDescriptor, options?: { signal?: AbortSignal }) => unknown;
  addEventListener?: (type: string, listener: (event: Event) => void) => void;
  removeEventListener?: (type: string, listener: (event: Event) => void) => void;
}

function isModelContext(v: unknown): v is ModelContextLike {
  return typeof v === 'object' && v !== null && typeof (v as { registerTool?: unknown }).registerTool === 'function';
}

/**
 * Точка входа API. Нынешняя — `document.modelContext`; прежняя
 * `navigator.modelContext` в пробном запуске ещё живёт (в Chrome 150
 * объявлена устаревшей), поэтому она — запасной путь. Нет ни той ни другой
 * или там не то — null, и страница ничего не делает.
 */
export function getModelContext(
  doc: unknown = typeof document === 'undefined' ? undefined : document,
  nav: unknown = typeof navigator === 'undefined' ? undefined : navigator,
): ModelContextLike | null {
  const fromDoc = (doc as { modelContext?: unknown } | undefined)?.modelContext;
  if (isModelContext(fromDoc)) return fromDoc;
  const fromNav = (nav as { modelContext?: unknown } | undefined)?.modelContext;
  if (isModelContext(fromNav)) return fromNav;
  return null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

let rpcId = 0;

/** Один вызов JSON-RPC к `/api/mcp` того же сайта. */
async function rpc(fetchFn: FetchLike, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  rpcId += 1;
  const res = await fetchFn(WEBMCP_MCP_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
    credentials: 'omit',
    signal,
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Ведар не ответил на ${method}: HTTP ${res.status}`);
  }
  const err = (body as { error?: { message?: unknown } }).error;
  if (err) {
    throw new Error(typeof err.message === 'string' ? err.message : `Ведар отклонил ${method}`);
  }
  if (!res.ok) throw new Error(`Ведар не ответил на ${method}: HTTP ${res.status}`);
  return (body as { result?: unknown }).result;
}

/**
 * Ответ `tools/call` → строка для агента. Текст инструмента отдаётся как
 * есть, включая отказы (`isError`): в них сказано, что не так и что делать.
 * Пустой ответ — не «ничего не найдено», а сбой, и агент получает ошибку.
 */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  const parts = Array.isArray(content)
    ? content
      .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? (c as { text?: unknown }).text : null))
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  if (parts.length === 0) throw new Error('Ведар вернул пустой ответ инструмента');
  return parts.join('\n\n');
}

/** Вызов инструмента MCP того же сайта — исполнение инструмента страницы. */
export async function callVedarTool(fetchFn: FetchLike, name: WebMcpToolName, input: unknown, signal?: AbortSignal): Promise<string> {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return toolResultText(await rpc(fetchFn, 'tools/call', { name, arguments: args }, signal));
}

function isListedTool(v: unknown): v is McpListedTool {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.name === 'string' && typeof t.description === 'string' && typeof t.inputSchema === 'object' && t.inputSchema !== null;
}

/**
 * Описание из `tools/list` → инструмент страницы. Только разрешённые имена и
 * только помеченные сервером «только чтение»: если сервер однажды снимет
 * пометку, страница инструмент не отдаст, а не продолжит считать его чтением.
 */
export function toPageTool(tool: McpListedTool, fetchFn: FetchLike): WebMcpToolDescriptor | null {
  if (!ALLOWED.has(tool.name)) return null;
  if (tool.annotations?.readOnlyHint !== true) return null;
  const name = tool.name as WebMcpToolName;
  return {
    name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: tool.inputSchema as object,
    annotations: { readOnlyHint: true },
    execute: (input: unknown) => callVedarTool(fetchFn, name, input),
  };
}

export type RegisterOutcome =
  | { kind: 'no_api' }
  | { kind: 'registered'; names: string[] }
  | { kind: 'aborted' }
  | { kind: 'failed'; reason: string };

/**
 * Регистрирует инструменты Ведара в браузере. Снятие — через `signal`
 * (в спецификации нет `unregisterTool`: инструмент снимается отменой).
 *
 * «Не смог» не выдаётся за «нечего регистрировать» (§4.0): нет API;
 * зарегистрировано; страницу покинули раньше; список не прочитался или
 * браузер отказал.
 */
export async function registerVedarPageTools(opts: {
  ctx: ModelContextLike | null;
  fetchFn: FetchLike;
  signal: AbortSignal;
}): Promise<RegisterOutcome> {
  const { ctx, fetchFn, signal } = opts;
  if (!ctx) return { kind: 'no_api' };
  try {
    const listed = await rpc(fetchFn, 'tools/list', {}, signal);
    const tools = (listed as { tools?: unknown } | null)?.tools;
    if (!Array.isArray(tools)) return { kind: 'failed', reason: 'tools/list без списка инструментов' };
    const page = tools.filter(isListedTool).map((t) => toPageTool(t, fetchFn)).filter((t): t is WebMcpToolDescriptor => t !== null);
    if (page.length === 0) return { kind: 'failed', reason: 'в tools/list нет ни одного разрешённого инструмента чтения' };
    const names: string[] = [];
    for (const tool of page) {
      if (signal.aborted) return { kind: 'aborted' };
      await ctx.registerTool(tool, { signal });
      names.push(tool.name);
    }
    return { kind: 'registered', names };
  } catch (err) {
    if (signal.aborted) return { kind: 'aborted' };
    return { kind: 'failed', reason: err instanceof Error ? err.message.slice(0, 200) : 'неизвестная ошибка' };
  }
}
