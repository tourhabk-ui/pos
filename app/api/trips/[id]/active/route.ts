/**
 * POST /api/trips/[id]/active — включить или выключить режим «я в поездке».
 *
 * Главная переключается в режим маршрута только этим вызовом. Не датами:
 * поездка переносится, отменяется, начинается раньше — и автопереключение
 * уверенно показало бы человеку режим, в котором он не находится. На слое
 * безопасности догадка хуже вопроса.
 *
 * Владение поездкой проверяется на сервере: клиент присылает только id.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import type { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({
  active: z.boolean(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json(
      { success: false, error: 'Неверный идентификатор поездки' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: 'Неверный формат запроса' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.errors[0]?.message ?? 'Ошибка валидации' } as ApiResponse<null>,
      { status: 400 },
    );
  }

  // Поездка должна существовать, быть живой и принадлежать этому человеку.
  // Проверяем даже при выключении: иначе чужой id гасил бы чей-то режим.
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM user_trips
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [id, auth.userId],
  );
  if (rows.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Поездка не найдена' } as ApiResponse<null>,
      { status: 404 },
    );
  }

  if (parsed.data.active) {
    // Колонка одна на пользователя — «не более одной активной поездки»
    // выполняется by construction, гасить прежнюю отдельным запросом не нужно.
    await pool.query(
      `UPDATE users SET active_trip_id = $2, active_trip_since = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [auth.userId, id],
    );
  } else {
    // Выключаем только если гасят ИМЕННО текущую активную: иначе вкладка со
    // старым состоянием погасит режим, включённый на другом устройстве.
    await pool.query(
      `UPDATE users SET active_trip_id = NULL, active_trip_since = NULL, updated_at = NOW()
        WHERE id = $1 AND active_trip_id = $2`,
      [auth.userId, id],
    );
  }

  return NextResponse.json({
    success: true,
    data: { tripId: id, active: parsed.data.active },
  } as ApiResponse<unknown>);
}
