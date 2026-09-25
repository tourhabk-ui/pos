import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAdmin } from '@/lib/auth/middleware';

export const dynamic = 'force-dynamic';

/**
 * POST /api/admin/places/[id]/visitor-limit — природоохранный лимит места.
 *
 * Единственный писатель places.visitor_limit_per_day (миграция 1017).
 * Читает его планировщик (lib/planner/place-load → flow-balance): место
 * сверх лимита на даты поездки не предлагается.
 *
 * Число без источника не принимается — ни здесь, ни в базе (CHECK
 * places_visitor_limit_has_source): лимит, у которого не названо, чья это
 * норма, — выдумка, по которой людям отказывают (§4.0). `limit: null`
 * снимает лимит; причина обязательна и тогда — снятие тоже решение.
 * Старое значение возвращается в ответе: это откат.
 */

const BodySchema = z.object({
  limit: z.number().int('Лимит — целое число людей в сутки').min(1, 'Лимит — не меньше 1').max(100000, 'Лимит — не больше 100 000').nullable(),
  source: z.string().trim().min(8, 'Назовите источник нормы: приказ парка, квота заповедника, решение владельца — не короче 8 символов').max(500),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const { id } = await params;
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' } as ApiResponse<null>,
        { status: 400 }
      );
    }
    const { limit, source } = parsed.data;

    // Карточка места принимает и places.id, и ark_id — здесь так же.
    const result = await query<{
      id: string; name: string;
      old_limit: number | null; old_source: string | null;
      new_limit: number | null; new_source: string | null;
    }>(
      `WITH old AS (
         SELECT id, visitor_limit_per_day, visitor_limit_source
           FROM places WHERE id::text = $1 OR ark_id::text = $1 LIMIT 1
       )
       UPDATE places p
          SET visitor_limit_per_day = $2::int,
              visitor_limit_source  = $3::text,
              visitor_limit_set_at  = NOW()
         FROM old
        WHERE p.id = old.id
       RETURNING p.id, p.name,
                 old.visitor_limit_per_day AS old_limit, old.visitor_limit_source AS old_source,
                 p.visitor_limit_per_day AS new_limit, p.visitor_limit_source AS new_source`,
      [id, limit, source]
    );
    if (result.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Место не найдено' } as ApiResponse<null>, { status: 404 });
    }
    const r = result.rows[0];
    return NextResponse.json({
      success: true,
      data: {
        place: r.name,
        placeId: r.id,
        limit: r.new_limit,
        source: r.new_source,
        previous: { limit: r.old_limit, source: r.old_source },
      },
    } as ApiResponse<unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string } | null)?.code ?? '-';
    console.error(`[admin/visitor-limit] не записалось (SQLSTATE ${code}):`, message);
    return NextResponse.json(
      { success: false, error: 'Не удалось записать лимит. Попробуйте позже.' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
