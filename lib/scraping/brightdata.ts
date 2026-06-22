/**
 * lib/scraping/brightdata.ts
 *
 * Bright Data Web Unlocker — обходит антибот-защиту и возвращает HTML.
 * Используется для скрейпинга страниц, которые блокируют обычные запросы.
 *
 * Требует переменную BRIGHTDATA_API_TOKEN в окружении.
 * Имя зоны берётся из BRIGHTDATA_ZONE (по умолчанию web_unlocker1).
 * Если токен не задан — возвращает null (graceful fallback).
 */

const BRIGHTDATA_API = 'https://api.brightdata.com/request';
const ZONES_API = 'https://api.brightdata.com/zone/get_active_zones';

/** Имя зоны Web Unlocker. Переопределяется через env. */
function getZone(): string {
  return process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
}

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
    zone = getZone(),
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
 * Получает список активных зон аккаунта Bright Data.
 * Возвращает массив имён зон или null при ошибке.
 */
async function fetchActiveZones(token: string): Promise<string[] | null> {
  try {
    const res = await fetch(ZONES_API, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ name?: string; zone?: string }> | { zones?: Array<{ name?: string }> };
    if (Array.isArray(data)) {
      return data.map(z => z.name ?? z.zone ?? '').filter(Boolean);
    }
    if (data && Array.isArray(data.zones)) {
      return data.zones.map(z => z.name ?? '').filter(Boolean);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Проверяет, настроен ли Bright Data и работает ли токен.
 * При ошибке зоны возвращает список доступных зон аккаунта.
 */
export async function diagnoseBrightData(): Promise<{
  token_set: boolean;
  reachable: boolean;
  zone: string;
  status?: number;
  error?: string;
  available_zones?: string[];
}> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone = getZone();
  if (!token) {
    return { token_set: false, reachable: false, zone, error: 'BRIGHTDATA_API_TOKEN не задан в переменных окружения' };
  }

  try {
    const res = await fetch(BRIGHTDATA_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone, url: 'https://visitkamchatka.ru/', country: 'ru', format: 'raw' }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
      return { token_set: true, reachable: true, zone, status: res.status };
    }

    const body = await res.text().catch(() => '');
    // Зона не найдена — подтянем список реальных зон, чтобы подсказать правильное имя
    const zones = await fetchActiveZones(token);
    return {
      token_set: true,
      reachable: false,
      zone,
      status: res.status,
      error: body.slice(0, 200),
      ...(zones ? { available_zones: zones } : {}),
    };
  } catch (e) {
    return { token_set: true, reachable: false, zone, error: (e as Error).message };
  }
}
