/**
 * GET/PUT /api/hub/operator/settings/auto-confirm — настройка оператора
 * «подтверждать брони автоматически» (решение владельца 04.10).
 *
 * Включённая, она подтверждает бронь сразу, если дата есть в расписании
 * оператора и места есть (lib/bookings/auto-confirm) — турист платит без
 * ожидания. Хранится в `operator_settings.auto_confirm_bookings` по аккаунту
 * оператора (`user_id`); читается через `partners.user_id`.
 *
 * AUTH: requireOperator — настройку меняет только сам оператор, своим входом.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { query } from '@/lib/database';

export const dynamic = 'force-dynamic';

const PutSchema = z.object({ enabled: z.boolean({ message: 'Укажите, включить или выключить' }) });

export async function GET(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const partnerId = await getOperatorPartnerId(auth.userId);
  if (!partnerId) return NextResponse.json({ error: 'Профиль оператора не найден' }, { status: 403 });
  try {
    const { rows } = await query<{ enabled: boolean }>(
      `SELECT COALESCE(auto_confirm_bookings, false) AS enabled FROM operator_settings WHERE user_id = $1`,
      [auth.userId],
    );
    return NextResponse.json({ success: true, enabled: rows[0]?.enabled === true });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[operator/settings/auto-confirm] чтение не прошло:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ error: 'Не удалось прочитать настройку' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireOperator(request);
  if (auth instanceof NextResponse) return auth;
  const partnerId = await getOperatorPartnerId(auth.userId);
  if (!partnerId) return NextResponse.json({ error: 'Профиль оператора не найден' }, { status: 403 });

  const parsed = PutSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  try {
    const { rows } = await query<{ enabled: boolean }>(
      `INSERT INTO operator_settings (user_id, auto_confirm_bookings, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET auto_confirm_bookings = EXCLUDED.auto_confirm_bookings, updated_at = NOW()
       RETURNING auto_confirm_bookings AS enabled`,
      [auth.userId, parsed.data.enabled],
    );
    return NextResponse.json({ success: true, enabled: rows[0]?.enabled === true });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[operator/settings/auto-confirm] запись не прошла:', `sqlstate=${e?.code ?? 'нет'}`, e?.message ?? String(err));
    return NextResponse.json({ error: 'Не удалось сохранить настройку' }, { status: 500 });
  }
}
