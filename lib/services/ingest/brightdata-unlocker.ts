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

export function brightDataAvailable(): boolean {
  return !!process.env.BRIGHTDATA_API_KEY;
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
  if (!key) return null;
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
