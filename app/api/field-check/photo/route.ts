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
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';

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
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO route_field_check_photos (check_id, mime, bytes, byte_size)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text AS id`,
      [data.check_id, data.mime, buf, buf.length],
    );
    return NextResponse.json({ success: true, id: rows[0]?.id ?? null });
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
