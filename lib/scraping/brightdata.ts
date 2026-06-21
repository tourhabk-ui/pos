/**
 * lib/scraping/brightdata.ts
 *
 * Bright Data Web Unlocker — обходит антибот-защиту и возвращает HTML.
 * Используется для скрейпинга страниц, которые блокируют обычные запросы.
 *
 * Требует переменную BRIGHTDATA_API_TOKEN в окружении.
 * Если токен не задан — возвращает null (graceful fallback).
 */

const BRIGHTDATA_API = 'https://api.brightdata.com/request';

export interface BrightDataOptions {
  zone?: string;
  country?: string;
  timeoutMs?: number;
}

/**
 * Скачивает страницу через Bright Data Web Unlocker.
 * Возвращает HTML-строку или null если токен не задан / ошибка.
 */
export async function fetchViaBrightData(
  url: string,
  options: BrightDataOptions = {},
): Promise<string | null> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return null;

  const {
    zone = 'mcp_unlocker',
    country = 'ru',
    timeoutMs = 30_000,
  } = options;

  try {
    const res = await fetch(BRIGHTDATA_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone, url, country, format: 'raw' }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * Проверяет, настроен ли Bright Data и работает ли токен.
 * Возвращает объект с диагностикой.
 */
export async function diagnoseBrightData(): Promise<{
  token_set: boolean;
  reachable: boolean;
  status?: number;
  error?: string;
}> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  if (!token) return { token_set: false, reachable: false, error: 'BRIGHTDATA_API_TOKEN не задан в переменных окружения' };

  try {
    const res = await fetch(BRIGHTDATA_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone: 'mcp_unlocker', url: 'https://visitkamchatka.ru/', country: 'ru', format: 'raw' }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      return { token_set: true, reachable: true, status: res.status };
    }
    const body = await res.text().catch(() => '');
    return { token_set: true, reachable: false, status: res.status, error: body.slice(0, 200) };
  } catch (e) {
    return { token_set: true, reachable: false, error: (e as Error).message };
  }
}
