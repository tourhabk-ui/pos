/**
 * POST /api/cron/tour-photos — добавить фотографии туру.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ РУЧКА, А НЕ ЗАГРУЗКА. Загрузка файла — это multipart и S3
 * (lib/storage/s3.ts, кабинет оператора). Здесь другое: файлы УЖЕ лежат в
 * репозитории под public/images и раздаются вместе с приложением, а туру не
 * хватает только записи о том, что они его. Смешивать эти две вещи нельзя:
 * приём чужого файла и приписывание уже лежащего — разные права и разные
 * последствия.
 *
 * ПОЧЕМУ ТОЛЬКО ЛОКАЛЬНЫЕ ПУТИ. `path` обязан начинаться с `/images/` и не
 * содержать `..`: иначе ручка превращается в способ повесить туру любую
 * картинку из интернета — вплоть до чужого водяного знака на карточке нашего
 * проверенного оператора.
 *
 * ПРАВИЛА ТЕ ЖЕ, ЧТО У ПРАВКИ КООРДИНАТ И ПЕРЕВОЗКИ:
 * - `source` на партию и `why` к правке обязательны и без умолчаний;
 * - сухой прогон по умолчанию;
 * - прежний массив возвращается целиком и служит откатом;
 * - дубли не добавляются: повтор прогона не размножает одно фото.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

export const MAX_PHOTOS_PER_CALL = 12;

/** Только то, что лежит у нас. Чужой хост фотографией тура быть не может. */
export function isLocalImagePath(p: string): boolean {
  return p.startsWith('/images/') && !p.includes('..') && !p.includes('//');
}

const BodySchema = z.object({
  source: z.string().trim().min(3, 'Назовите источник').max(200),
  why: z.string().trim().min(3, 'Назовите причину').max(300),
  dry_run: z.boolean().default(true),
  tour_id: z.number().int().positive(),
  add: z.array(z.string().trim().min(8).max(300))
    .min(1).max(MAX_PHOTOS_PER_CALL)
    .refine((arr) => arr.every(isLocalImagePath),
      'Путь фото обязан начинаться с /images/ и не выходить вверх'),
});

export async function POST(req: NextRequest) {
  const secret = getCronSecret(req);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : 'Тело запроса не разобрано';
    return NextResponse.json({ probe: 'tour_photos_v1', error: msg }, { status: 400 });
  }

  try {
    const { rows } = await pool.query<{ id: number; title: string; photos: string[] | null }>(
      `SELECT id, title, photos FROM operator_tours WHERE id = $1 AND deleted_at IS NULL`,
      [body.tour_id],
    );
    const tour = rows[0];
    if (!tour) {
      return NextResponse.json({
        probe: 'tour_photos_v1', dry_run: body.dry_run,
        status: 'not_found', tour_id: body.tour_id,
      }, { status: 404 });
    }

    const was = tour.photos ?? [];
    const fresh = body.add.filter((p) => !was.includes(p));
    const now = [...was, ...fresh];

    if (!body.dry_run && fresh.length > 0) {
      await pool.query(
        `UPDATE operator_tours SET photos = $1::text[], updated_at = NOW() WHERE id = $2`,
        [now, tour.id],
      );
    }

    return NextResponse.json({
      probe: 'tour_photos_v1',
      dry_run: body.dry_run,
      source: body.source,
      why: body.why,
      tour_id: tour.id,
      title: tour.title,
      // Прежний массив целиком — это откат, а не украшение отчёта.
      was,
      now: body.dry_run ? now : now,
      added: fresh.length,
      // Повтор прогона добавит ноль — и это НЕ отказ, это идемпотентность.
      already_present: body.add.length - fresh.length,
      changed: body.dry_run ? 0 : fresh.length,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    console.error('[tour-photos] правка не удалась:', msg);
    return NextResponse.json({ probe: 'tour_photos_v1', error: msg }, { status: 500 });
  }
}
