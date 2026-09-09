/**
 * lib/safety/registration-mark.ts
 *
 * Открыть регистрацию маршрута для отметки: найти, проверить право, вернуть.
 *
 * Отметок на регистрации три, и они разные:
 *   возврат          — группа вышла, маршрут закрыт (`completed_at`);
 *   «мы в порядке»   — группа ещё в пути (`checkin_confirmed_at`), отодвигает шаг;
 *   «сообщил в МЧС»  — контакт сам позвонил в 112 (`mchs_informed_at`).
 *
 * Разные они по смыслу, но вход у всех трёх один и тот же, поэтому находится
 * здесь: иначе правило доступа окажется переписанным трижды и разойдётся.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { verifyAuth } from '@/lib/auth';
import { checkRegistrationGate } from '@/lib/safety/registration-gate';

export interface MarkableRegistration {
  id: string;
  route_name: string;
  leader_name: string;
  leader_phone: string;
  user_id: string | null;
  completed_at: string | null;
  checkin_confirmed_at: string | null;
  mchs_informed_at: string | null;
}

export type RegistrationAccess =
  | { ok: true; reg: MarkableRegistration; via: 'owner' | 'leader_phone' }
  | { ok: false; status: number; error: string; reason: 'not_found' | 'phone_required' | 'phone_mismatch' };

export async function openRegistrationForMark(
  request: NextRequest,
  registrationId: string,
  providedPhone: string | null | undefined,
): Promise<RegistrationAccess> {
  const auth = await verifyAuth(request).catch(() => ({ isAuthenticated: false, userId: null }));

  const { rows } = await query<MarkableRegistration>(
    `SELECT id, route_name, leader_name, leader_phone, user_id,
            completed_at, checkin_confirmed_at, mchs_informed_at
       FROM route_registrations
      WHERE id = $1`,
    [registrationId],
  );

  if (rows.length === 0) {
    return { ok: false, status: 404, error: 'Маршрут не найден', reason: 'not_found' };
  }

  const reg = rows[0];
  const gate = checkRegistrationGate({
    authedUserId: auth.isAuthenticated ? auth.userId ?? null : null,
    registrationUserId: reg.user_id,
    leaderPhone: reg.leader_phone,
    providedPhone,
  });

  if (!gate.ok) {
    return { ok: false, status: 403, error: gate.message, reason: gate.reason };
  }

  return { ok: true, reg, via: gate.via };
}

/**
 * Отказ отдаётся клиенту вместе с ПРИЧИНОЙ: «номер не дали» и «номер не тот» —
 * разные состояния, и страница показывает по ним разное (поле ввода против
 * сообщения об ошибке). Слить их в общее «403 запрещено» значит увести
 * человека в тупик.
 */
export function markDenied(access: Extract<RegistrationAccess, { ok: false }>): NextResponse {
  return NextResponse.json(
    { success: false, error: access.error, reason: access.reason },
    { status: access.status },
  );
}
