/**
 * IndexNow — мгновенное уведомление поисковиков об изменённых страницах.
 *
 * Владелец 06.08: «делай». Для рунка главный поисковик — Яндекс, и он один из
 * авторов протокола: пинг доводит новую или изменённую страницу до переобхода
 * за минуты вместо дней. У нас 779 страниц мест, 294 маршрута и появляющиеся
 * туры — ждать планового переобхода значит терять недели видимости.
 *
 * Ключ — НЕ секрет по замыслу протокола: он публикуется на самом сайте
 * (`/<ключ>.txt`, и по-прежнему `/indexnow.txt`), и его единственная роль —
 * подтвердить владение хостом. Поэтому он в коде, а не в env: ноль трения
 * при деплое, сторож проверяет согласованность ключа и роута.
 *
 * Приёмники два: `api.indexnow.org` (его забирает Bing) и `yandex.com/indexnow`.
 * Пачка — до 10 000 адресов, как в протоколе; длинный список режется, а не
 * обрезается.
 *
 * Отказы не роняют вызывающего (пинг — попутный эффект сохранения), но и не
 * молчат: ложатся в ai_actions_log — урок MAX-зеркала, чей fire-and-forget
 * годами прятал причину.
 */

import { query } from '@/lib/database';
import { tourPath } from '@/lib/tours/tour-url';

export const INDEXNOW_KEY = 'ed64b13e2286450aa82e6dfef6659834';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';

/** До 10 000 адресов за один POST — предел протокола, не запас меньше него. */
export const INDEXNOW_BATCH = 10_000;

export const INDEXNOW_ENDPOINTS = [
  { name: 'indexnow' as const, url: 'https://api.indexnow.org/indexnow' },
  { name: 'yandex' as const, url: 'https://yandex.com/indexnow' },
];

/** Файл ключа по спецификации: https://<host>/<key>.txt */
export function indexNowKeyLocation(site = SITE_URL): string {
  return `${site.replace(/\/$/, '')}/${INDEXNOW_KEY}.txt`;
}

export function indexNowBatches(urls: string[], size = INDEXNOW_BATCH): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < urls.length; i += size) out.push(urls.slice(i, i + size));
  return out;
}

/**
 * Сколько адресов пинга ложится в журнал поимённо (аудит 15.10, CN-quick).
 * До этого в ai_actions_log писалось только число, и на вопрос «пинговался
 * ли /zh» журнал ответить не мог. Узкие пинги (тур, место, планы, /zh)
 * помещаются целиком; у bulk-подачи — голова списка и число остальных.
 */
export const LOGGED_URLS_MAX = 20;

export interface IndexNowOptions {
  /** Кто пингует — пишется в журнал рядом с адресами (например, 'indexnow-plans'). */
  source?: string;
}

export interface IndexNowEndpointResult {
  name: 'indexnow' | 'yandex';
  ok: boolean;
  /** null — сеть не ответила. */
  status: number | null;
  error?: string;
}

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  /** Статус Яндекса, если он ответил: старые читатели журнала смотрят сюда. */
  status?: number;
  error?: string;
  endpoints?: IndexNowEndpointResult[];
}

/**
 * Пингует IndexNow списком изменённых страниц. Принимает абсолютные URL или
 * пути от корня. Пустой список — не ошибка, просто нечего сообщать.
 */
