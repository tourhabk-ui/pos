/**
 * Bright Data Web Unlocker — резервный fetch для источников, которые режут наш
 * IP, отдают CAPTCHA/фингерпринт-заглушку или geo-блок.
 *
 * ФОЛБЭК, не основной путь. Прод (российский IP Timeweb) тянет KVERT/МЧС и
 * прочие safety-источники напрямую и бесплатно — Unlocker включается ТОЛЬКО
 * когда прямой fetch не дал результата, чтобы не жечь платные кредиты на
 * запросах, которые и так проходят.
 *
 * Ключ — BRIGHTDATA_API_KEY в env Timeweb, НИКОГДА в коде (§4). Нет ключа →
 * функции возвращают null/false, вызывающий остаётся на прямом fetch
 * (поведение байт-в-байт прежнее). Zone по умолчанию web_unlocker2 —
 * переопределяется BRIGHTDATA_ZONE.
 *
 * Через Unlocker шлём ТОЛЬКО публичный URL целевой страницы — никаких ПД, так
 * что D2/152-ФЗ тут ни при чём (это прокси к открытым safety-страницам, не LLM).
 */

const BRIGHTDATA_ENDPOINT = 'https://api.brightdata.com/request';

// Два способа доступа к Bright Data — оба поддержаны:
//   A) API (Bearer): BRIGHTDATA_API_KEY — POST api.brightdata.com/request.
//   B) Native-прокси: BRIGHTDATA_PROXY_USER/PASS — запрос через
//      brd.superproxy.io. Заведён 02.08, потому что Bearer-токен в UI
//      Bright Data закопан (владелец не мог найти), а прокси-логин/пароль
//      видны прямо на странице зоны. Гео РФ — суффикс -country-ru у логина.
function proxyConfigured(): boolean {
  return !!(process.env.BRIGHTDATA_PROXY_USER && process.env.BRIGHTDATA_PROXY_PASS);
}

export function brightDataAvailable(): boolean {
  return !!process.env.BRIGHTDATA_API_KEY || proxyConfigured();
}

/** Логин прокси с гео-суффиксом (Bright Data задаёт страну через username). */
function proxyUser(country?: string): string {
  let user = process.env.BRIGHTDATA_PROXY_USER || '';
  if (country && !/-country-/.test(user)) user += `-country-${country}`;
  return user;
}

/** Native-прокси метод (Вариант B). Тянет URL через brd.superproxy.io. */
async function fetchViaProxy(url: string, opts: { timeoutMs?: number; country?: string }): Promise<string | null> {
  const pass = process.env.BRIGHTDATA_PROXY_PASS;
  if (!pass) return null;
  const host = process.env.BRIGHTDATA_PROXY_HOST || 'brd.superproxy.io';
  const port = process.env.BRIGHTDATA_PROXY_PORT || '33335';
  try {
    // Динамический импорт: undici нужен только на этом пути, не тянем его в
    // бандл там, где прокси не используется.
    const { ProxyAgent } = await import('undici');
    const token = `Basic ${Buffer.from(`${proxyUser(opts.country)}:${pass}`).toString('base64')}`;
    const agent = new ProxyAgent({ uri: `http://${host}:${port}`, token });
    const res = await fetch(url, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      // dispatcher — расширение undici поверх стандартного RequestInit.
      dispatcher: agent,
    } as RequestInit & { dispatcher: unknown });
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Тянет страницу через Web Unlocker. Возвращает сырой текст ответа или null
 * (нет ключа / не-200 / пустой ответ / сбой). country — гео прокси-выхода
 * (для KVERT/МЧС — 'ru', иначе российские источники сами дадут 403).
 */
export async function brightDataFetch(
  url: string,
  opts: { timeoutMs?: number; country?: string } = {},
): Promise<string | null> {
  const key = process.env.BRIGHTDATA_API_KEY;
  // Bearer (A) приоритетно, если задан. Иначе Native-прокси (B). Иначе — null.
  if (!key) return proxyConfigured() ? fetchViaProxy(url, opts) : null;
  try {
    const res = await fetch(BRIGHTDATA_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        zone: process.env.BRIGHTDATA_ZONE || 'web_unlocker2',
        url,
        format: 'raw',
        ...(opts.country ? { country: opts.country } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}
