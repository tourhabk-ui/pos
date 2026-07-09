/**
 * POST  /api/admin/safety/kvert-sync  — запустить синк ACC из KVERT VONA
 * PATCH /api/admin/safety/kvert-sync  — вручную выставить цвет одного вулкана
 *
 * Только админ. Синк тянет KVERT с прод-IP (РФ); ручной PATCH работает всегда.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { syncKvertAcc, setVolcanoAcc } from '@/lib/agents/kvert-sync';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const result = await syncKvertAcc();
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка синка KVERT';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

const SetSchema = z.object({
  volcanoName: z.string().min(2).max(80),
  color: z.enum(['green', 'yellow', 'orange', 'red', 'unassigned']),
  ashHeightM: z.number().int().nonnegative().max(30000).nullish(),
  summary: z.string().max(2000).nullish(),
});

export async function PATCH(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = SetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }

  try {
    const result = await setVolcanoAcc({
      volcanoName: parsed.data.volcanoName,
      color: parsed.data.color,
      ashHeightM: parsed.data.ashHeightM ?? null,
      summary: parsed.data.summary ?? null,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
