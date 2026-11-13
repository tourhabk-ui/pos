/**
 * POST /api/admin/analytics/a2a/translate — перевести реплику журнала общения
 * A2A на русский (слово владельца 13.11: «нужно кнопку в журнал добавить
 * перевести, много китайцев подключилось»).
 *
 * Тело — { id } строки a2a_dialogs. Текст берётся из строки, а не из тела:
 * дверь переводит только то, что уже лежит в журнале после redactPII, и не
 * служит переводчиком произвольного текста.
 *
 * Ответ — исход по каждому полю отдельно (lib/a2a/dialog-translate):
 * translated / stored / not_needed / failed с причиной. Строки нет (срок
 * хранения вышел) — 404. База не ответила — 503 и SQLSTATE в логе, а не
 * «перевода нет».
 *
 * Сторож: tests/unit/a2a-dialog-translate.test.tsx.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { logText } from '@/lib/log/log-text';
import { translateDialog } from '@/lib/a2a/dialog-translate';

export const dynamic = 'force-dynamic';

const Body = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Нужен номер строки журнала: { "id": число }' }, { status: 400 });
  }

  try {
    const result = await translateDialog(parsed.data.id);
    if (!result.found) {
      return NextResponse.json(
        { success: false, error: 'Этой реплики в журнале уже нет: срок хранения вышел' },
        { status: 404 },
      );
    }
    return NextResponse.json({ success: true, id: result.id, question: result.question, answer: result.answer });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    const sqlstate = typeof code === 'string' ? logText(code, 10) : 'нет';
    console.error(`[admin/analytics/a2a/translate] журнал не прочитался: SQLSTATE=${sqlstate}`, logText(err instanceof Error ? err.message : err, 200));
    return NextResponse.json(
      { success: false, error: `Журнал не прочитался (SQLSTATE=${sqlstate}) — перевод не начат` },
      { status: 503 },
    );
  }
}
