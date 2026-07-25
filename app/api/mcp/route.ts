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
 * Подмножество read-only и анонимное: наружу НЕ отдаём инструменты, которые
 * жгут внешние квоты или пишут (search_kamchatka — платный веб-поиск,
 * search_taaft — внешний каталог с трекингом использования). Ничего, что
 * требует личности пользователя, здесь нет by construction — у Кузьмича
 * такие поверхности живут вне tool-реестра.
 */

import { NextRequest, NextResponse } from 'next/server';
import { TOOL_REGISTRY, validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { executeKuzmichTool } from '@/lib/kuzmich/core';

export const dynamic = 'force-dynamic';

/** Не для анонимного публичного входа: внешние квоты/запись использования. */
const EXCLUDED_TOOLS = new Set(['search_kamchatka', 'search_taaft']);

// ── MCP Tool definitions — из реестра Кузьмича, не руками ────
const TOOLS = Object.values(TOOL_REGISTRY)
  .filter((t) => !EXCLUDED_TOOLS.has(t.definition.function.name))
  .map((t) => ({
    name: t.definition.function.name,
    description: t.definition.function.description,
    // OpenAI-style parameters — это та же JSON-схема, что MCP inputSchema
    inputSchema: t.definition.function.parameters,
  }));

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ── Execute tool by name ─────────────────────────────────────
async function executeTool(name: string, rawArgs: Record<string, unknown>): Promise<string> {
  if (!TOOL_NAMES.has(name)) {
    throw new Error(`Unknown tool: ${name}`);
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
    name: 'vedar-mcp',
    version: '2.0.0',
    description: 'Ведар — данные Камчатки: места и безопасность, туры, жильё, снаряжение, трансферы, погода',
    tools: TOOLS,
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
            name: 'vedar-mcp',
            version: '2.0.0',
          },
        }));

      // ── client acknowledged init ──
      case 'notifications/initialized':
        return NextResponse.json(jsonrpcSuccess(id, {}));

      // ── list available tools ──
      case 'tools/list':
        return NextResponse.json(jsonrpcSuccess(id, { tools: TOOLS }));

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
