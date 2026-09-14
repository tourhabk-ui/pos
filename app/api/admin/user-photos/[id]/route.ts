import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { ApiResponse } from '@/types';
import { JWTPayload } from '@/lib/auth/jwt';
import { promoteUserPhotoToHero } from '@/lib/places/user-photo-hero';

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
      const res = await promoteUserPhotoToHero(id, {
        actorUserId: admin.userId,
        authorOverride: parsed.data.author ?? null,
      });
      if (res.status === 'applied') return NextResponse.json({ success: true } satisfies ApiResponse<null>);
      const [error, code] = res.status === 'not_found'
        ? ['Фото не найдено', 404] as const
        : res.status === 'no_ark_id'
          ? ['У места нет ark_id — снимок не к чему привязать', 422] as const
          : ['Это снимок другого человека. Укажите author — чем подписать его на карточке.', 400] as const;
      return NextResponse.json(
        { success: false, error } satisfies ApiResponse<null>,
        { status: code },
      );
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
