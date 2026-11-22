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

import { pickBestModel } from '@/lib/ai/model-resolver';

export const GEMINI_DIRECT_BASE = 'https://generativelanguage.googleapis.com';

const GATEWAY_HOST = 'https://gateway.ai.cloudflare.com';

/** Шлюз Cloudflare к Google AI Studio: аккаунт — 32 hex, имя шлюза — строчные буквы, цифры, дефис. */
const GATEWAY_BASE_RE = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([0-9a-f]{32})\/([a-z0-9][a-z0-9-]{0,63})\/google-ai-studio$/;

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

/**
 * Имя модели Gemini, которое Google может в любой день перевести на другую
 * модель или выпустить с меньшими лимитами: скользящий алиас (`-latest`),
 * предварительная (`preview`) и опытная (`exp`) версия.
 */
export const UNSTABLE_GEMINI_ID = /(^|[-_])(latest|preview|exp|experimental)([-_]|$)/i;

/**
 * Модель Gemini из списка: сильнейшая закреплённая flash-модель
 * (`pickBestModel`). Скользящий алиас и предварительные версии берутся, только
 * когда закреплённой нет. Без flash — по тому же правилу из всех. Одно правило
 * на живой код (`resolveGeminiModel`) и пробу пути.
 *
 * Почему закреплённая. Через шлюз `gemini-flash-latest` не ответил ни в одном
 * из пяти замеров 20–21.11: дважды не уложился в срок (20 с и 40 с), трижды
 * Google ответил 503 «перегружена». Закреплённая `gemini-3.8-flash` в замере 6
 * ответила за 3,4 с. Общий `pickBestModel` даёт алиасу надбавку (у DeepSeek и
 * Qwen алиас — самая надёжная модель), у Gemini надбавка выбирала ту модель,
 * которая не отвечает.
 *
 * Раньше (20.11) проба брала первую flash-модель списка — gemini-2.5-flash,
 * которую Google новым ключам уже не отдаёт (404), и проверила не ту модель,
 * которой ходит живой код.
 */
export function pickGeminiModel(ids: readonly string[]): string | null {
  const flash = ids.filter((id) => /flash/i.test(id));
  const pool = flash.length > 0 ? flash : ids;
  const stable = pool.filter((id) => !UNSTABLE_GEMINI_ID.test(id));
  return pickBestModel(stable) ?? pickBestModel(pool);
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

export type GatewayPart = 'same' | 'differs';

/**
 * Чем адрес шлюза из настройки отличается от адреса шлюза пробы: аккаунт и
 * имя шлюза — словом «тот же / другой», без самих значений. Замер 6 (21.11):
 * адрес из GEMINI_BASE_URL получил 401, а шлюз `vedar-ai` того аккаунта,
 * что знает проба, открыт. Чтобы владелец поправил адрес, ему надо знать,
 * какая часть другая; id аккаунта при этом в ответ не идёт. `null` — один из
 * адресов не шлюз.
 */
export function gatewayBaseDiff(
  base: string,
  probeBase: string | null,
): { account: GatewayPart; gateway: GatewayPart } | null {
  const parts = (value: string | null) => {
    const m = value ? GATEWAY_BASE_RE.exec(value) : null;
    return m ? { account: m[1], gateway: m[2] } : null;
  };
  const a = parts(base);
  const b = parts(probeBase);
  if (!a || !b) return null;
  return {
    account: a.account === b.account ? 'same' : 'differs',
    gateway: a.gateway === b.gateway ? 'same' : 'differs',
  };
}
