/**
 * GET /api/cron/place-audit?q=<часть имени> — найти places по имени
 * НЕЗАВИСИМО от видимости и статуса слияния. Bearer CRON_SECRET.
 * Только читает.
 *
 * Зачем. Публичный поиск (/api/search) намеренно прячет скрытые и слитые
 * записи — это правильно для витрины, но оставляет открытым вопрос
 * «маршрут есть, места не находится — его правда нет или оно скрыто?»
 * без инструмента для ответа. Разница между «нет совсем» и «есть, но
 * is_visible=false» — это разница между «завести место» и «просто
 * показать» (§4.0: не знаю — не приговор).
 *
 * Заодно отдаёт location_safety_profile — тот же профиль, который
 * places-dedup после слияния помечает «сверить» без возможности увидеть
 * поля: этот роут и есть способ сверить.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface PlaceAuditRow {
  id: string;
  name: string;
  location_type: string | null;
  lat: number | null;
  lng: number | null;
  is_visible: boolean;
  merged_into_id: string | null;
  merged_into_name: string | null;
  description: string | null;
  has_safety: boolean;
  hazard_types: string[] | null;
  nearest_medical_km: number | null;
  sat_communicator_required: boolean | null;
  phone_ranger_mches: string | null;
  medical_info: string | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) {
    return NextResponse.json(
      { success: false, error: 'нужен параметр q — часть имени, минимум 2 символа' },
      { status: 400 },
    );
  }

  try {
    const { rows } = await pool.query<PlaceAuditRow>(
      `SELECT p.id::text AS id, p.name, p.location_type, p.lat, p.lng,
              p.is_visible, p.merged_into_id::text AS merged_into_id, keep.name AS merged_into_name,
              LEFT(p.description, 200) AS description,
              (sp.agent_route_id IS NOT NULL) AS has_safety,
              sp.hazard_types, sp.nearest_medical_km, sp.sat_communicator_required,
              sp.phone_ranger_mches, sp.medical_info
         FROM places p
         LEFT JOIN places keep ON keep.id = p.merged_into_id
         LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
        WHERE p.name ILIKE $1
        ORDER BY p.name
        LIMIT 30`,
      [`%${q}%`],
    );

    return NextResponse.json({ success: true, total: rows.length, places: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка поиска мест';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
