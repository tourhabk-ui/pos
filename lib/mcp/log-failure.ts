/**
 * Отказ записи на пути MCP называется в логе: имя операции и SQLSTATE (§4.0).
 *
 * Журнал вызовов, рукопожатие и ссылки «Продолжить в Ведаре» пишутся
 * fire-and-forget — ответ агенту важнее. Но молчащий catch превращал поломку
 * записи в «никто не звал»: сторож молчания MCP в Watchdog читает
 * mcp_tool_calls и тишину журнала объявляет фактом о каталогах (проверка
 * MCP 29.09).
 */
export function logMcpFailure(operation: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  console.error(
    `[mcp] ${operation} не выполнилось: sqlstate=${typeof code === 'string' ? code : 'нет'}`,
    err instanceof Error ? err.message : String(err),
  );
}
