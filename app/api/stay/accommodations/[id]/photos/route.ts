import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAccommodationAccess } from '@/lib/auth/stay-helpers';
import crypto from 'crypto';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * Фото объекта размещения (владелец). Байты грузятся существующим
 * POST /api/upload (S3/production, public/uploads в dev) — сюда приходит
 * готовый URL. Паттерн — как у фото туров оператора: assets с
 * sha256-дедупом + связка accommodation_assets. Фото объекта видны
 * на витрине (листинг и детальная уже читают accommodation_assets).
 */

const AddPhotoSchema = z.object({
  url: z.string().url('URL фотографии обязателен').or(
    // dev-fallback /api/upload отдаёт относительный путь /uploads/...
    z.string().regex(/^\/uploads\/[\w.-]+$/, 'URL фотографии обязателен')
  ),
  alt: z.string().max(255).optional(),
  mimeType: z.string().max(100).optional(),
  size: z.number().int().min(0).optional(),
});

// ─── GET /api/stay/accommodations/[id]/photos ─────────────────────────────────

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const authOrResponse = await requireAccommodationAccess(request, id);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.url, a.alt, a.created_at
       FROM assets a
       JOIN accommodation_assets aa ON aa.asset_id = a.id
       WHERE aa.accommodation_id = $1
       ORDER BY a.created_at ASC`,
      [id]
    );

    return NextResponse.json({
      success: true,
      data: { photos: rows.map(r => ({ id: r.id, url: r.url, alt: r.alt, createdAt: r.created_at })) },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при получении фотографий' }, { status: 500 });
  }
}

// ─── POST /api/stay/accommodations/[id]/photos ────────────────────────────────

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const authOrResponse = await requireAccommodationAccess(request, id);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = AddPhotoSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { url, alt, mimeType, size } = parsed.data;

  try {
    // sha256 по URL — дедуп общих ассетов (как у тур-фото)
    const sha256 = crypto.createHash('sha256').update(url).digest('hex');

    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM assets WHERE sha256 = $1`,
      [sha256]
    );

    let assetId: string;
    if (existing.rows.length > 0) {
      assetId = existing.rows[0].id;
    } else {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO assets (url, mime_type, sha256, size, alt)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [url, mimeType ?? 'image/jpeg', sha256, size ?? 0, alt ?? '']
      );
      assetId = inserted.rows[0].id;
    }

    await pool.query(
      `INSERT INTO accommodation_assets (accommodation_id, asset_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [id, assetId]
    );

    return NextResponse.json(
      { success: true, data: { id: assetId, url }, message: 'Фотография добавлена' },
      { status: 201 }
    );
  } catch {
    return NextResponse.json({ success: false, error: 'Ошибка при добавлении фотографии' }, { status: 500 });
  }
}
