/**
 * lib/mcp/partner-server.ts — MCP партнёра к своей CRM (CRM #2325, шаг 1д-2).
 *
 * Отдельный сервер, а не ветка публичного: у публичного аноним и данные
 * Камчатки, у этого — ключ партнёра и его клиенты. Общего у них — разбор
 * JSON-RPC (`lib/mcp/jsonrpc`), согласование версии и предел тела; реестры
 * инструментов не пересекаются: инструменты CRM не попадают в публичный
 * `tools/list` (сторож mcp-kuzmich-parity), а публичные — сюда.
 *
 * Партнёр — только из ключа (`resolveAgentKey`), никогда из аргументов.
 * Инструменты и правило «телефонов и почт модели не отдаём» — те же, что у
 * Кузьмича в чате партнёра (`lib/crm/tools.ts`). Ключ без права записи
 * пишущих инструментов не видит в `tools/list`, а их вызов получает отказ.
 *
 * Вызовы НЕ пишутся в `mcp_tool_calls`: та таблица — журнал публичного
 * канала, её читают сторож молчания MCP и перепись спроса, и вызовы
 * партнёра своей CRM исказили бы оба.
 */
import { crmToolDefinitions, crmToolText, CRM_WRITE_TOOL_NAMES, executeCrmTool, isCrmTool } from '@/lib/crm/tools';
import type { AgentKeyContext } from '@/lib/crm/agent-keys';
import { partnerCategoryLabel } from '@/lib/crm/labels';
import { classifyMessage, jsonrpcError, jsonrpcSuccess } from '@/lib/mcp/jsonrpc';
import { negotiateProtocolVersion } from '@/lib/mcp/protocol-version';

export const PARTNER_MCP_SERVER_INFO = {
  name: 'vedar-partner-crm',
  title: 'Ведар — CRM партнёра',
  version: '1.0.0',
} as const;

export interface PartnerMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: false; openWorldHint: false };
}

/** Инструменты для этого ключа: пишущие — только при праве записи. */
export function partnerMcpTools(canWrite: boolean): PartnerMcpTool[] {
  return crmToolDefinitions(canWrite).map((d) => ({
    name: d.function.name,
    description: d.function.description,
    inputSchema: d.function.parameters,
    annotations: {
      readOnlyHint: !CRM_WRITE_TOOL_NAMES.includes(d.function.name),
      destructiveHint: false,
      openWorldHint: false,
    },
  }));
}

export function partnerInstructions(key: AgentKeyContext): string {
  return [
    `CRM партнёра платформы Ведар (Камчатка): ${key.partnerName}, роль — ${partnerCategoryLabel(key.category)}.`,
    'Клиенты называются contact_id и подписью («Анна П.»); телефонов и почт клиентов здесь нет — связаться партнёр может из кабинета.',
    key.canWrite
      ? 'Ключ с правом записи: касание, задачу и выполнение записывай, только когда об этом просит партнёр.'
      : 'Ключ только для чтения: записывать в CRM нельзя.',
    'Чего инструменты не вернули — того не утверждай.',
  ].join(' ');
}

type Reply = ReturnType<typeof jsonrpcSuccess> | ReturnType<typeof jsonrpcError>;

/**
 * Одно сообщение JSON-RPC → ответ или null (уведомление и ответ клиента
 * ответа не получают). Ключ уже проверен роутом.
 */
export async function handlePartnerMessage(raw: unknown, key: AgentKeyContext): Promise<Reply | null> {
  const msg = classifyMessage(raw);
  if (msg.kind === 'response' || msg.kind === 'notification') return null;
  if (msg.kind === 'invalid') return jsonrpcError(msg.id, -32600, `Invalid Request: ${msg.reason}`);

  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return jsonrpcSuccess(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: {} },
        serverInfo: PARTNER_MCP_SERVER_INFO,
        instructions: partnerInstructions(key),
      });

    case 'tools/list':
      return jsonrpcSuccess(id, { tools: partnerMcpTools(key.canWrite) });

    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      // Неизвестное имя и пишущий инструмент при ключе на чтение — ошибка
      // протокола: агент должен перечитать tools/list, а не пересказывать
      // человеку «инструмент не сработал».
      const visible = partnerMcpTools(key.canWrite).map((t) => t.name);
      if (!isCrmTool(name) || !visible.includes(name)) {
        return jsonrpcError(id, -32602, `Unknown tool: ${name.slice(0, 80)}`, { available: visible });
      }
      const r = await executeCrmTool(name, params.arguments ?? {}, {
        partnerId: key.partnerId,
        category: key.category,
        userId: key.userId,
        actor: 'mcp',
        canWrite: key.canWrite,
      });
      return jsonrpcSuccess(id, {
        content: [{ type: 'text', text: crmToolText(r) }],
        ...(r.ok ? {} : { isError: true }),
      });
    }

    case 'ping':
      return jsonrpcSuccess(id, {});

    default:
      return jsonrpcError(id, -32601, `Method not found: ${method.slice(0, 80)}`);
  }
}
