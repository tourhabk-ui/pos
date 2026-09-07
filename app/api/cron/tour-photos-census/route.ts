/**
 * GET /api/cron/tour-photos-census — почему у поста о туре нет снимка.
 * Bearer CRON_SECRET, ТОЛЬКО ЧТЕНИЕ: ни строки в базу, ни одного поста.
 *
 * Повод: владелец, 07.09 — «фото нет в турах». Две причины уже устранены
 * (адрес снимка места отвечал 401; подпись резалась вслепую), и обе доказаны
 * замерами — но у тура фото по-прежнему нет. Значит причина третья, и её надо
 * НАЙТИ, а не угадать: кандидатов слишком много (пустой массив, битые пути,
 * файлы из эфемерного /tmp, отказ Bot API на альбоме).
 *
 * Перепись отвечает на три вопроса фактами:
 *
 *  1. ЧТО лежит в `operator_tours.photos` у живых туров — значения, а не
 *     счётчик. Счётчик у нас уже был (admin/diagnostics/tours) и молчал о
 *     главном: пути могут быть любыми.
 *  2. ДОСТУПЕН ли каждый снимок с той машины, что его отдаёт. Спрашиваем тем
 *     же способом, что и Telegram: обычный GET без заголовков, и смотрим код,
 *     тип содержимого и размер. Картинка, которой нет, — не «пост без фото»,
 *     а битая ссылка.
 *  3. ЧТО ОТВЕТИЛ Telegram в прошлые разы — записанные отказы из
 *     `ai_actions_log`. Bot API называет причину словами, и она уже сохранена.
 */
import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { absolutePhotoUrls } from '@/lib/notifications/photo-urls';
import { getPublicBaseUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface TourRow { id: string; title: string; photos: string[] | null; tour_image: string | null }
interface LogRow { action_type: string; metadata: unknown; created_at: string }

interface PhotoCheck {
  url: string;
  status: number | null;
  content_type: string | null;
  bytes: number | null;
  error: string | null;
}

/** Сколько туров и снимков смотрим за прогон: перепись, а не выгрузка. */
const MAX_TOURS = 5;
const MAX_PHOTOS_PER_TOUR = 4;

/**
 * Проверка ровно тем способом, каким снимок берёт Telegram: обычный GET, без
 * наших заголовков и без токена. Читаем только начало тела — нам нужен факт
 * доступности и тип, а не сама картинка.
 */
async function checkPhoto(url: string): Promise<PhotoCheck> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const buf = await res.arrayBuffer();
    return {
      url,
      status: res.status,
      content_type: res.headers.get('content-type'),
      bytes: buf.byteLength,
      error: null,
    };
  } catch (err) {
    return {
      url, status: null, content_type: null, bytes: null,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  }
}

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const appUrl = getPublicBaseUrl();

  let tours: TourRow[];
  try {
    // Тот же отбор, что у постера: живой тур с непустым массивом снимков.
    const res = await pool.query<TourRow>(
      `SELECT ot.id::text, ot.title, ot.photos, ot.tour_image
         FROM operator_tours ot
        WHERE ot.is_active = TRUE AND ot.deleted_at IS NULL
        ORDER BY COALESCE(array_length(ot.photos, 1), 0) DESC, ot.id
        LIMIT $1`,
      [MAX_TOURS],
    );
    tours = res.rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    console.error('[tour-photos-census] туры не прочитались:', msg);
    return NextResponse.json(
      { probe: 'tour_photos_census_v1', ok: null, error: `туры не прочитались: ${msg}` },
      { status: 200 },
    );
  }

  const checked = [];
  for (const t of tours) {
    const raw = t.photos ?? [];
    const urls = absolutePhotoUrls(raw, appUrl).slice(0, MAX_PHOTOS_PER_TOUR);
    const photos: PhotoCheck[] = [];
    for (const u of urls) photos.push(await checkPhoto(u));
    checked.push({
      id: t.id,
      title: t.title,
      // Значения ДО абсолютизации: по ним видно, что вообще записал оператор.
      photos_raw: raw.slice(0, MAX_PHOTOS_PER_TOUR),
      photos_total: raw.length,
      tour_image: t.tour_image,
      // Годен ли снимок для Telegram: тот ответил бы так же.
      usable: photos.filter((p) => p.status === 200 && (p.content_type ?? '').startsWith('image/')).length,
      photos,
    });
  }

  // Записанные отказы: Bot API называет причину словами, и она уже в журнале.
  let log: LogRow[] = [];
  let logError: string | null = null;
  try {
    const res = await pool.query<LogRow>(
      `SELECT action_type, metadata, created_at::text
         FROM ai_actions_log
        WHERE action_type IN ('channel_media_group_fallback', 'channel_photo_fallback',
                              'kuzmich_tour_post', 'kuzmich_post')
        ORDER BY created_at DESC
        LIMIT 12`,
    );
    log = res.rows;
  } catch (err) {
    // Журнал не прочитался — так и говорим: пустой список выглядел бы как
    // «отказов не было», а это другое утверждение (§4.0).
    logError = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
    console.error('[tour-photos-census] журнал не прочитался:', logError);
  }

  return NextResponse.json({
    probe: 'tour_photos_census_v1',
    checked_at: new Date().toISOString(),
    checked_from: 'prod',
    app_url: appUrl,
    tours: checked,
    recent_log: log,
    log_error: logError,
  });
}
