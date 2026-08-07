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

export const INDEXNOW_KEY = 'ed64b13e2286450aa82e6dfef6659834';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru';
const ENDPOINT = 'https://yandex.com/indexnow';

/** До 10 000 адресов за один POST по спецификации; режем с запасом. */
const MAX_URLS_PER_PING = 5000;

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
export async function pingIndexNow(urls: string[]): Promise<IndexNowResult> {
  const list = urls
    .filter(Boolean)
    .map((u) => (u.startsWith('http') ? u : `${SITE_URL}${u.startsWith('/') ? u : `/${u}`}`))
    .slice(0, MAX_URLS_PER_PING);

  if (list.length === 0) return { ok: true, submitted: 0 };

  const host = new URL(SITE_URL).host;

  try {
    const res = await fetch(ENDPOINT, {
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
      await log('indexnow_ping', { submitted: list.length, status: res.status });
      return { ok: true, submitted: list.length, status: res.status };
    }

    const raw = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    const error = `HTTP ${res.status}: ${raw || 'пустой ответ'}`;
    await log('indexnow_failed', { submitted: list.length, error });
    return { ok: false, submitted: list.length, status: res.status, error };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'сетевой сбой';
    await log('indexnow_failed', { submitted: list.length, error });
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
export function pingTourChanged(tourId: string | number | bigint): void {
  void pingIndexNow([`/catalog/tours/${tourId}`, '/catalog']).catch(() => {});
}

export function pingPlaceChanged(slugOrId: string): void {
  void pingIndexNow([`/places/${slugOrId}`, '/places']).catch(() => {});
}

export function pingRoutesChanged(slugsOrIds: Array<string | number>): void {
  if (slugsOrIds.length === 0) return;
  void pingIndexNow([...slugsOrIds.map((s) => `/routes/${s}`), '/routes']).catch(() => {});
}
