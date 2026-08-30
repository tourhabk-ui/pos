import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import crypto from 'crypto';
import path from 'path';

export const dynamic = 'force-dynamic';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

const CaptionSchema = z.string().trim().max(300).optional();

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { rows } = await pool.query(
    `SELECT id, url, caption, created_at
     FROM user_place_photos
     WHERE place_id = $1 AND status = 'approved'
     ORDER BY created_at DESC LIMIT 50`,
    [id],
  );
  return NextResponse.json({ success: true, data: rows });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req as never);
  if (auth instanceof NextResponse) return auth;

  const { id: placeId } = await params;

  // Verify place exists
  const placeRes = await pool.query('SELECT id FROM places WHERE id = $1 LIMIT 1', [placeId]);
  if (placeRes.rows.length === 0) {
    return NextResponse.json({ success: false, error: 'Место не найдено' }, { status: 404 });
  }

  // Rate limit: max 5 photos per user per place
  const countRes = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text as n FROM user_place_photos WHERE place_id = $1 AND user_id = $2`,
    [placeId, auth.userId],
  );
  if (parseInt(countRes.rows[0]?.n ?? '0') >= 5) {
    return NextResponse.json({ success: false, error: 'Максимум 5 фото на место' }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ success: false, error: 'Ожидается multipart/form-data' }, { status: 400 });
  }

  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ success: false, error: 'Поле file обязательно' }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json({ success: false, error: 'Только JPEG, PNG, WebP или HEIC' }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ success: false, error: 'Максимальный размер 10 МБ' }, { status: 400 });
  }

  const captionRaw = formData.get('caption');
  const caption = CaptionSchema.safeParse(typeof captionRaw === 'string' ? captionRaw : undefined);
  const captionValue = caption.success ? caption.data : undefined;

  // Без хранилища принимать фото НЕЛЬЗЯ, и это не придирка.
  //
  // Прежняя ветка «dev fallback» писала в базу выдуманный адрес
  // `/api/places/{id}/photos/{uuid}.jpg`, по которому нет ни одного роута, а
  // сами байты (`buf`) не сохраняла никуда — переменная просто не доходила до
  // записи. Турист при этом получал 201 и зелёное «Фото отправлено», админ
  // видел строку в очереди модерации, одобрял её — и одобрял пустоту: файла
  // не существовало с самого начала.
  //
  // Это ровно тот отказ, против которого написано правило третьего состояния
  // (CLAUDE.md 4.0): место, где нельзя сказать «не могу», отвечает «хорошо».
  // Отказ 503 хуже для показателей и лучше для человека: он не потеряет
  // единственный снимок, снятый в поле, поверив нашей галочке.
  if (!isS3Configured) {
    console.error(
      '[places/photos] хранилище не настроено, приём фото отключён; не заданы:',
      ['S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET']
        .filter((v) => !process.env[v])
        .join(', ') || 'переменные заданы, но isS3Configured ложно',
    );
    return NextResponse.json(
      { success: false, error: 'Загрузка фото сейчас недоступна — попробуйте позже' },
      { status: 503 },
    );
  }

  const ext = path.extname(file.name || '.jpg').toLowerCase() || '.jpg';
  const uid = crypto.randomUUID();
  const key = `user-photos/${placeId}/${uid}${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());

  let url: string;
  try {
    const result = await uploadToS3(key, buf, file.type);
    url = result.url;
  } catch (err) {
    // Хранилище настроено, но не приняло файл. Строку в очередь не заводим:
    // модерировать нечего, а «отправлено» было бы неправдой.
    console.error('[places/photos] S3 не принял файл:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить фото — попробуйте ещё раз' },
      { status: 502 },
    );
  }

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO user_place_photos (place_id, user_id, url, caption)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [placeId, auth.userId, url, captionValue ?? null],
  );

  return NextResponse.json({
    success: true,
    data: { id: rows[0].id, url, status: 'pending' },
    message: 'Фото отправлено на модерацию',
  }, { status: 201 });
}
