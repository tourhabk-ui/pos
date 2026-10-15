/**
 * Температура «сейчас» из ответа GET /api/weather — один разбор на все значки.
 *
 * Две копии значка (карточка места и карта) читали `temperature` с верхнего
 * уровня, а роут отдаёт `{ success, data }` (контракт — lib/api/openapi.ts).
 * Значок не появлялся НИКОГДА, и никто этого не видел: молчащий значок
 * неотличим от «погоды нет» (15.10). `iconUrl` не производит никто — его
 * здесь нет.
 */
export interface WeatherNow {
  temp: number;
  /** Когда снят ответ провайдера; null — не сказано. */
  at: string | null;
}

export function parseWeatherNow(body: unknown): WeatherNow | null {
  if (typeof body !== 'object' || body === null) return null;
  const rec = body as { success?: unknown; data?: unknown };
  if (rec.success !== true || typeof rec.data !== 'object' || rec.data === null) return null;
  const data = rec.data as { temperature?: unknown; lastUpdated?: unknown };
  if (typeof data.temperature !== 'number' || !Number.isFinite(data.temperature)) return null;
  return {
    temp: Math.round(data.temperature),
    at: typeof data.lastUpdated === 'string' ? data.lastUpdated : null,
  };
}
