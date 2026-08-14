/**
 * Журнал вызовов MCP-инструментов (Рост-6 — наблюдаемость MCP-канала).
 *
 * Пишет ФАКТ вызова: инструмент, исход, длительность, суточный hash
 * вызывающего. Аргументы инструментов сюда не попадают by construction —
 * в заявочных лежат имя и телефон туриста (152-ФЗ), а журналу они не нужны:
 * вопрос наблюдаемости — «зовут ли, что зовут, ломается ли», не «кто».
 *
 * Fire-and-forget: сбой журнала не должен ломать ответ агенту.
 */

import { pool } from '@/lib/db-pool';
import { visitorHash, currentDay } from '@/lib/analytics/visitor-hash';
import { PUBLIC_MCP_TOOL_NAMES } from '@/lib/mcp/public-tools';

export type McpErrorKind = 'rate_limited' | 'unknown_tool' | 'execution';

export interface McpCallLogEntry {
  tool: string;
  ok: boolean;
  errorKind?: McpErrorKind;
  durationMs?: number;
  ip: string;
  userAgent: string;
}

/**
 * Имя инструмента в журнале — только из реестра. Произвольную строку от
 * внешнего клиента в БД не пишем: мусорная кардинальность и попытки
 * инъекций в дашборд остаются одной строкой 'unknown'.
 */
export function safeToolName(name: string): string {
  return PUBLIC_MCP_TOOL_NAMES.has(name) ? name : 'unknown';
}

export function logMcpToolCall(entry: McpCallLogEntry): void {
  const hash = visitorHash(entry.ip, entry.userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar');
  void pool
    .query(
      `INSERT INTO mcp_tool_calls (tool, ok, error_kind, duration_ms, caller_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        safeToolName(entry.tool),
        entry.ok,
        entry.errorKind ?? null,
        entry.durationMs ?? null,
        hash,
      ],
    )
    .catch(() => { /* журнал не важнее ответа агенту */ });
}
