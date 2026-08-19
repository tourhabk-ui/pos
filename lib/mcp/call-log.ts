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
import { normalizeClientName, normalizeClientVersion, uaFamily } from '@/lib/mcp/client-id';

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

/**
 * Суточный hash звонившего — В ОДНОМ месте.
 *
 * Соль и состав входа обязаны совпадать у журнала вызовов и у записи
 * рукопожатия: иначе `mcp_clients` и `mcp_tool_calls` не соединятся, и вопрос
 * «кто звал» останется без ответа при полном журнале. Два вычисления одного
 * hash — это два разных hash, вопрос времени.
 */
export function mcpCallerHash(ip: string, userAgent: string): string {
  return visitorHash(ip, userAgent, currentDay(), process.env.CRON_SECRET ?? 'vedar');
}

/**
 * Запомнить, КТО звал: имя из `initialize`, род — из заголовка на подхвате.
 *
 * Пишется по суточному ключу, тому же, что у журнала вызовов. Имя клиента —
 * это имя ПРОГРАММЫ, не человека; 152-ФЗ оно не касается, а суточная граница
 * сохраняется, то есть длинного профиля по-прежнему не строится.
 *
 * `last_seen` обновляется, имя — только когда оно есть: клиент мог сначала
 * представиться, а потом слать вызовы без рукопожатия, и затирать известное
 * пустотой нельзя.
 */
export function logMcpClient(entry: {
  ip: string;
  userAgent: string;
  clientInfo?: unknown;
}): void {
  const info = (entry.clientInfo ?? {}) as { name?: unknown; version?: unknown };
  void pool
    .query(
      `INSERT INTO mcp_clients (caller_hash, day, client_name, client_version, ua_family)
       VALUES ($1, CURRENT_DATE, $2, $3, $4)
       ON CONFLICT (caller_hash, day) DO UPDATE
          SET client_name    = COALESCE(EXCLUDED.client_name, mcp_clients.client_name),
              client_version = COALESCE(EXCLUDED.client_version, mcp_clients.client_version),
              ua_family      = COALESCE(EXCLUDED.ua_family, mcp_clients.ua_family),
              last_seen      = NOW()`,
      [
        mcpCallerHash(entry.ip, entry.userAgent),
        normalizeClientName(info.name),
        normalizeClientVersion(info.version),
        uaFamily(entry.userAgent),
      ],
    )
    .catch(() => { /* журнал не важнее ответа агенту */ });
}

export function logMcpToolCall(entry: McpCallLogEntry): void {
  const hash = mcpCallerHash(entry.ip, entry.userAgent);
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
