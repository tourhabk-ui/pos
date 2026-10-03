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
  'connectors-manager',   // проверка коннектора самим claude.ai, не человек (перепись run 78: 41 вызов)
  'claude-audit',         // наш аудит MCP 29.09 из сессии Claude Code
];

/**
 * Образец имени проверки — для тех, кого список не знает заранее. Перепись
 * run 78 (02.10) нашла среди «внешних» katalir-readonly-verifier,
 * agent-index-prober, glama-mcp-inspector, mcphub-probe, vouch-census,
 * grok-audit, tendle-review, probe: верификаторы каталогов приходят новыми
 * каждую неделю, и список за ними не поспеет. Образец — по словам ремесла
 * (probe, verifier, inspector, audit, census, review, smoke, prober), не по
 * бренду: Tendle с 13 вызовами остаётся внешним, tendle-review — проверка.
 * Регистр не важен. Тот же образец уходит в SQL (`~*`), поэтому синтаксис —
 * общий для JS и PostgreSQL: без \\b и lookahead.
 */
export const PROBE_NAME_PATTERN = '(probe|prober|verifier|inspector|audit|census|review|smoke|validator|checker)';
const PROBE_NAME_RE = new RegExp(PROBE_NAME_PATTERN, 'i');

export const PROBE_UA_FAMILIES: readonly string[] = ['curl'];

export function isProbeClient(clientName: string | null, uaFamily: string | null): boolean {
  if (clientName && (PROBE_CLIENT_NAMES.includes(clientName) || PROBE_NAME_RE.test(clientName))) return true;
  if (!clientName && uaFamily && PROBE_UA_FAMILIES.includes(uaFamily)) return true;
  return false;
}

/**
 * Параметры предиката — всегда в этом порядке: имена, семейства заголовка,
 * образец имени. Один источник и для панели, и для переписи.
 */
export const PROBE_PARAMS: [string[], string[], string] = [
  PROBE_CLIENT_NAMES as string[], PROBE_UA_FAMILIES as string[], PROBE_NAME_PATTERN,
];

/**
 * SQL-предикат «вызов t — проверка»: соединение с mcp_clients по суточному
 * ключу журнала. Параметры — $names (text[]), $families (text[]), $pattern (text).
 */
export function probeCallSql(t: string, namesParam: string, familiesParam: string, patternParam: string): string {
  return `EXISTS (
    SELECT 1 FROM mcp_clients pc
     WHERE pc.caller_hash = ${t}.caller_hash
       AND pc.day = ${t}.created_at::date
       AND (pc.client_name = ANY(${namesParam}::text[])
            OR pc.client_name ~* ${patternParam}::text
            OR (pc.client_name IS NULL AND pc.ua_family = ANY(${familiesParam}::text[]))))`;
}
