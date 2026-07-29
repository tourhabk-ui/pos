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
import { TOOL_REGISTRY, validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { createLead } from '@/lib/leads/create';

export const dynamic = 'force-dynamic';

/** Не для анонимного публичного входа: внешние квоты/запись использования. */
const EXCLUDED_TOOLS = new Set(['search_kamchatka', 'search_taaft']);

// ── create_lead — единственный пишущий инструмент ────────────
// Внешний агент нашёл тур через поисковые инструменты — дальше ему нужен
// следующий шаг. Бронь анонимному агенту не даём (чужие деньги + спам),
// а заявка безопасна: идёт в тот же createLead(), что форма сайта и боты —
// скоринг глушит мусор (низкое качество закрывается без уведомления),
// дедуп по телефон+текст за 24ч не даёт задваивать.
const createLeadArgsSchema = z.object({
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(120),
  phone: z.string().trim().min(5, 'Телефон обязателен — иначе менеджеру не с кем связаться').max(50),
  comment: z.string().trim().min(10, 'Опишите запрос хотя бы в 10 символах').max(2000),
  interest: z.string().trim().max(200).optional(),
});

const CREATE_LEAD_TOOL = {
  name: 'create_lead',
  description: 'Оставить заявку на подбор тура по Камчатке: менеджер платформы свяжется по телефону. Обязательны имя, телефон и описание запроса (даты, состав группы, интересы). Не бронь и не оплата — только заявка.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя туриста' },
      phone: { type: 'string', description: 'Телефон для связи (обязателен)' },
      comment: { type: 'string', description: 'Запрос: даты, сколько человек, что интересует' },
      interest: { type: 'string', description: 'Название тура/маршрута, если уже выбран' },
    },
    required: ['name', 'phone', 'comment'],
  },
} as const;

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

// ── MCP Tool definitions — из реестра Кузьмича, не руками ────
const TOOLS = [
  ...Object.values(TOOL_REGISTRY)
    .filter((t) => !EXCLUDED_TOOLS.has(t.definition.function.name))
    .map((t) => ({
      name: t.definition.function.name,
      description: t.definition.function.description,
      // OpenAI-style parameters — это та же JSON-схема, что MCP inputSchema
      inputSchema: t.definition.function.parameters,
    })),
  CREATE_LEAD_TOOL,
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ── Execute tool by name ─────────────────────────────────────
async function executeTool(name: string, rawArgs: Record<string, unknown>): Promise<string> {
  if (!TOOL_NAMES.has(name)) {
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
    name: 'vedar-mcp',
    version: '2.0.0',
    description: 'Ведар — данные Камчатки: места и безопасность, туры, жильё, снаряжение, трансферы, погода. Плюс заявка на подбор тура (create_lead).',
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
