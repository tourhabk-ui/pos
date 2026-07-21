/**
 * GET /api/admin/health/emergency-contacts
 *
 * Сверка официальных телефонов (issue #366): справочник по источникам
 * (код / портал visitkamchatka / старый сид), расхождения внутри
 * назначений и похожие номера (вероятные опечатки) — список «на сверку
 * с Артёмом». Номера в SOS-файлах этим эндпоинтом НЕ меняются.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { computeEmergencyContactsHealth } from '@/lib/services/safety/emergency-contacts';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const health = await computeEmergencyContactsHealth();
    return NextResponse.json({ success: true, data: health });
  } catch {
    return NextResponse.json(
      { success: false, error: 'Не удалось собрать сверку телефонов' },
      { status: 500 }
    );
  }
}
