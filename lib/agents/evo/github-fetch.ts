/**
 * fetch к GitHub — прямой или через релей (Cloudflare Worker вне РФ).
 *
 * Зачем: прод эволюции крутится на Timeweb (РФ), а исходников .ts в
 * standalone-бандле нет — перечень и тела файлов скан тянет из GitHub
 * (api.github.com / raw.githubusercontent.com). Из РФ эти хосты могут не
 * достаться, и тогда весь coverage-прочёс молча схлопывается в ноль
 * («прочёс ослеп»). Тот же гео-блок мы уже обходим релеем для флагман-LLM
 * (infra/ai-relay) — переиспользуем его и для чтения репо.
 *
 * Маршрут (если задан GITHUB_PROXY_BASE — база воркера без хвостового /):
 *   https://api.github.com/X            → <base>/gh-api/X
 *   https://raw.githubusercontent.com/X → <base>/gh-raw/X
 * Без env — прямой запрос (dev/CI/локально): прежнее поведение, ноль риска.
 *
 * Опционально GITHUB_API_TOKEN поднимает лимит api.github.com с 60 до 5000/час
 * (за прогон скан делает до ~25 GitHub-запросов — без токена это <3 прогонов/ч).
 * Токен уходит с сервера через релей наружу — из РФ ничего не светится.
 */

// [хост апстрима, сегмент пути воркера]
const RELAY_MAP: ReadonlyArray<readonly [string, string]> = [
  ['https://api.github.com', 'gh-api'],
  ['https://raw.githubusercontent.com', 'gh-raw'],
];

const GITHUB_API_HOST = 'https://api.github.com';

function relayBase(): string | null {
  const b = process.env.GITHUB_PROXY_BASE?.trim().replace(/\/+$/, '');
  return b || null;
}

/** Переписывает GitHub-URL на релей, если он настроен. Иначе — как есть. */
export function githubUrl(rawUrl: string): string {
  const base = relayBase();
  if (!base) return rawUrl;
  for (const [host, seg] of RELAY_MAP) {
    if (rawUrl.startsWith(host)) return `${base}/${seg}${rawUrl.slice(host.length)}`;
  }
  return rawUrl;
}

/**
 * fetch к GitHub с прозрачной подстановкой релея и (опц.) токена/секрета.
 * Секрет X-Relay-Secret добавляется ТОЛЬКО когда реально идём через релей —
 * чтобы не слать его на прямой github при выключенном прокси.
 */
export function githubFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const base = relayBase();
  const url = githubUrl(rawUrl);
  const viaRelay = !!base && url.startsWith(base);

  const headers = new Headers(init.headers);

  // Токен — только для api.github.com (по исходному хосту, не по переписанному).
  const token = process.env.GITHUB_API_TOKEN?.trim();
  if (token && rawUrl.startsWith(GITHUB_API_HOST) && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (viaRelay) {
    const secret = process.env.RELAY_SECRET?.trim();
    if (secret) headers.set('X-Relay-Secret', secret);
  }

  return fetch(url, { ...init, headers });
}
