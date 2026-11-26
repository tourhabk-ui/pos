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
 * ПОЧЕМУ ТОЛЬКО ЛОКАЛЬНЫЕ ПУТИ. `path` обязан начинаться с `/images/` или
 * быть адресом снимка в хранилище `/api/images/s3/photos/…` и не содержать `..`: иначе ручка превращается в способ повесить туру любую
 * картинку из интернета — вплоть до чужого водяного знака на карточке нашего
 * проверенного оператора.
 *
 * ПРАВИЛА ТЕ ЖЕ, ЧТО У ПРАВКИ КООРДИНАТ И ПЕРЕВОЗКИ:
 * - `source` на партию и `why` к правке обязательны и без умолчаний;
 * - сухой прогон по умолчанию;
 * - прежний массив возвращается целиком и служит откатом;
 * - дубли не добавляются: повтор прогона не размножает одно фото.
 *
 * СВОЕЙ ЗАПИСИ В ТУР ЗДЕСЬ НЕТ (слово владельца 23.11: «Автоматы (кроны
 * описаний и фото, импортёры) пишут в туры только через очередь проверки,
 * своих обходных путей у них нет»). Снимки уходят дверью правки
 * (lib/tours/photos-door): у тура на сайте они ждут проверки администратора,
 * и до одобрения туристы видят прежнюю галерею.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { photoKeyOf } from '@/lib/images/photo-key';
import { proposeTourPhotos } from '@/lib/tours/photos-door';

export const dynamic     = 'force-dynamic';
export const maxDuration = 30;

export const MAX_PHOTOS_PER_CALL = 12;

const S3_PHOTO_PREFIX = '/api/images/s3/';

/**
 * Только то, что лежит у нас. Чужой хост фотографией тура быть не может.
 * С 08.11 — и снимок в хранилище по адресу раздачи /api/images/s3/photos/…
 * (photoKeyOf): снимки партнёров лежат там, а не в папке сайта. Пока ручка
 * знала один /images/, приписать туру снимок из хранилища было нельзя, и его
 * клали в public/images.
 */
export function isLocalImagePath(p: string): boolean {
  if (p.includes('..') || p.includes('//')) return false;
  if (p.startsWith(S3_PHOTO_PREFIX)) return photoKeyOf(p.slice(S3_PHOTO_PREFIX.length).split('/')) !== null;
  return p.startsWith('/images/');
}

const BodySchema = z.object({
  source: z.string().trim().min(3, 'Назовите источник').max(200),
  why: z.string().trim().min(3, 'Назовите причину').max(300),
  dry_run: z.boolean().default(true),
  tour_id: z.number().int().positive(),
  add: z.array(z.string().trim().min(8).max(300))
    .min(1).max(MAX_PHOTOS_PER_CALL)
    .refine((arr) => arr.every(isLocalImagePath),
      'Путь фото обязан начинаться с /images/ или /api/images/s3/photos/ и не выходить вверх'),
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
    return NextResponse.json({ probe: 'tour_photos_v2', error: msg }, { status: 400 });
  }

  try {
    const r = await proposeTourPhotos(String(body.tour_id), body.add, { dryRun: body.dry_run });
    if (r.status === 'not_found') {
      return NextResponse.json({
        probe: 'tour_photos_v2', dry_run: body.dry_run,
        status: 'not_found', tour_id: body.tour_id,
      }, { status: 404 });
    }

    return NextResponse.json({
      probe: 'tour_photos_v2',
      dry_run: body.dry_run,
      source: body.source,
      why: body.why,
      tour_id: body.tour_id,
      title: r.title,
      // Исход назван: «на проверке» — не «на сайте», пропуск — не успех.
      status: r.status,
      // Прежний массив целиком (витрина плюс правка на проверке) — это откат.
      was: r.was,
      now: r.now,
      added: r.added,
      // Повтор прогона добавит ноль — и это НЕ отказ, это идемпотентность.
      already_present: r.alreadyPresent,
      // На сайте этих снимков ещё нет: они ждут проверки администратора.
      staged_for_review: r.status === 'staged' ? r.added : 0,
      // Тур, которого туристы не видят: снимки записаны в строку.
      written_not_on_site: r.status === 'written' ? r.added : 0,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    console.error('[tour-photos] правка не удалась:', msg);
    return NextResponse.json({ probe: 'tour_photos_v2', error: msg }, { status: 500 });
  }
}
