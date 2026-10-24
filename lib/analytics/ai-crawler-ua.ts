/**
 * Сырой User-Agent краулера, которого владелец просил видеть (24.10).
 *
 * page_views хранит только семейство: сырой UA человека туда не пишется
 * (152-ФЗ). Здесь — наоборот узко: строка попадает в журнал, только если
 * бот сам назвался ИИ-краулером из реестра либо YandexBot / Bingbot.
 * Человек, пустой UA и прочие боты не пишутся. IP нет.
 *
 * Счётчик — сутки × семейство × строка. Витрина смотрит 7 дней; старше
 * восьми суток строка удаляется тем же запросом.
 */

import { pool } from '@/lib/db-pool';
import { botFamily, isAiFamily } from '@/lib/analytics/bot-detect';
import { logText } from '@/lib/log/log-text';

const UA_MAX = 300;

/** Семейство, если эту строку надо сохранить, иначе null. */
export function aiCrawlerUaFamily(userAgent: string | null | undefined): string | null {
  if (!userAgent || !userAgent.trim()) return null;
  const family = botFamily(userAgent);
  if (isAiFamily(family)) return family;
  const ua = userAgent.toLowerCase();
  if (ua.includes('yandexbot')) return 'yandex';
  if (ua.includes('bingbot')) return 'bing';
  return null;
}

export function recordAiCrawlerUa(path: string | null | undefined, userAgent: string | null | undefined): void {
  const family = aiCrawlerUaFamily(userAgent);
  if (!family || !userAgent) return;
  const ua = userAgent.trim().slice(0, UA_MAX);
  if (!ua) return;
  const where = path && path.startsWith('/') ? path.slice(0, 200) : null;
  void pool
    .query(
      `WITH ins AS (
         INSERT INTO ai_crawler_ua (day, family, user_agent, path, hits)
         VALUES (CURRENT_DATE, $1, $2, $3, 1)
         ON CONFLICT (day, family, user_agent)
         DO UPDATE SET hits = ai_crawler_ua.hits + 1
         RETURNING 1
       )
       DELETE FROM ai_crawler_ua WHERE day < CURRENT_DATE - 8`,
      [family, ua, where],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: unknown })?.code;
      console.error(
        '[ai-crawler-ua] запись не удалась:',
        typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
        logText(err instanceof Error ? err.message : err, 200),
      );
    });
}
