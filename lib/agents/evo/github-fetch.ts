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
 *
 * Хост сверяется ТОЧНО через URL.host (не подстрокой) — иначе
 * `api.github.com.evil.com` прошёл бы как github (CodeQL: incomplete URL
 * substring sanitization).
 */

// хост GitHub → сегмент пути воркера
const RELAY_MAP: ReadonlyArray<readonly [string, string]> = [
  ['api.github.com', 'gh-api'],
  ['raw.githubusercontent.com', 'gh-raw'],
];

const GITHUB_API_HOST = 'api.github.com';

function relayBase(): string | null {
  const b = process.env.GITHUB_PROXY_BASE?.trim().replace(/\/+$/, '');
  return b || null;
}

interface Resolved {
  /** URL для fetch (переписан на релей или исходный). */
  url: string;
  /** Идём ли реально через релей (для добавления X-Relay-Secret). */
  viaRelay: boolean;
  /** Это точно api.github.com (для добавления токена). */
  isApi: boolean;
}

/** Разбирает GitHub-URL: точное совпадение хоста, переписывание на релей. */
function resolve(rawUrl: string): Resolved {
  let u: URL | null = null;
  try {
    u = new URL(rawUrl);
  } catch {
    u = null;
  }
  const host = u && u.protocol === 'https:' ? u.host : null;
  const isApi = host === GITHUB_API_HOST;

  const base = relayBase();
  if (base && u && host) {
    for (const [gh, seg] of RELAY_MAP) {
      if (host === gh) {
        return { url: `${base}/${seg}${u.pathname}${u.search}`, viaRelay: true, isApi };
      }
    }
  }
  return { url: rawUrl, viaRelay: false, isApi };
}

/** Переписывает GitHub-URL на релей, если он настроен. Иначе — как есть. */
export function githubUrl(rawUrl: string): string {
  return resolve(rawUrl).url;
}

/**
 * fetch к GitHub с прозрачной подстановкой релея и (опц.) токена/секрета.
 * Секрет X-Relay-Secret добавляется ТОЛЬКО когда реально идём через релей —
 * чтобы не слать его на прямой github при выключенном прокси.
 */
export function githubFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const { url, viaRelay, isApi } = resolve(rawUrl);
  const headers = new Headers(init.headers);

  // Токен — только для точного api.github.com.
  const token = process.env.GITHUB_API_TOKEN?.trim();
  if (token && isApi && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  if (viaRelay) {
    const secret = process.env.RELAY_SECRET?.trim();
    if (secret) headers.set('X-Relay-Secret', secret);
  }

  return fetch(url, { ...init, headers });
}
