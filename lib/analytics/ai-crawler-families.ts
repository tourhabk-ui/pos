/**
 * Какого краулера писать в журнал сырых User-Agent — без базы.
 *
 * Список и разбор строки. Запись в `ai_crawler_ua` живёт отдельно
 * (`ai-crawler-ua.ts`): корень `app/layout.tsx` зовёт запись на каждом HTML,
 * и статический импорт пула из этого списка потянул бы базу в сборку каждой
 * страницы без запросного API.
 *
 * Человек, пустой UA и прочие боты — null. IP нет.
 */

import { botFamily, isAiFamily } from '@/lib/analytics/bot-detect';

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
