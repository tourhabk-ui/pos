/**
 * MCP Server (Streamable HTTP) — внешний протокольный вход в мозг Кузьмича.
 * Протокол: JSON-RPC 2.0 (MCP spec). URL: https://vedarai.ru/api/mcp
 *
 * Один мозг — два протокола: инструменты НЕ дублируются здесь своим SQL,
 * а делегируются реестру Кузьмича (lib/kuzmich/tool-schemas.ts + executor в
 * core.ts). До этого сервер держал параллельный набор из 4 инструментов
 * со своим SQL по legacy-VIEW и отставал от Кузьмича: внешний агент видел
 * платформу беднее и иначе, чем турист в чате.
 *
 * Подмножество почти read-only и анонимное: наружу НЕ отдаём инструменты,
 * которые жгут внешние квоты (search_kamchatka — платный веб-поиск,
 * search_taaft — внешний каталог с трекингом использования). Ничего, что
 * требует личности пользователя, здесь нет by construction — у Кузьмича
 * такие поверхности живут вне tool-реестра.
 *
 * Единственная запись — create_lead (заявка на подбор тура): не бронь и не
 * оплата, идёт в общий createLead() со скорингом и дедупом. Бронирование
 * анонимному внешнему агенту не отдаём сознательно.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, CREATE_LEAD_TOOL, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { createLead } from '@/lib/leads/create';

export const dynamic = 'force-dynamic';

// Определения инструментов и список наружу — в lib/mcp/public-tools.ts:
// тот же список нужен манифесту /.well-known/mcp.json, а два списка
// разошлись бы в первый же день. Здесь остаётся только исполнение.

const createLeadArgsSchema = z.object({
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(120),
  phone: z.string().trim().min(5, 'Телефон обязателен — иначе менеджеру не с кем связаться').max(50),
  comment: z.string().trim().min(10, 'Опишите запрос хотя бы в 10 символах').max(2000),
  interest: z.string().trim().max(200).optional(),
});

async function executeCreateLead(rawArgs: Record<string, unknown>): Promise<string> {
  const parsed = createLeadArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки');
  }
  const { name, phone, comment, interest } = parsed.data;
  const leadId = await createLead({
    name,
    phone,
    comment: interest ? `[Интерес: ${interest}] ${comment}` : comment,
    source_url: 'mcp://vedar',
    source_data: { source: 'mcp' },
  });
  if (!leadId) {
    throw new Error('Не удалось сохранить заявку — попробуйте позже');
  }
  return `Заявка принята (номер ${leadId}). Менеджер Ведара свяжется по указанному телефону.`;
}


// ── Execute tool by name ─────────────────────────────────────
async function executeTool(name: string, rawArgs: Record<string, unknown>): Promise<string> {
  if (!PUBLIC_MCP_TOOL_NAMES.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  if (name === CREATE_LEAD_TOOL.name) {
    return executeCreateLead(rawArgs);
  }
  // Аргументы от внешнего клиента — та же граница недоверия, что
  // модель→executor у Кузьмича: тот же Zod-валидатор (коэрсия к строкам,
  // trim, обрезка длины), затем тот же исполнитель.
  const validation = validateToolArgs(name, rawArgs as Record<string, string>);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  return executeKuzmichTool(name, validation.args);
}

// ── JSON-RPC helpers ─────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

function jsonrpcSuccess(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function jsonrpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// ── MCP Protocol: GET = server info ──────────────────────────
export async function GET() {
  return NextResponse.json({
    ...MCP_SERVER_INFO,
    tools: PUBLIC_MCP_TOOLS,
  });
}

// ── MCP Protocol: POST = JSON-RPC 2.0 ───────────────────────
export async function POST(request: NextRequest) {
  let body: JsonRpcRequest;
  try {
    body = await request.json() as JsonRpcRequest;
  } catch {
    return NextResponse.json(
      jsonrpcError(null, -32700, 'Parse error'),
      { status: 400 }
    );
  }

  const { method, params, id } = body;

  try {
    switch (method) {
      // ── initialize handshake ──
      case 'initialize':
        return NextResponse.json(jsonrpcSuccess(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: MCP_SERVER_INFO.name,
            version: MCP_SERVER_INFO.version,
          },
        }));

      // ── client acknowledged init ──
      case 'notifications/initialized':
        return NextResponse.json(jsonrpcSuccess(id, {}));

      // ── list available tools ──
      case 'tools/list':
        return NextResponse.json(jsonrpcSuccess(id, { tools: PUBLIC_MCP_TOOLS }));

      // ── call a tool ──
      case 'tools/call': {
        const toolName = typeof params?.name === 'string' ? params.name : '';
        const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;

        try {
          const text = await executeTool(toolName, toolArgs);
          return NextResponse.json(jsonrpcSuccess(id, {
            content: [{ type: 'text', text }],
          }));
        } catch (toolErr) {
          const msg = toolErr instanceof Error ? toolErr.message : 'Tool execution failed';
          return NextResponse.json(jsonrpcSuccess(id, {
            content: [{ type: 'text', text: msg }],
            isError: true,
          }));
        }
      }

      // ── ping/pong ──
      case 'ping':
        return NextResponse.json(jsonrpcSuccess(id, {}));

      // ── unknown method ──
      default:
        return NextResponse.json(
          jsonrpcError(id, -32601, `Method not found: ${method}`),
          { status: 400 }
        );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json(
      jsonrpcError(id, -32603, msg),
      { status: 500 }
    );
  }
}
