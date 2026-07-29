import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ routeId: string }> }

/**
 * GET /api/images/route/[routeId] — отдать изображение места из хранилища.
 *
 * Раньше эндпоинт АВТОГЕНЕРИРОВАЛ AI-картинку при её отсутствии. AI-картинки
 * чужих пейзажей больше не показываются (решение владельца 2026-07-17:
 * честный градиент вместо AI-фото), поэтому генерация убрана — только отдача
 * уже сохранённого (реальные wikimedia-фото и legacy-блобы). Нет — 404.
 */
export async function GET(_req: NextRequest, { params }: Props) {
  const { routeId } = await params;

  if (!/^[0-9a-f-]{36}$/.test(routeId)) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    // Порядок детерминированный: сначала реальные снимки (wikimedia/ручная
    // загрузка), потом legacy-блобы. Раньше без ORDER BY какая строка
    // попадалась первой — та и уходила, включая случаи, когда постер канала
    // выбирал этот URL ради wikimedia-фото, а эндпоинт отдавал другой блоб.
    const { rows } = await pool.query(
      `SELECT image_data, mime_type FROM ai_route_images
       WHERE route_id = $1
       ORDER BY CASE WHEN model IN ('wikimedia', 'manual-upload') THEN 0 ELSE 1 END,
                created_at DESC
       LIMIT 1`,
      [routeId],
    );

    if (rows.length > 0) {
      // Uint8Array, а не Buffer: с TS 5.9 Buffer<ArrayBufferLike> не проходит
      // в BodyInit. Копия байтов — честная цена за отсутствие каста.
      return new NextResponse(new Uint8Array(rows[0].image_data as Buffer), {
        headers: {
          'Content-Type': rows[0].mime_type as string,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Source': 'stored',
        },
      });
    }
  } catch {
    return new NextResponse('Image unavailable', { status: 503 });
  }

  return new NextResponse('Not found', { status: 404 });
}
