/**
 * Медиа тура для форм правки — общее у кабинета гида и кабинета оператора
 * (08.11: форма оператора взяла программу, видео, правила и подпись снимков
 * из кабинета гида; запись и чтение у двух форм одни, чтобы не разошлись).
 *
 *   - `editorClips` — клипы тура (1194) с адресами для превью в форме;
 *   - `photoCreditsOf` — подписи снимков из карты партнёра (адрес → автор);
 *   - `writePhotoCredits` — «Фото: <автор>» снимкам тура без подписи, в карту
 *     партнёра (`partners.gallery_credits`, её читает карточка тура). Уже
 *     подписанное не переписывается;
 *   - `setPhotoCaptions` — подпись каждого снимка тура своей рукой, в любой
 *     момент, и после публикации (11.11).
 */
import type { PoolClient } from 'pg';
import { s3PublicUrl } from '@/lib/storage/s3';

export interface EditorClip { key: string; poster: string; label: string; url: string; posterUrl: string }

/** Клипы тура: только с ключом ролика и обложки, с адресами для превью. */
export function editorClips(raw: unknown): EditorClip[] {
  if (!Array.isArray(raw)) return [];
  const out: EditorClip[] = [];
  for (const c of raw) {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    if (typeof o.key !== 'string' || typeof o.poster !== 'string') continue;
    const url = s3PublicUrl(o.key);
    const posterUrl = s3PublicUrl(o.poster);
    if (!url || !posterUrl) continue;
    out.push({ key: o.key, poster: o.poster, label: typeof o.label === 'string' && o.label.trim() ? o.label : 'Видео тура', url, posterUrl });
  }
  return out;
}

/** Карта подписей партнёра: только строковые подписи. */
export function photoCreditsOf(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** Подписать снимки без подписи: одна строка UPDATE в транзакции правки тура. */
export async function writePhotoCredits(
  client: Pick<PoolClient, 'query'>,
  partnerId: string,
  credit: string,
  photos: readonly string[],
): Promise<void> {
  await client.query(
    `UPDATE partners
        SET gallery_credits = COALESCE(gallery_credits, '{}'::jsonb)
            || (SELECT COALESCE(jsonb_object_agg(u, $2::text), '{}'::jsonb)
                  FROM unnest($3::text[]) AS u
                 WHERE NOT (COALESCE(gallery_credits, '{}'::jsonb) ? u))
      WHERE id = $1::uuid`,
    [partnerId, credit, [...photos]],
  );
}

/**
 * Подписи снимков тура — правкой каждой (11.11, гид Андрей Запорожец: «было
 * бы неплохо редактировать подписи под фото после публикации, а не только
 * до»). `writePhotoCredits` подписывает только неподписанное, и поменять
 * однажды поставленную подпись было нечем.
 *
 * Пишутся только снимки ЭТОГО тура этого партнёра: карта подписей одна на
 * партнёра, и чужой адрес из запроса её не тронет. Пустая подпись — снять
 * («Без подписи»), а не записать пустую строку. Возвращает, сколько подписей
 * применено.
 */
export const SET_PHOTO_CAPTIONS_SQL = `WITH tp AS (
  SELECT DISTINCT u FROM operator_tours t CROSS JOIN LATERAL unnest(t.photos) AS u
   WHERE t.id = $2::bigint AND t.operator_id = $1::uuid AND t.deleted_at IS NULL),
ok AS (
  SELECT k AS u, btrim($3::jsonb ->> k) AS v FROM jsonb_object_keys($3::jsonb) AS k JOIN tp ON tp.u = k)
UPDATE partners
   SET gallery_credits = (COALESCE(gallery_credits, '{}'::jsonb) - COALESCE((SELECT array_agg(u) FROM ok WHERE v = ''), '{}'::text[]))
       || COALESCE((SELECT jsonb_object_agg(u, v) FROM ok WHERE v <> ''), '{}'::jsonb)
 WHERE id = $1::uuid
RETURNING (SELECT count(*) FROM ok)::int AS applied`;

export async function setPhotoCaptions(
  client: Pick<PoolClient, 'query'>,
  partnerId: string,
  tourId: number | string,
  captions: Readonly<Record<string, string>>,
): Promise<number> {
  if (Object.keys(captions).length === 0) return 0;
  const res = await client.query<{ applied: number }>(SET_PHOTO_CAPTIONS_SQL, [partnerId, String(tourId), JSON.stringify(captions)]);
  return res.rows[0]?.applied ?? 0;
}
