/**
 * Снимок туриста → главное фото карточки места.
 *
 * ОДНА реализация на два входа (владелец 14.09: «а поставить на главное ты не
 * мог?»). Входа два, потому что у них разные ключи и разные поводы:
 *   - `PATCH /api/admin/user-photos/[id]` (admin-JWT) — человек нажимает
 *     кнопку на карточке;
 *   - `POST /api/cron/user-photo-hero` (CRON_SECRET) — то же действие делает
 *     тот, у кого админского входа нет: разбор, починка, работа за владельца.
 *
 * Копии здесь быть не должно: два одинаковых переноса разойдутся при первой
 * же правке прав — этот урок платформа уже оплачивала (три копии подписи
 * фото, разбор 14.09 утром).
 */

import { pool } from '@/lib/db-pool';

export interface PromoteResult {
  status: 'applied' | 'not_found' | 'no_ark_id' | 'needs_author';
  /** Чем снимок подписан на карточке; null — перенос не состоялся. */
  author: string | null;
  placeName: string | null;
}

/**
 * Перенести снимок в герои карточки.
 *
 * `actorUserId` — кто переносит. От него зависит ОДНО: можно ли подставить
 * имя загрузившего автоматически. Имя туриста под ГЛАВНЫМ фото — публикация
 * персональных данных, на которую он не подписывался, отправляя снимок в блок
 * «сняли туристы». Поэтому: свой снимок подписывается своим именем, чужой —
 * только явным `authorOverride`, то есть решением человека.
 *
 * `actorUserId = null` (путь по CRON_SECRET) — значит «своих» снимков нет
 * вовсе, и любой требует явной подписи. Умолчание здесь одностороннее
 * намеренно: ошибиться в сторону «попросить подпись» можно, в сторону
 * «опубликовать чужое имя» — нельзя.
 */
export async function promoteUserPhotoToHero(
  photoId: string,
  opts: { actorUserId: string | null; authorOverride?: string | null },
): Promise<PromoteResult> {
  const { rows } = await pool.query<{
    url: string; user_id: string; ark_id: string | null;
    uploader_name: string | null; place_name: string | null;
  }>(
    `SELECT ph.url, ph.user_id::text AS user_id, p.ark_id::text AS ark_id,
            u.name AS uploader_name, p.name AS place_name
       FROM user_place_photos ph
       JOIN places p ON p.id = ph.place_id
       LEFT JOIN users u ON u.id = ph.user_id
      WHERE ph.id = $1
      LIMIT 1`,
    [photoId],
  );

  const row = rows[0];
  if (!row) return { status: 'not_found', author: null, placeName: null };
  if (!row.ark_id) {
    return { status: 'no_ark_id', author: null, placeName: row.place_name };
  }

  const isOwnPhoto = opts.actorUserId !== null && row.user_id === opts.actorUserId;
  const author = opts.authorOverride ?? (isOwnPhoto ? row.uploader_name : null);
  if (!author) {
    return { status: 'needs_author', author: null, placeName: row.place_name };
  }

  // Переносится ССЫЛКА, не байты: у ai_route_images есть s3_url, и раздача
  // (/api/images/route/[routeId]) отдаёт его редиректом.
  //
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

  // Одобрение идёт ВМЕСТЕ с переносом: снимок на карточке и «ждёт проверки» —
  // противоречие, а два шага подряд оставили бы окно, в котором оно истинно.
  await pool.query(
    `UPDATE user_place_photos
        SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
      WHERE id = $2`,
    [opts.actorUserId, photoId],
  );

  return { status: 'applied', author, placeName: row.place_name };
}
