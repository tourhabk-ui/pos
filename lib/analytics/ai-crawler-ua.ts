/**
 * Запись сырого User-Agent краулера (владелец 24.10).
 *
 * page_views хранит только семейство: сырой UA человека туда не пишется
 * (152-ФЗ). Здесь — наоборот узко: строка попадает в журнал, только если
 * `aiCrawlerUaFamily` узнал ИИ-краулера, YandexBot или Bingbot.
 *
 * Счётчик — сутки × семейство × строка. Витрина смотрит 7 дней; старше
 * восьми суток строка удаляется тем же запросом.
 *
 * Пул не импортируется статически. Корень layout оценивается на сборке
 * из-за metadata, и `import { pool }` отсюда тянул бы базу в граф каждой
 * страницы без запросного API (tests/unit/no-build-time-db.test.ts).
 * Соединение открывается в момент записи: layout уже на запросе (`headers()`).
 */

import { aiCrawlerUaFamily } from '@/lib/analytics/ai-crawler-families';
import { logText } from '@/lib/log/log-text';

export { aiCrawlerUaFamily } from '@/lib/analytics/ai-crawler-families';

const UA_MAX = 300;

interface CrawlerPool {
  query: (sql: string, params: unknown[]) => Promise<unknown>;
}

function crawlerPool(): CrawlerPool {
  // Относительный путь: алиас `@/` в require резолвит сборка Next, а не vitest.
  // Статический import здесь нельзя — его увидит граф сборки страниц.
  const loaded = require('../db-pool') as { pool: CrawlerPool };
  return loaded.pool;
}

export function recordAiCrawlerUa(
  path: string | null | undefined,
  userAgent: string | null | undefined,
  db?: CrawlerPool,
): void {
  const family = aiCrawlerUaFamily(userAgent);
  if (!family || !userAgent) return;
  const ua = userAgent.trim().slice(0, UA_MAX);
  if (!ua) return;
  const where = path && path.startsWith('/') ? path.slice(0, 200) : null;
  void (db ?? crawlerPool())
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
