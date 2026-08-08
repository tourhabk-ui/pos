/**
 * Серверное чтение статистики Яндекс.Метрики (Reporting API).
 *
 * Счётчик давно стоит на каждой странице (components/shared/YandexMetrika.tsx,
 * id 103522218) и копит визиты — но цифры никто не читал: маяк воронки видит
 * только свои события, а «есть ли трафик вообще» знала одна Метрика.
 *
 * Токен — OAuth с правом чтения Метрики (oauth.yandex.ru), env
 * YANDEX_METRIKA_TOKEN. Id счётчика — YANDEX_METRIKA_ID, дефолт тот же, что
 * в компоненте счётчика. Без токена честно возвращаем token_set:false —
 * потребители (scanFunnel, health) живут без Метрики, не падая.
 */

const METRIKA_API = 'https://api-metrika.yandex.net/stat/v1/data';
// Тот же дефолт, что в YandexMetrika.tsx: id счётчика — не секрет,
// он публично виден в HTML каждой страницы.
const DEFAULT_COUNTER = '103522218';

export interface MetrikaDiag {
  token_set: boolean;
  counter: string;
  ok: boolean;
  http_status?: number;
  error?: string;
  /** Визиты за последние 7 суток (только при ok). */
  visits?: number;
  /** Посетители за последние 7 суток (только при ok). */
  users?: number;
}

/** Визиты/посетители за 7 суток. Никогда не бросает — диагноз в полях. */
export async function fetchMetrikaWeek(): Promise<MetrikaDiag> {
  const token = process.env.YANDEX_METRIKA_TOKEN?.trim();
  const counter = (process.env.YANDEX_METRIKA_ID || DEFAULT_COUNTER).trim();
  if (!token) return { token_set: false, counter, ok: false };

  try {
    const url = `${METRIKA_API}?ids=${counter}&metrics=ym:s:visits,ym:s:users&date1=7daysAgo&date2=today`;
    const res = await fetch(url, {
      headers: { Authorization: `OAuth ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      return { token_set: true, counter, ok: false, http_status: res.status, error: body };
    }
    const data = await res.json() as { totals?: unknown };
    // Без измерений totals — number[]; с измерениями — number[][]. Терпим оба.
    const totals = Array.isArray(data.totals)
      ? (Array.isArray(data.totals[0]) ? (data.totals as number[][])[0] : data.totals as number[])
      : [];
    return {
      token_set: true,
      counter,
      ok: true,
      visits: Math.round(Number(totals?.[0] ?? 0)),
      users: Math.round(Number(totals?.[1] ?? 0)),
    };
  } catch (e) {
    return { token_set: true, counter, ok: false, error: ((e as Error).message || 'unknown').slice(0, 160) };
  }
}
