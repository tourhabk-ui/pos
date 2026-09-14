import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { ApiResponse } from '@/types';
import { JWTPayload } from '@/lib/auth/jwt';

export const dynamic = 'force-dynamic';

/**
 * `make_hero` — сделать снимок туриста ГЛАВНЫМ фото карточки места
 * (владелец 14.09: «давай-ка это разрешим»).
 *
 * До этого одобренный снимок попадал только в блок «Сняли туристы», а герой
 * карточки брался из `ai_route_images`, куда одобрение ничего не копировало.
 * Разделение было осознанным — не выдавать любительский кадр за карточное
 * фото, — но оно не оставляло ВЫБОРА: даже владелец, снявший место сам, не
 * мог поставить свой кадр на карточку иначе как загрузив тот же файл второй
 * раз через админку места.
 *
 * Байты не копируются: у `ai_route_images` есть `s3_url`, и раздача
 * (`/api/images/route/[routeId]`) отдаёт его редиректом. Переносится ссылка.
 *
 * АВТОР НЕ ПОДСТАВЛЯЕТСЯ САМ ЗА ЧУЖОГО ЧЕЛОВЕКА. Имя туриста под главным
 * фото — публикация персональных данных, на которую он не подписывался,
 * загружая снимок в блок «сняли туристы». Поэтому: свой снимок админ
 * подписывает своим именем автоматически, чужой — только явным `author` в
 * теле, то есть решением человека, а не умолчанием кода.
 */
const PatchSchema = z.object({
  action: z.enum(['approve', 'reject', 'make_hero']),
  /** Чем подписать главное фото. Обязателен для ЧУЖОГО снимка. */
  author: z.string().trim().min(1).max(200).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const adminOrResponse = await requireAdmin(request);
    if (adminOrResponse instanceof NextResponse) return adminOrResponse;

    const admin = adminOrResponse as JWTPayload;
    const { id } = await params;

    const body: unknown = await request.json();
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0].message } satisfies ApiResponse<null>,
        { status: 400 }
      );
    }

    if (parsed.data.action === 'make_hero') {
      return await makeHero(id, admin, parsed.data.author ?? null);
    }

    const newStatus = parsed.data.action === 'approve' ? 'approved' : 'rejected';

    const result = await pool.query(
      `UPDATE user_place_photos
         SET status = $1, reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $3
       RETURNING id`,
      [newStatus, admin.userId, id]
    );

    if (result.rowCount === 0) {
      return NextResponse.json(
        { success: false, error: 'Фото не найдено' } satisfies ApiResponse<null>,
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true } satisfies ApiResponse<null>);
  } catch {
    return NextResponse.json(
      { success: false, error: 'Ошибка при обновлении статуса фото' } satisfies ApiResponse<null>,
      { status: 500 }
    );
  }
}

/**
 * Перенести снимок туриста в герои карточки.
 *
 * Одобрение идёт ВМЕСТЕ с переносом: снимок на карточке и «ждёт проверки» —
 * противоречие, а два действия подряд оставили бы окно, в котором фото уже
 * главное, но по данным ещё непроверенное.
 */
async function makeHero(
  photoId: string,
  admin: JWTPayload,
  authorOverride: string | null,
): Promise<NextResponse> {
  const { rows } = await pool.query<{
    url: string; user_id: string; ark_id: string | null; uploader_name: string | null;
  }>(
    `SELECT ph.url, ph.user_id::text AS user_id, p.ark_id::text AS ark_id, u.name AS uploader_name
       FROM user_place_photos ph
       JOIN places p ON p.id = ph.place_id
       LEFT JOIN users u ON u.id = ph.user_id
      WHERE ph.id = $1
      LIMIT 1`,
    [photoId],
  );

  const row = rows[0];
  if (!row) {
    return NextResponse.json(
      { success: false, error: 'Фото не найдено' } satisfies ApiResponse<null>,
      { status: 404 },
    );
  }
  if (!row.ark_id) {
    // Тот же отказ, что у ручной загрузки: без ark_id снимок не к чему привязать.
    return NextResponse.json(
      { success: false, error: 'У места нет ark_id — снимок не к чему привязать' } satisfies ApiResponse<null>,
      { status: 422 },
    );
  }

  const isOwnPhoto = row.user_id === admin.userId;
  const author = authorOverride ?? (isOwnPhoto ? row.uploader_name : null);
  if (!author) {
    return NextResponse.json(
      {
        success: false,
        error: 'Это снимок другого человека. Укажите author — чем подписать его на карточке.',
      } satisfies ApiResponse<null>,
      { status: 400 },
    );
  }

  // Четыре поля прав перечислены и в INSERT, и в DO UPDATE — иначе прежний
  // герой оставил бы свою подпись под новым снимком (разбор 14.09).
  // image_data гасится: байты прежнего снимка под новой ссылкой — мусор,
  // который раздача всё равно не отдаст (s3_url имеет приоритет).
  await pool.query(
    `INSERT INTO ai_route_images
       (route_id, s3_url, image_data, mime_type, prompt, model, author, license, license_url, source_url)
     VALUES ($1, $2, NULL, 'image/jpeg', $3, 'manual-upload', $4, NULL, NULL, $2)
     ON CONFLICT (route_id) DO UPDATE
       SET s3_url      = EXCLUDED.s3_url,
           image_data  = NULL,
           mime_type   = EXCLUDED.mime_type,
           prompt      = EXCLUDED.prompt,
           model       = EXCLUDED.model,
           author      = EXCLUDED.author,
           license     = EXCLUDED.license,
           license_url = EXCLUDED.license_url,
           source_url  = EXCLUDED.source_url,
           created_at  = now()`,
    [row.ark_id, row.url, `hero from user photo ${photoId}`, author],
  );

  await pool.query(
    `UPDATE user_place_photos
        SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
      WHERE id = $2`,
    [admin.userId, photoId],
  );

  return NextResponse.json({ success: true } satisfies ApiResponse<null>);
}
