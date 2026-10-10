/**
 * GET  /api/hub/crm/keys — ключи MCP партнёра (без самих ключей)
 * POST /api/hub/crm/keys — выпустить ключ; сам ключ — в ответе, один раз
 *
 * CRM фаза 1, шаг 1д-2 (#2325). Та же дверь шести ролей, что у клиентов и
 * задач: чей партнёр — решает requirePartner. Ключ хранится хешем; в списке
 * его нет, и второй раз его не показать — только выпустить новый.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requirePartner } from '@/lib/crm/partner-context';
import { createAgentKey, listAgentKeys, MAX_ACTIVE_KEYS } from '@/lib/crm/agent-keys';

export const dynamic = 'force-dynamic';

export const NewKeySchema = z.object({
  label: z.string().trim().min(1, 'Назовите ключ — например, по имени агента').max(60),
  // По умолчанию — только чтение (условие владельца 1д).
  can_write: z.boolean().optional().default(false),
}).strict();

function failed(err: unknown, what: string, message: string): NextResponse {
  const code = (err as { code?: string })?.code ?? 'нет SQLSTATE';
  console.error(`[crm] ${what}, SQLSTATE`, code);
  return NextResponse.json({ success: false, error: message }, { status: 503 });
}

export async function GET(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;
  try {
    return NextResponse.json({ success: true, data: { items: await listAgentKeys(ctx.partnerId), max_active: MAX_ACTIVE_KEYS } });
  } catch (err) {
    return failed(err, 'ключи MCP не прочитаны', 'Не удалось загрузить ключи, попробуйте позже');
  }
}

export async function POST(req: NextRequest) {
  const ctx = await requirePartner(req);
  if (ctx instanceof NextResponse) return ctx;

  const body: unknown = await req.json().catch(() => null);
  const parsed = NewKeySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' }, { status: 400 });
  }
  try {
    const r = await createAgentKey(ctx.partnerId, {
      label: parsed.data.label,
      canWrite: parsed.data.can_write,
      createdBy: ctx.userId,
    });
    if (r.outcome === 'limit') {
      return NextResponse.json(
        { success: false, error: `Действующих ключей уже ${MAX_ACTIVE_KEYS} — отзовите ненужный` },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true, data: { key: r.key, item: r.item } }, { status: 201 });
  } catch (err) {
    return failed(err, 'ключ MCP не выпущен', 'Не удалось выпустить ключ, попробуйте позже');
  }
}
