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
import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, CREATE_LEAD_TOOL, BOOKING_REQUEST_TOOL, MCP_SERVER_INFO } from '@/lib/mcp/public-tools';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { createLead } from '@/lib/leads/create';
import { createRateLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// ── Rate-limit по IP (Эволюция 3.0, п.4) ─────────────────────
// Вход анонимный, поэтому лимит — единственный тормоз для абьюза. Чтение
// щедрое (агент в диалоге дёргает несколько инструментов подряд), запись
// жёсткая: заявки создают работу живому менеджеру.
const readLimiter = createRateLimiter({ windowMs: 60_000, max: 30 });
const writeLimiter = createRateLimiter({ windowMs: 600_000, max: 5 });
const WRITE_TOOLS = new Set<string>([CREATE_LEAD_TOOL.name, BOOKING_REQUEST_TOOL.name]);

function clientIp(request: NextRequest): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

// Определения инструментов и список наружу — в lib/mcp/public-tools.ts:
// тот же список нужен манифесту /.well-known/mcp.json, а два списка
// разошлись бы в первый же день. Здесь остаётся только исполнение.

const createLeadArgsSchema = z.object({
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(120),
  phone: z.string().trim().min(5, 'Телефон обязателен — иначе менеджеру не с кем связаться').max(50),
  comment: z.string().trim().min(10, 'Опишите запрос хотя бы в 10 символах').max(2000),
  interest: z.string().trim().max(200).optional(),
});

// ── create_booking_request (Эволюция 3.0, п.4) ───────────────
// Заявка на бронь конкретного тура на дату. НЕ бронь: реальную бронь создаёт
// оператор после звонка (никакого INSERT в operator_bookings отсюда — роут,
// пишущий брони, обязан жить по правилам комиссий §7, и это не наш случай).
// Занятость проверяется движком планера — тем же расчётом, что у гейта брони:
// нет мест → заявка не создаётся, агенту честно отдаются ближайшие даты.
const bookingRequestArgsSchema = z.object({
  tour: z.string().trim().min(1, 'Укажите тур: название или ID').max(200),
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD'),
  participants: z.coerce.number().int().min(1).max(30).default(1),
  name: z.string().trim().min(2, 'Имя короче 2 символов').max(120),
  phone: z.string().trim().min(5, 'Телефон обязателен — заявку подтверждают по нему').max(50),
  comment: z.string().trim().max(2000).optional(),
});

async function executeCreateBookingRequest(rawArgs: Record<string, unknown>): Promise<string> {
  const parsed = bookingRequestArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Некорректные данные заявки');
  }
  const { tour: tourQuery, date, participants, name, phone, comment } = parsed.data;

  const { resolveTourByQuery } = await import('@/lib/kuzmich/tour-availability-tool');
  const tour = await resolveTourByQuery(tourQuery);
  if (!tour) {
    return `Тур по запросу "${tourQuery}" не найден среди активных — заявка не создана. Уточните тур через get_tours или get_tour_availability.`;
  }

  const today = new Date().toISOString().slice(0, 10);
  if (date < today) {
    return `Дата ${date} уже прошла — заявка не создана. Свободные даты: get_tour_availability.`;
  }

  const { createPlannerCache, fetchAvailabilityForTour } = await import('@/lib/planner');
  const cache = createPlannerCache();
  const slots = await fetchAvailabilityForTour(String(tour.id), date, date, cache);
  const remaining = slots[0]?.remaining ?? 0;
  if (remaining < participants) {
    // Честный отказ с альтернативами вместо фантомной заявки на несуществующие места.
    const horizon = new Date(Date.parse(date) + 30 * 86400000).toISOString().slice(0, 10);
    const nearest = (await fetchAvailabilityForTour(String(tour.id), today, horizon, cache))
      .filter((s) => s.remaining >= participants)
      .slice(0, 5)
      .map((s) => `${s.date} (${s.remaining} мест)`);
    return `На ${date} у тура "${tour.title}" ${remaining === 0 ? 'нет свободных мест' : `только ${remaining} мест, а нужно ${participants}`} — заявка не создана. ` +
      (nearest.length > 0 ? `Ближайшие даты с местами: ${nearest.join(', ')}.` : 'В ближайшие 30 дней подходящих дат нет — предложите другой тур.');
  }

  const leadId = await createLead({
    name,
    phone,
    comment:
      `[Заявка на бронь] Тур "${tour.title}" (ID${tour.id}), дата ${date}, участников ${participants}.` +
      (comment ? ` ${comment}` : ''),
    route_title: tour.title,
    source_url: 'mcp://vedar/booking',
    source_data: { source: 'mcp', tool: 'create_booking_request', tour_id: tour.id, date, participants },
  });
  if (!leadId) {
    throw new Error('Не удалось сохранить заявку — попробуйте позже');
  }
  return `Заявка на бронь принята (номер ${leadId}): "${tour.title}", ${date}, ${participants} чел. ` +
    `На ${date} свободно ${remaining} мест. Оператор подтвердит бронь по телефону ${phone}. Это заявка, не оплата.`;
}

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
  if (name === BOOKING_REQUEST_TOOL.name) {
    return executeCreateBookingRequest(rawArgs);
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

        // Rate-limit до исполнения: превышение — обычный tool-ответ с isError,
        // агент его прочитает и подождёт (429 на JSON-RPC клиенты реагируют хуже).
        const limiter = WRITE_TOOLS.has(toolName) ? writeLimiter : readLimiter;
        if (!limiter.check(`${WRITE_TOOLS.has(toolName) ? 'w' : 'r'}:${clientIp(request)}`)) {
          return NextResponse.json(jsonrpcSuccess(id, {
            content: [{ type: 'text', text: 'Слишком много запросов — подождите минуту и повторите.' }],
            isError: true,
          }));
        }

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
