/**
 * Перепись краулеров по семействам у входов для агентов.
 *
 * До 12.10 узнать, приходят ли к нам Baidu, ByteDance или Huawei, было нечем:
 * счётчик платформы (`page_views`) пишется из браузера скриптом, который
 * обходчик не исполняет; middleware не видит robots.txt, llms.txt и
 * /.well-known/*; журнал MCP (`mcp_clients`) считает только вызовы
 * инструментов. Первое, что берёт любой обходчик, — robots.txt, и именно там
 * видно, кто вообще дошёл.
 *
 * Хранится не визит, а счётчик: сутки × путь × семейство (реестр семейств —
 * lib/analytics/bot-detect.ts). Сырой User-Agent и IP не хранятся — та же
 * граница, что у `mcp_clients` (миграция 872). Запись не ждётся и ответ не
 * роняет; отказ базы пишется в лог с SQLSTATE, а не глушится (§4.0).
 *
 * Читает перепись `GET /api/cron/agent-entry-census`.
 * Сторож: tests/unit/agents-china-layer.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { botFamily } from '@/lib/analytics/bot-detect';
import { logText } from '@/lib/log/log-text';

import { AGENT_ENTRY_HTML_PATHS, zhEntryPath, type AgentEntryPath } from '@/lib/analytics/agent-entry-paths';

export { AGENT_ENTRY_PATHS, AGENT_ENTRY_HTML_PATHS, zhEntryPath, type AgentEntryPath } from '@/lib/analytics/agent-entry-paths';

export function recordAgentEntryHit(path: AgentEntryPath, userAgent: string | null | undefined): void {
  const family = botFamily(userAgent);
  // HTML-страница (/zh, аудит 15.10, CN-quick): браузер человека — не
  // обходчик, его визит считает page_views. Без этой отсечки перепись
  // краулеров стала бы вторым счётчиком посещаемости.
  if (family === 'browser' && AGENT_ENTRY_HTML_PATHS.has(path)) return;
  void pool
    .query(
      `INSERT INTO agent_entry_hits (day, path, family, hits)
       VALUES (CURRENT_DATE, $1, $2, 1)
       ON CONFLICT (day, path, family) DO UPDATE SET hits = agent_entry_hits.hits + 1`,
      [path, family],
    )
    .catch((err: unknown) => {
      const code = (err as { code?: unknown })?.code;
      console.error(
        '[agent-entry-hits] запись не удалась:',
        typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '',
        logText(err instanceof Error ? err.message : err, 200),
      );
    });
}

/**
 * Счётчик китайского раздела (аудит 15.10, CN-quick): адрес страницы → метка
 * входа (/zh своей строкой, всё под ним — одной меткой /zh/*). Зовёт /zh; та
 * же функция будет у будущих /zh/<…>, и путь на каждую карточку не заведётся.
 * Не китайский адрес — ошибка вызывающего: в лог, без записи чужой меткой.
 */
export function recordZhEntryHit(pathname: string, userAgent: string | null | undefined): void {
  const path = zhEntryPath(pathname);
  if (!path) {
    console.error('[agent-entry-hits] адрес не из раздела /zh — не записан:', logText(pathname, 80));
    return;
  }
  recordAgentEntryHit(path, userAgent);
}
