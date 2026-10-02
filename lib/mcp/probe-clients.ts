/**
 * Клиенты-проверки MCP: не спрос, а наши и чужие пробы (решение владельца 02.10).
 *
 * Журнал за 30 дней: из 1190 вызовов 416 — свой смоук деплоя, ещё десятки —
 * пробы аудита и сторонние верификаторы каталогов, плюс curl. Сидя в одной
 * таблице с Claude и браузером, они читались как спрос, которого нет
 * (create_lead за месяц звали дважды, оба раза с ошибкой).
 *
 * Имя клиента берётся из его самопредставления при рукопожатии
 * (mcp_clients.client_name); curl рукопожатия не делает и опознаётся по роду
 * заголовка. Список открытый: новая проба добавляется сюда, и сторож
 * требует, чтобы каждое имя из clientInfo в scripts/ здесь было.
 */
export const PROBE_CLIENT_NAMES: readonly string[] = [
  'vedar-deploy-smoke',   // scripts/deploy-smoke.mjs — один вызов на деплой
  'vedar-audit-probe',    // пробы аудита MCP (29.09 и далее)
  'verifymcp-probe',      // сторонний верификатор каталога MCP
  'rokmcp-probe',         // сторонний верификатор каталога MCP
];

export const PROBE_UA_FAMILIES: readonly string[] = ['curl'];

export function isProbeClient(clientName: string | null, uaFamily: string | null): boolean {
  if (clientName && PROBE_CLIENT_NAMES.includes(clientName)) return true;
  if (!clientName && uaFamily && PROBE_UA_FAMILIES.includes(uaFamily)) return true;
  return false;
}

/**
 * SQL-предикат «вызов t — проверка»: соединение с mcp_clients по суточному
 * ключу журнала. Параметры — $names (text[]) и $families (text[]).
 */
export function probeCallSql(t: string, namesParam: string, familiesParam: string): string {
  return `EXISTS (
    SELECT 1 FROM mcp_clients pc
     WHERE pc.caller_hash = ${t}.caller_hash
       AND pc.day = ${t}.created_at::date
       AND (pc.client_name = ANY(${namesParam}::text[])
            OR (pc.client_name IS NULL AND pc.ua_family = ANY(${familiesParam}::text[]))))`;
}