async function postBatch(
  endpoint: (typeof INDEXNOW_ENDPOINTS)[number],
  body: string,
): Promise<IndexNowEndpointResult> {
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body,
    });
    if (res.status === 200 || res.status === 202) {
      return { name: endpoint.name, ok: true, status: res.status };
    }
    const raw = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    return {
      name: endpoint.name,
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${raw || 'пустой ответ'}`,
    };
  } catch (e) {
    return {
      name: endpoint.name,
      ok: false,
      status: null,
      error: e instanceof Error ? e.message : 'сетевой сбой',
    };
  }
}

export async function pingIndexNow(urls: string[], opts: IndexNowOptions = {}): Promise<IndexNowResult> {
  const list = urls
    .filter(Boolean)
    .map((u) => (u.startsWith('http') ? u : `${SITE_URL}${u.startsWith('/') ? u : `/${u}`}`));

  if (list.length === 0) return { ok: true, submitted: 0 };

  const host = new URL(SITE_URL).host;
  const keyLocation = indexNowKeyLocation();
  const batches = indexNowBatches(list);
  const byName = new Map<IndexNowEndpointResult['name'], IndexNowEndpointResult>();

  for (const batch of batches) {
    const body = JSON.stringify({ host, key: INDEXNOW_KEY, keyLocation, urlList: batch });
    for (const endpoint of INDEXNOW_ENDPOINTS) {
      const one = await postBatch(endpoint, body);
      const prev = byName.get(endpoint.name);
      if (!prev) {
        byName.set(endpoint.name, one);
        continue;
      }
      // Пачка принята, только если приняты все. Статус отказа важнее успеха.
      byName.set(endpoint.name, {
        name: endpoint.name,
        ok: prev.ok && one.ok,
        status: one.ok ? (prev.status ?? one.status) : (one.status ?? prev.status),
        error: [prev.error, one.error].filter(Boolean).join('; ') || undefined,
      });
    }
  }

  const endpoints = INDEXNOW_ENDPOINTS.map((e) => byName.get(e.name)!);
  const yandex = endpoints.find((e) => e.name === 'yandex');
  const ok = endpoints.every((e) => e.ok);
  const error = endpoints.map((e) => e.error).filter(Boolean).join('; ') || undefined;
  const trail = {
    ...(opts.source ? { source: opts.source } : {}),
    urls: list.slice(0, LOGGED_URLS_MAX),
    ...(list.length > LOGGED_URLS_MAX ? { urls_more: list.length - LOGGED_URLS_MAX } : {}),
    keyLocation,
    endpoints,
  };
  await log(ok ? 'indexnow_ping' : 'indexnow_failed', { submitted: list.length, ...trail });
  return {
    ok,
    submitted: list.length,
    status: yandex?.status ?? undefined,
    error,
    endpoints,
  };
}

async function log(action: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_actions_log (action_type, metadata) VALUES ($1, $2)`,
      [action, JSON.stringify(metadata)],
    );
  } catch { /* журнал недоступен — пинг важнее записи о нём */ }
}

/**
 * Попутный пинг об изменении тура: не ждёт результата и не влияет на ответ
 * сохранения. Зовётся из путей записи тура.
 */
// Канонический адрес карточки тура — /catalog/tours/[id]: его подаёт sitemap,
// на него ведёт навигация («Туры» → /catalog). Пинг обязан совпадать с
// каноном — иначе мы сами сообщаем Яндексу два разных «настоящих» адреса.
// Сторож согласованности: tests/unit/indexnow.test.ts.
//
// С 30.09 канон — адрес по имени (ЧПУ, lib/tours/tour-url): адрес берётся
// из базы в момент пинга; не прочитался — пингуем числом (оно уводит 308 на
// адрес), и это пишется в лог, а не глушится.
export function pingTourChanged(tourId: string | number | bigint): void {
  void (async () => {
    let path = `/catalog/tours/${tourId}`;
    try {
      const { rows } = await query<{ slug: string | null }>('SELECT slug FROM operator_tours WHERE id = $1', [String(tourId)]);
      path = tourPath({ id: String(tourId), slug: rows[0]?.slug ?? null });
    } catch (e) {
      console.error('[indexnow] адрес тура не прочитан, пингую числом:', e instanceof Error ? e.message : String(e));
    }
    await pingIndexNow([path, '/catalog']);
  })().catch(() => {});
}

export function pingPlaceChanged(slugOrId: string): void {
  void pingIndexNow([`/places/${slugOrId}`, '/places']).catch(() => {});
}

export function pingRoutesChanged(slugsOrIds: Array<string | number>): void {
  if (slugsOrIds.length === 0) return;
  void pingIndexNow([...slugsOrIds.map((s) => `/routes/${s}`), '/routes']).catch(() => {});
}
