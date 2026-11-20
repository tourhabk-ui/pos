/**
 * IndexNow — мгновенное уведомление поисковиков об изменённых страницах.
 *
 * Владелец 06.08: «делай». Для рунка главный поисковик — Яндекс, и он один из
 * авторов протокола: пинг доводит новую или изменённую страницу до переобхода
 * за минуты вместо дней. У нас 779 страниц мест, 294 маршрута и появляющиеся
 * туры — ждать планового переобхода значит терять недели видимости.
 *
 * Ключ — НЕ секрет по замыслу протокола: он публикуется на самом сайте
 * (/indexnow.txt), и его единственная роль — подтвердить владение хостом.
 * Поэтому он в коде, а не в env: ноль трения при деплое, сторож проверяет
 * согласованность ключа и роута.
 *
 * Отказы не роняют вызывающего (пинг — попутный эффект сохранения), но и не
 * молчат: ложатся в ai_actions_log — урок MAX-зеркала, чей fire-and-forget
 * годами прятал причину.
 */

import { query } from '@/lib/database';
import { tourPath } from '@/lib/tours/tour-url';

export const INDEXNOW_KEY = 'ed64b13e2286450aa82e6dfef6659834';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';
const ENDPOINT = 'https://yandex.com/indexnow';
/**
 * Bing — второй вход (Сыщик 21.11, разрыв цитирования в ответах ИИ): поиск
 * Bing кормит ответы ассистентов, и подача туда напрямую не ждёт пересылки
 * между участниками протокола.
 */
export const INDEXNOW_BING_ENDPOINT = 'https://www.bing.com/indexnow';

/** До 10 000 адресов за один POST по спецификации; режем с запасом. */
const MAX_URLS_PER_PING = 5000;

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
  /** Куда слать; по умолчанию — Яндекс. */
  endpoint?: string;
}

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  status?: number;
  error?: string;
}

/**
 * Пингует IndexNow списком изменённых страниц. Принимает абсолютные URL или
 * пути от корня. Пустой список — не ошибка, просто нечего сообщать.
 */
export async function pingIndexNow(urls: string[], opts: IndexNowOptions = {}): Promise<IndexNowResult> {
  const list = urls
    .filter(Boolean)
    .map((u) => (u.startsWith('http') ? u : `${SITE_URL}${u.startsWith('/') ? u : `/${u}`}`))
    .slice(0, MAX_URLS_PER_PING);

  if (list.length === 0) return { ok: true, submitted: 0 };

  const host = new URL(SITE_URL).host;
  // Что именно пинговали — в журнал рядом с исходом (см. LOGGED_URLS_MAX).
  const trail = {
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    urls: list.slice(0, LOGGED_URLS_MAX),
    ...(list.length > LOGGED_URLS_MAX ? { urls_more: list.length - LOGGED_URLS_MAX } : {}),
  };

  try {
    const res = await fetch(opts.endpoint ?? ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host,
        key: INDEXNOW_KEY,
        keyLocation: `${SITE_URL}/indexnow.txt`,
        urlList: list,
      }),
    });

    // 200 и 202 — принято; остальное — отказ с телом, которое стоит сохранить.
    if (res.status === 200 || res.status === 202) {
      await log('indexnow_ping', { submitted: list.length, status: res.status, ...trail });
      return { ok: true, submitted: list.length, status: res.status };
    }

    const raw = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const error = `HTTP ${res.status}: ${raw || 'пустой ответ'}`;
    await log('indexnow_failed', { submitted: list.length, error, ...trail });
    return { ok: false, submitted: list.length, status: res.status, error };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'сетевой сбой';
    await log('indexnow_failed', { submitted: list.length, error, ...trail });
    return { ok: false, submitted: list.length, error };
  }
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

/**
 * Тексты, которые меняет деплой (Сыщик 21.11): посадочные, статьи, тонкие
 * страницы мест и маршрутов, рыбы, парки, планы. Их правят миграции и код, а
 * не админка, поэтому попутного пинга у них нет — адреса берутся из карты
 * сайта по lastmod после выката (роут /api/cron/indexnow-content).
 */
export const CONTENT_PATH_PREFIXES = ['/articles/', '/places/', '/routes/', '/fish/', '/park/', '/plans/', '/letopis/'] as const;

export function contentUrlsChangedSince(
  entries: ReadonlyArray<{ url: string; lastModified?: string | Date | null }>,
  since: Date,
  landingPaths: readonly string[] = [],
): string[] {
  const landings = new Set(landingPaths);
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.lastModified) continue;
    const at = new Date(e.lastModified);
    if (Number.isNaN(at.getTime()) || at < since) continue;
    let path: string;
    try { path = new URL(e.url).pathname; } catch { continue; }
    if (landings.has(path) || CONTENT_PATH_PREFIXES.some((p) => path.startsWith(p))) out.add(e.url);
  }
  return [...out];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `since` из запроса: дата ISO; нет или мусор — двое суток назад. */
export function parseSince(raw: string | null, now = new Date()): Date {
  if (raw && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now.getTime() - 2 * DAY_MS);
}

