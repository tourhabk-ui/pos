/**
 * GET /api/cron/channel-parity — снимок «MCP против сайта» одним JSON.
 *
 * Владелец 29.09: сверка каналов нашла три расхождения (единица цены,
 * счётчик обстановки, вулканы) глазами, по живым страницам. Нужен
 * фиксированный набор, который машина может гонять после каждой правки:
 * одни и те же 8 туров, одни и те же 8 вулканов, обстановка — с двух
 * сторон (`mcp` и `ui`) на один `taken_at`.
 *
 * Только чтение. MCP-сторона вызывает инструменты тем же путём, что роут
 * `/api/mcp` (`validateToolArgs` + `executeKuzmichTool`), но журнал вызовов
 * (`logMcpToolCall`) НЕ пишет: проба не должна попадать в метрику каналов —
 * иначе следующий счёт «сколько агентов нас читает» принял бы её за клиента.
 * Сторона сайта — теми же функциями, что рисуют страницы.
 *
 * Разбор и сравнение — `lib/quality/channel-parity*`. Поле без источника на
 * одной из сторон — `null` и строка в `not_compared`, а не расхождение.
 *
 * Bearer CRON_SECRET. Ответ 200 всегда, когда роут отработал; исход снимка —
 * в `ok` и `failed`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { validateToolArgs } from '@/lib/kuzmich/tool-schemas';
import { executeKuzmichTool } from '@/lib/kuzmich/core';
import { MCP_SERVER_INFO, PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';
import { MarketplaceToursQuerySchema, queryMarketplaceTours } from '@/lib/search/tour-search';
import { getSafetyLiveData } from '@/app/_home/data';
import { GET as slotsRoute } from '@/app/api/tours/[id]/slots/route';
import { collectChannelParity, type UiSlot } from '@/lib/quality/channel-parity-collect';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const report = await collectChannelParity({
      now: new Date(),
      mcpServerInfo: { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
      mcpTools: PUBLIC_MCP_TOOLS,
      callMcp: async (tool, args) => {
        const v = validateToolArgs(tool, args);
        if (!v.ok) throw new Error(`${tool}: ${v.error}`);
        return executeKuzmichTool(tool, v.args);
      },
      uiTours: async () => (await queryMarketplaceTours(MarketplaceToursQuerySchema.parse({ limit: 100 }))).tours,
      // Календарь карточки тура — сам публичный роут, без своей копии SQL.
      uiSlots: async (id): Promise<UiSlot[] | null> => {
        const res = await slotsRoute(request, { params: Promise.resolve({ id: String(id) }) });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`/api/tours/${id}/slots: HTTP ${res.status}`);
        const body = (await res.json()) as { slots?: Array<{ date: string; free_slots: number | string }> };
        if (!Array.isArray(body.slots)) throw new Error(`/api/tours/${id}/slots: в ответе нет slots`);
        return body.slots.map((s) => ({ date: s.date, free_slots: Number(s.free_slots) }));
      },
      uiSafety: () => getSafetyLiveData(),
    });
    return NextResponse.json(report);
  } catch (e) {
    console.error('[channel-parity] снимок не собрался:', e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: 'Снимок не собрался — см. лог' }, { status: 500 });
  }
}
