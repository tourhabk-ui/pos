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
 *
 * ДВА ХРАНИЛИЩА НА ВРЕМЯ ПЕРЕЕЗДА (миграция 944). Снимки переезжают из базы
 * в S3 партиями: замер 08.09 показал 439,6 МБ бинарей в PostgreSQL — больше
 * половины всей базы. Пока переезд идёт, у строки может быть либо ссылка,
 * либо байты, и порядок такой:
 *
 *   s3_url есть   → редирект на объект: байты не идут через Node вовсе;
 *   s3_url пуст   → отдаём image_data, как отдавали всегда;
 *   ни того, ни другого → 404, снимка нет.
 *
 * Порядок не переставлять: строка с обоими полями — это снимок, чей объект
 * уже подтверждён, а байты ещё не убраны. Отдавать в этом случае байты не
 * ошибка, но лишняя работа базе, ради снятия которой переезд и затеян.
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
      `SELECT image_data, mime_type, s3_url FROM ai_route_images
       WHERE route_id = $1
       ORDER BY CASE WHEN model IN ('wikimedia', 'manual-upload') THEN 0 ELSE 1 END,
                created_at DESC
       LIMIT 1`,
      [routeId],
    );

    const row = rows[0];

    if (row?.s3_url) {
      // Снимок уже в объектном хранилище. Отдаём ссылкой, а не телом: тот же
      // адрес, тот же кеш, но база и Node из пути исчезают.
      return NextResponse.redirect(row.s3_url as string, {
        status: 302,
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Source': 's3',
        },
      });
    }

    if (row?.image_data) {
      // Uint8Array, а не Buffer: с TS 5.9 Buffer<ArrayBufferLike> не проходит
      // в BodyInit. Копия байтов — честная цена за отсутствие каста.
      return new NextResponse(new Uint8Array(row.image_data as Buffer), {
        headers: {
          'Content-Type': row.mime_type as string,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Source': 'stored',
        },
      });
    }
  } catch (err) {
    // Молчащий catch превращал поломку хранилища в «картинки нет»: 503 без
    // единой строки в логе, и чинить нечего (§4.0 — отказ не глушится).
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[images] снимок не выбрался:', routeId, msg);
    return new NextResponse('Image unavailable', { status: 503 });
  }

  return new NextResponse('Not found', { status: 404 });
}
