import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ arkId: string; position: string }> }

/**
 * GET /api/images/place-gallery/[arkId]/[position] — снимок галереи места.
 *
 * Герой места лежит в `ai_route_images` и отдаётся `/api/images/route/[id]`.
 * Вторая и последующие фотографии — в `place_gallery_photos` (миграция 968),
 * и отдаются отсюда. Разделение не украшение: у `ai_route_images` уникальный
 * индекс по `route_id`, снять который нельзя — `ON CONFLICT (route_id)` стоит
 * в десяти уже применённых миграциях, а те идут только вперёд.
 *
 * Порядок хранилищ — тот же, что у героя, и по той же причине (миграция 944,
 * переезд байтов в S3):
 *
 *   s3_url есть  → редирект на объект, база и Node из пути уходят;
 *   s3_url пуст  → отдаём байты;
 *   ни того, ни другого → 404.
 *
 * Строки без обоих полей в таблице быть не может — это держит CHECK
 * `place_gallery_photos_has_image`; 404 здесь на случай, если места или
 * позиции нет вовсе.
 */
export async function GET(_req: NextRequest, { params }: Props) {
  const { arkId, position } = await params;

  if (!/^[0-9a-f-]{36}$/.test(arkId)) {
    return new NextResponse('Not found', { status: 404 });
  }
  // Позиция — целое от 1: ноль это герой, он в другой таблице и по другому
  // адресу. Разбор строгий, потому что число идёт прямо в запрос параметром.
  const pos = Number(position);
  if (!Number.isInteger(pos) || pos < 1 || pos > 100) {
    return new NextResponse('Not found', { status: 404 });
  }

  try {
    const { rows } = await pool.query<{
      image_data: Buffer | null; mime_type: string; s3_url: string | null;
    }>(
      `SELECT image_data, mime_type, s3_url
         FROM place_gallery_photos
        WHERE ark_id = $1::uuid AND position = $2
        LIMIT 1`,
      [arkId, pos],
    );

    const row = rows[0];

    if (row?.s3_url) {
      return NextResponse.redirect(row.s3_url, {
        status: 302,
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Source': 's3',
        },
      });
    }

    if (row?.image_data) {
      // Uint8Array, а не Buffer: с TS 5.9 Buffer<ArrayBufferLike> не проходит
      // в BodyInit. Та же причина, что у героя.
      return new NextResponse(new Uint8Array(row.image_data), {
        headers: {
          'Content-Type': row.mime_type,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Source': 'stored',
        },
      });
    }

    return new NextResponse('Not found', { status: 404 });
  } catch (err) {
    // Отказ хранилища не выдаётся за «снимка нет»: 503 и строка в логе.
    // Молчащий catch здесь уже стоил бы того же, что стоил у героя (§4.0).
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[gallery] снимок не выбрался:', arkId, pos, msg);
    return new NextResponse('Image unavailable', { status: 503 });
  }
}
