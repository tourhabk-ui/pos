/**
 * Wikimedia Commons — реальные фото места с ревью админом.
 *
 * GET  /api/admin/places/[id]/wiki-candidates
 *   Ищет свободно-лицензированные фото рядом с координатами места и возвращает
 *   кандидатов (без сохранения). Админ выбирает подходящий кадр.
 *
 * POST /api/admin/places/[id]/wiki-candidates
 *   Скачивает выбранное фото, режет sharp до 1280x720, кладёт в ai_route_images
 *   с атрибуцией (model=wikimedia). UPSERT — заменяет прежнее фото места.
 */

import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { searchCommonsPhotos, downloadPhotoBytes } from '@/lib/services/ingest/wikimedia-photos';

export const dynamic = 'force-dynamic';

const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const JPEG_QUALITY = 85;

interface Props { params: Promise<{ id: string }> }

const UUID_RE = /^[0-9a-f-]{36}$/i;

async function resolvePlace(placeId: string) {
  const { rows } = await pool.query<{ ark_id: string | null; name: string; lat: string | null; lng: string | null }>(
    `SELECT ark_id, name, lat, lng FROM places WHERE id = $1 LIMIT 1`,
    [placeId],
  );
  return rows[0] ?? null;
}

export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id: placeId } = await params;
  if (!UUID_RE.test(placeId)) {
    return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });
  }

  const place = await resolvePlace(placeId);
  if (!place) return NextResponse.json({ error: 'Место не найдено' }, { status: 404 });

  const lat = place.lat != null ? parseFloat(place.lat) : NaN;
  const lng = place.lng != null ? parseFloat(place.lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'У места нет координат — поиск фото невозможен' }, { status: 422 });
  }

  const { searchParams } = new URL(request.url);
  const radiusM = Math.min(Math.max(Number(searchParams.get('radius')) || 3000, 500), 10_000);

  try {
    const candidates = await searchCommonsPhotos(lat, lng, { radiusM, limit: 12 });
    return NextResponse.json({ ok: true, place: place.name, lat, lng, radiusM, candidates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка поиска на Wikimedia Commons';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}

const StoreSchema = z.object({
  imageUrl: z.string().url(),
  /**
   * Заменить главное фото вместо добавления в галерею (15.09).
   *
   * Владелец: «почему в месте только одна фотография? Сложно судить о месте
   * по одному фото». Поиск на Wikimedia отдаёт до ДВЕНАДЦАТИ кандидатов, а
   * сохранялся ровно один — `ON CONFLICT (route_id) DO UPDATE` переписывал
   * прежний. Каждый следующий выбранный снимок стирал предыдущий, и больше
   * одной фотографии у места не могло появиться в принципе.
   *
   * Правило то же, что у ручной загрузки (14.09): нет главного — снимок
   * идёт главным; главное есть — снимок идёт в галерею. Замена возможна, но
   * её надо сказать вслух.
   */
  replaceHero: z.boolean().optional().default(false),
  author: z.string().max(500).optional().default(''),
  license: z.string().max(120).optional().default('CC'),
  licenseUrl: z.string().url().or(z.literal('')).optional().default(''),
  sourceUrl: z.string().url().or(z.literal('')).optional().default(''),
});

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const { id: placeId } = await params;
  if (!UUID_RE.test(placeId)) {
    return NextResponse.json({ error: 'Неверный ID места' }, { status: 400 });
  }

  const place = await resolvePlace(placeId);
  if (!place) return NextResponse.json({ error: 'Место не найдено' }, { status: 404 });
  if (!place.ark_id) {
    return NextResponse.json({ error: 'У места нет ark_id — невозможно привязать фото' }, { status: 422 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Неверный JSON' }, { status: 400 });
  }

  const parsed = StoreSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Некорректные данные фото', details: parsed.error.flatten() }, { status: 400 });
  }
  const { imageUrl, author, license, licenseUrl, sourceUrl, replaceHero } = parsed.data;

  // Скачиваем только с Wikimedia (upload.wikimedia.org) — не даём качать произвольные URL.
  let host: string;
  try {
    host = new URL(imageUrl).host;
  } catch {
    return NextResponse.json({ error: 'Некорректный URL фото' }, { status: 400 });
  }
  if (!/(^|\.)wikimedia\.org$/.test(host) && !/(^|\.)wikipedia\.org$/.test(host)) {
    return NextResponse.json({ error: 'Разрешены только фото с Wikimedia Commons' }, { status: 400 });
  }

  let processed: Buffer;
  try {
    const input = await downloadPhotoBytes(imageUrl);
    processed = await sharp(input, { failOn: 'truncated' })
      .rotate()
      .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка обработки изображения';
    return NextResponse.json({ error: `Не удалось загрузить/обработать фото: ${msg}` }, { status: 502 });
  }

  // Куда кладём: главным или в галерею. Решает НАЛИЧИЕ главного, как и у
  // ручной загрузки — два разных правила для двух путей разошлись бы при
  // первой же правке.
  const heroRow = await pool.query(
    `SELECT 1 FROM ai_route_images WHERE route_id = $1 LIMIT 1`,
    [place.ark_id],
  );
  const hasHero = (heroRow.rowCount ?? 0) > 0;

  if (hasHero && !replaceHero) {
    // Галерея: следующая свободная позиция. Позиция считается отдельным
    // запросом, а не `INSERT ... SELECT MAX(...)`: у той формы параметрам
    // негде взять якорь типа, и она отвечает 42P08 всегда (§4, случай 24.08).
    let position = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = await pool.query<{ next: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next
           FROM place_gallery_photos WHERE ark_id = $1`,
        [place.ark_id],
      );
      position = Number(next.rows[0]?.next ?? 1);
      try {
        await pool.query(
          `INSERT INTO place_gallery_photos
             (ark_id, position, image_data, mime_type, width, height,
              author, license, license_url, source_url)
           VALUES ($1, $2, $3, 'image/jpeg', $4, $5, $6, $7, $8, $9)`,
          [
            place.ark_id, position, processed, TARGET_WIDTH, TARGET_HEIGHT,
            author || null, license || null, licenseUrl || null, sourceUrl || null,
          ],
        );
        break;
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === '23505' && attempt < 2) continue;
        // Отказ не глушится: «не смог записать» не выдаётся за «записал».
        console.error('[wiki-photo] снимок не лёг в галерею:', place.ark_id, position, code ?? err);
        return NextResponse.json(
          { error: 'Не удалось сохранить снимок в галерею. Попробуйте ещё раз.' },
          { status: 503 },
        );
      }
    }

    return NextResponse.json({
      ok: true,
      placeId,
      arkId: place.ark_id,
      slot: 'gallery',
      position,
      sizeKb: Math.round(processed.length / 1024),
      attribution: { author, license, licenseUrl, sourceUrl },
      url: `/api/images/place-gallery/${place.ark_id}/${position}?t=${Date.now()}`,
    });
  }

  await pool.query(
    `INSERT INTO ai_route_images
       (route_id, image_data, mime_type, prompt, model, width, height, source_url, author, license, license_url)
     VALUES ($1, $2, 'image/jpeg', $3, 'wikimedia', $4, $5, $6, $7, $8, $9)
     ON CONFLICT (route_id) DO UPDATE
       SET image_data  = EXCLUDED.image_data,
           mime_type   = EXCLUDED.mime_type,
           prompt      = EXCLUDED.prompt,
           model       = EXCLUDED.model,
           width       = EXCLUDED.width,
           height      = EXCLUDED.height,
           source_url  = EXCLUDED.source_url,
           author      = EXCLUDED.author,
           license     = EXCLUDED.license,
           license_url = EXCLUDED.license_url,
           created_at  = now()`,
    [
      place.ark_id,
      processed,
      `Wikimedia Commons photo for ${place.name}`,
      TARGET_WIDTH,
      TARGET_HEIGHT,
      sourceUrl || null,
      author || null,
      license || null,
      licenseUrl || null,
    ],
  );

  return NextResponse.json({
    ok: true,
    placeId,
    arkId: place.ark_id,
    slot: 'hero',
    sizeKb: Math.round(processed.length / 1024),
    attribution: { author, license, licenseUrl, sourceUrl },
    url: `/api/images/route/${place.ark_id}?t=${Date.now()}`,
  });
}
