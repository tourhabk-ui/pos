/**
 * POST /api/field-check/photo — снимок к полевой проверке.
 *
 * Фотография принимается ОТДЕЛЬНЫМ запросом, по одной: так очередь на
 * телефоне уходит по частям и не упирается в лимит тела запроса, а
 * сорвавшаяся отправка теряет один снимок, а не весь выход.
 *
 * Снимок уже сжат на телефоне (~1280 px) — сервер его не пережимает, но
 * проверяет размер и тип: сюда попадает то, что показывается человеку,
 * решающему судьбу записи.
 *
 * Байты уезжают в S3 (владелец 22.08: «для больших файлов есть S3»).
 * Изначально я клал их прямо в таблицу — неправильное место для улики:
 * снимки растят базу, едут в каждый дамп и в каждую реплику, а отдаются
 * прикладным роутом вместо раздачи хранилища. У платформы S3 уже несёт
 * снимки мест, туров и отзывов.
 *
 * Хранилище не настроено — снимок всё равно принимается, байтами в базу,
 * как раньше. Отказать здесь значило бы потерять улику, которую человек
 * принёс с перевала, из-за нашей конфигурации; какой путь сработал,
 * видно по тому, какое из двух полей заполнено.
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
  check_id: z.string().uuid(),
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
          `field-check/${data.check_id}/${crypto.randomUUID()}.${ext}`,
          buf,
          data.mime,
        );
        s3Url = up.url;
        s3Key = up.key;
        stored = 's3';
      } catch (e) {
        // Хранилище ответило отказом. Молчать нельзя — иначе «снимков нет»
        // станет неотличимо от «снимки не доехали» (§4.0); но и терять
        // улику из-за чужого сбоя незачем, поэтому падаем в базу.
        console.error('[field-check/photo] S3 отказал, кладу в базу:',
          e instanceof Error ? e.message : e);
      }
    }

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO route_field_check_photos (check_id, mime, bytes, byte_size, s3_url, s3_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [data.check_id, data.mime, s3Url === null ? buf : null, buf.length, s3Url, s3Key],
    );
    return NextResponse.json({ success: true, id: rows[0]?.id ?? null, stored });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи снимка';
    // Проверки с таким id нет — фотография без проверки бессмысленна,
    // и это ошибка вызывающего, а не сбой.
    const isFk = /foreign key|route_field_checks/i.test(message);
    return NextResponse.json(
      { success: false, error: isFk ? 'Проверка не найдена' : message },
      { status: isFk ? 400 : 502 },
    );
  }
}
