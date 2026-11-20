/**
 * Куда ходит Gemini: к Google напрямую или через шлюз Cloudflare AI Gateway.
 *
 * Зачем (20.11, владелец обновил GEMINI_API_KEY в Timeweb). С прода Google
 * отвечает 400 «User location is not supported» (ai-debug 04.09, 05.11,
 * 06.11): сервер стоит в РФ, отказ по адресу запроса, ключ и модель тут не
 * помогают. Шлюз Cloudflare `vedar-ai` с прода уже довёл запрос до Anthropic
 * (anthropic-path-probe, прогон 8). Доходит ли он до Google, меряет
 * `/api/cron/gemini-path-probe`. Пока GEMINI_BASE_URL не задан, всё идёт
 * напрямую, как и раньше.
 *
 * Ключ уходит туда, куда указывает адрес, поэтому адрес — не любая строка:
 * только Google или шлюз Cloudflare по точному шаблону. Иное не принимается;
 * причина пишется в лог без самого значения, а запрос идёт к Google.
 *
 * Ключ передаётся заголовком `x-goog-api-key`, а не `?key=` в адресе: адрес
 * попадает в журнал шлюза и в тексты ошибок, заголовок — нет. Через шлюз
 * добавляется `cf-aig-collect-log-payload: false`: шлюз хранит только
 * метаданные (модель, токены, код ответа), а тексты, снимки и голос туристов
 * не хранит (документация Cloudflare AI Gateway, раздел о журнале).
 */

export const GEMINI_DIRECT_BASE = 'https://generativelanguage.googleapis.com';

const GATEWAY_HOST = 'https://gateway.ai.cloudflare.com';

/** Шлюз Cloudflare к Google AI Studio: аккаунт — 32 hex, имя шлюза — строчные буквы, цифры, дефис. */
const GATEWAY_BASE_RE = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]{32}\/[a-z0-9][a-z0-9-]{0,63}\/google-ai-studio$/;

export type GeminiVia = 'direct' | 'gateway';

export interface GeminiEndpoint {
  /** Адрес без завершающей косой черты; к нему добавляется `/v1beta/…`. */
  base: string;
  via: GeminiVia;
  /** Почему GEMINI_BASE_URL не принят; `null` — принят или не задан. */
  rejected: string | null;
}

export const GEMINI_BASE_REJECTED =
  'GEMINI_BASE_URL не принят: нужен адрес Google или шлюза Cloudflare вида '
  + 'https://gateway.ai.cloudflare.com/v1/<аккаунт>/<шлюз>/google-ai-studio';

export function geminiEndpoint(raw: string | undefined = process.env.GEMINI_BASE_URL): GeminiEndpoint {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '' || value === GEMINI_DIRECT_BASE) {
    return { base: GEMINI_DIRECT_BASE, via: 'direct', rejected: null };
  }
  if (GATEWAY_BASE_RE.test(value)) return { base: value, via: 'gateway', rejected: null };
  return { base: GEMINI_DIRECT_BASE, via: 'direct', rejected: GEMINI_BASE_REJECTED };
}

let rejectionLogged = false;

/** Адрес метода Gemini API: `models` или `models/<id>:generateContent`. */
export function geminiUrl(method: string, endpoint: GeminiEndpoint = geminiEndpoint()): string {
  if (endpoint.rejected && !rejectionLogged) {
    rejectionLogged = true;
    console.error(`[gemini] ${endpoint.rejected}; запросы идут к Google напрямую`);
  }
  return `${endpoint.base}/v1beta/${method}`;
}

/** Заголовки запроса к Gemini: ключ — заголовком, через шлюз — без хранения тел. */
export function geminiHeaders(
  apiKey: string,
  endpoint: GeminiEndpoint = geminiEndpoint(),
  json = true,
): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'x-goog-api-key': apiKey,
    ...(endpoint.via === 'gateway' ? { 'cf-aig-collect-log-payload': 'false' } : {}),
  };
}

/**
 * Модели с `generateContent` из ответа `GET models`, без префикса `models/`.
 * Один разбор на живой код и пробу пути: список, который проба видит, — тот
 * же, из которого живой код выбирает модель.
 */
export function geminiModelIds(data: unknown): string[] {
  const models = typeof data === 'object' && data !== null ? (data as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  return models
    .filter((entry): entry is { name?: unknown; supportedGenerationMethods?: unknown } =>
      typeof entry === 'object' && entry !== null)
    .filter((entry) => Array.isArray(entry.supportedGenerationMethods)
      && (entry.supportedGenerationMethods as unknown[]).includes('generateContent'))
    .map((entry) => (typeof entry.name === 'string' ? entry.name.replace(/^models\//, '') : ''))
    .filter((id) => id.length > 0);
}

/** Шлюзы, которые проба знает по имени. Значение — литерал, не ввод. */
const GATEWAYS: Readonly<Record<string, string>> = {
  'vedar-ai': 'vedar-ai',
};

/**
 * Адрес шлюза к Google для пробы — из проверенных частей, а не из строки
 * запроса: id аккаунта пересобирается через число, имя шлюза берётся из
 * таблицы. `null` — части не прошли проверку.
 */
export function geminiGatewayBase(accountRaw: string | null, gatewayRaw: string | null): string | null {
  if (!accountRaw || !gatewayRaw) return null;
  if (!/^[0-9a-f]{32}$/.test(accountRaw)) return null;
  const account = BigInt(`0x${accountRaw}`).toString(16).padStart(32, '0');
  const gateway = Object.prototype.hasOwnProperty.call(GATEWAYS, gatewayRaw) ? GATEWAYS[gatewayRaw] : null;
  if (!gateway) return null;
  return new URL(`/v1/${account}/${gateway}/google-ai-studio`, GATEWAY_HOST).toString().replace(/\/+$/, '');
}
