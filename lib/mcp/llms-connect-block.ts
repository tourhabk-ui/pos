/**
 * Короткий блок в начале llms.txt: как ИИ-агенту подключить Кузьмича.
 * Адреса только из канонических констант репозитория — ничего не выдумываем.
 */
import { CANONICAL_BASE_URL } from '@/lib/config';
import { MCP_CONNECT_OPTIONS, MCP_ENDPOINT, MCP_JSON_CONFIG } from '@/lib/mcp/connect';
import {
  A2A_JSONRPC_PATH,
  A2A_REST_PATH,
  AGENT_CARD_PATH,
} from '@/lib/a2a/agent-card';
import { VEDAR_SKILL_URL } from '@/lib/agent/vedar-skill';

export const MCP_MANIFEST_PATH = '/.well-known/mcp.json';

const claudeCode = MCP_CONNECT_OPTIONS.find((o) => o.id === 'claude_code')?.value;
if (!claudeCode) throw new Error('MCP_CONNECT_OPTIONS: нет команды claude_code');

export function llmsKuzmichConnectBlock(base: string = CANONICAL_BASE_URL): string {
  return `## Как ИИ-агенту подключить Кузьмича

Кузьмич — AI-ассистент Ведара (сайт ${base}/kuzmich, Telegram и MAX). Живые туры, обстановка и заявка — через открытые протоколы, без авторизации.

- MCP (Model Context Protocol, Streamable HTTP): ${MCP_ENDPOINT}
  Манифест: ${base}${MCP_MANIFEST_PATH}
  Подключение в Claude Code: \`${claudeCode}\`
  JSON для любого клиента:
\`\`\`
${MCP_JSON_CONFIG}
\`\`\`
- A2A (Agent2Agent 1.0): ${base}${A2A_JSONRPC_PATH}
  Визитка: ${base}${AGENT_CARD_PATH}
  REST: ${base}${A2A_REST_PATH}
- Навык агента: ${VEDAR_SKILL_URL}

Подробные правила вызовов и заявок — в разделах «Для AI-агентов» ниже.
`;
}
