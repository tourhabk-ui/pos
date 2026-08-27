/**
 * POST /api/safety/reports/photo — снимок к наблюдению с экрана маршрута.
 *
 * Точное зеркало /api/field-check/photo (та же дисциплина, другой контур):
 * фотография принимается ОТДЕЛЬНЫМ запросом, по одной — очередь на телефоне
 * уходит по частям, сорвавшаяся отправка теряет один снимок, а не всё
 * наблюдение. Снимок уже сжат на телефоне (lib/images/shrink-photo, ~1280
 * px) — сервер не пережимает, но проверяет размер и тип.
 *
 * Байты уезжают в S3, если хранилище настроено; иначе — байтами в базу
 * (trail_report_photos.bytes): терять улику из-за нашей конфигурации нельзя.
 * Публичность — по той же причине, что у самого /api/safety/reports:
 * наблюдения анонимны по дизайну, лимиты держит rate-limit родителя и
 * жёсткий потолок размера здесь.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Потолок одного снимка после сжатия. Больше — значит сжатие не сработало. */
const MAX_BYTES = 1_200_000;

const BodySchema = z.object({
  report_id: z.string().uuid(),
  mime: z.enum(['image/jpeg', 'image/webp', 'image/png']),
  /** base64 без префикса data:. */
  data: z.string().min(16).max(2_000_000),
});

export async function POST(request: NextRequest) {
  let data: z.infer<typeof BodySchema>;
  try {
    data = BodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues[0]?.message ?? 'Некорректный снимок'
      : 'Некорректный снимок';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(data.data, 'base64');
  } catch {
    return NextResponse.json({ success: false, error: 'Снимок не читается' }, { status: 400 });
  }
  if (buf.length === 0) {
    return NextResponse.json({ success: false, error: 'Пустой снимок' }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) {
    return NextResponse.json(
      { success: false, error: 'Снимок слишком большой — пересжать на телефоне' },
      { status: 413 },
    );
  }

  try {
    const ext = data.mime === 'image/png' ? 'png' : data.mime === 'image/webp' ? 'webp' : 'jpg';
    let s3Url: string | null = null;
    let s3Key: string | null = null;
    let stored: 's3' | 'db' = 'db';

    if (isS3Configured) {
      try {
        const up = await uploadToS3(
          `trail-reports/${data.report_id}/${crypto.randomUUID()}.${ext}`,
          buf,
          data.mime,
        );
        s3Url = up.url;
        s3Key = up.key;
        stored = 's3';
      } catch (e) {
        // Хранилище отказало — молчать нельзя (§4.0), но и терять снимок
        // из-за чужого сбоя незачем: падаем в базу.
        console.error('[safety/reports/photo] S3 отказал, кладу в базу:',
          e instanceof Error ? e.message : e);
      }
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trail_report_photos (report_id, mime, bytes, byte_size, s3_url, s3_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [data.report_id, data.mime, s3Url === null ? buf : null, buf.length, s3Url, s3Key],
    );
    return NextResponse.json({ success: true, id: rows[0]?.id ?? null, stored });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи снимка';
    // Наблюдения с таким id нет — снимок без наблюдения бессмыслен,
    // это ошибка вызывающего, а не сбой.
    const isFk = /foreign key|trail_reports/i.test(message);
    return NextResponse.json(
      { success: false, error: isFk ? 'Наблюдение не найдено' : message },
      { status: isFk ? 400 : 502 },
    );
  }
}
