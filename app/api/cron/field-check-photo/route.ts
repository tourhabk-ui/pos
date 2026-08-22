/**
 * Снимок из полевой проверки — отдача байтов по id.
 *
 * Очередь (field-check-queue) отдаёт только ЧИСЛО снимков и их вес: класть
 * мегабайты в список — значит сделать список нечитаемым. Сам снимок берётся
 * здесь, по одному, и это главная улика проверки: фотография брода или
 * развилки говорит то, чего человек в поле не догадался написать словами.
 *
 * READ-ONLY. Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest) {
  if (!timingSafeCompare(getCronSecret(request), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  const id = (request.nextUrl.searchParams.get('id') ?? '').trim();
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: 'Нужен id снимка' }, { status: 400 });
  }

  // `meta=1` — размер и тип без байтов: пробе с раннера достаточно знать,
  // что снимок дошёл целым, а тянуть картинку в лог незачем.
  const metaOnly = request.nextUrl.searchParams.get('meta') === '1';

  try {
    const { rows } = await pool.query<{
      mime: string; byte_size: number; bytes: Buffer; check_id: string; created_at: string;
    }>(
      `SELECT mime, byte_size, bytes, check_id::text AS check_id, created_at::text AS created_at
       FROM route_field_check_photos WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ success: false, error: 'Снимок не найден' }, { status: 404 });
    }

    if (metaOnly) {
      return NextResponse.json({
        success: true,
        probe: 'field_check_photo_v1',
        id, check_id: row.check_id, mime: row.mime,
        byte_size: row.byte_size,
        // Байты в базе и заявленный размер могут разойтись только при
        // порче записи — тогда об этом надо знать, а не показывать снимок.
        stored_bytes: row.bytes.length,
        intact: row.bytes.length === row.byte_size,
        created_at: row.created_at,
      });
    }

    return new NextResponse(new Uint8Array(row.bytes), {
      status: 200,
      headers: {
        'Content-Type': row.mime,
        'Content-Length': String(row.bytes.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения снимка';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
