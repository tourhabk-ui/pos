/**
 * GET  /api/admin/safety/alerts — список предупреждений по зонам.
 * POST /api/admin/safety/alerts — завести предупреждение.
 *
 * До 22.08.2026 записи в `safety_alerts` не создавал НИКТО: таблица с миграции
 * 065 ждала администратора, у которого не было ни экрана, ни адреса. Планировщик
 * её читал и всегда получал пусто. Здесь — недостающая половина.
 *
 * Требует роль admin: предупреждение о закрытой зоне меняет решение человека
 * о выходе на маршрут, и заводить его может только тот, кто за это отвечает.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { alertInputSchema, createAlert, listAlerts } from '@/lib/safety/alerts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const includeInactive = new URL(request.url).searchParams.get('all') === '1';
  try {
    return NextResponse.json({ success: true, alerts: await listAlerts(includeInactive) });
  } catch (err) {
    console.error('[safety-alerts] список не отдан:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось прочитать предупреждения' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Тело запроса не разобрано' }, { status: 400 });
  }

  const parsed = alertInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Проверьте поля формы' },
      { status: 400 },
    );
  }

  try {
    const alert = await createAlert(parsed.data, auth.userId ?? null);
    return NextResponse.json({ success: true, alert }, { status: 201 });
  } catch (err) {
    // Отказ записи нельзя показать как «сохранено»: человек уйдёт уверенным,
    // что предупреждение висит, а его нет (§4.0).
    console.error('[safety-alerts] предупреждение не записано:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Предупреждение не сохранено' },
      { status: 500 },
    );
  }
}
