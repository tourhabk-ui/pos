/**
 * Снимки туристов: посмотреть и поставить главным — по CRON_SECRET.
 *
 * ПОВОД (владелец 14.09): «я лично загружал свои фото и их нет», а затем — «а
 * поставить на главное ты не мог?». Мог. Кнопка на карточке, сделанная часом
 * раньше, перекладывает работу обратно на владельца: он и так уже сделал всё
 * правильно один раз. Здесь то же действие доступно тому, у кого админского
 * входа нет.
 *
 * GET  — перепись: чьи снимки, к каким местам, в каком состоянии, есть ли у
 *        места главное фото сейчас. Только чтение.
 * POST — перенос в герои. Сухой прогон по умолчанию, партия не больше 10,
 *        `author` обязателен и без умолчания.
 *
 * ПОЧЕМУ AUTHOR ОБЯЗАТЕЛЕН ЗДЕСЬ, А НА КНОПКЕ НЕТ. Кнопку нажимает человек,
 * вошедший под своим аккаунтом: свой снимок он подписывает своим именем, и
 * это его собственные данные. У пути по CRON_SECRET владельца аккаунта нет —
 * «своих» снимков не бывает, и подставить имя загрузившего автоматически
 * значило бы опубликовать чужие персональные данные по догадке кода.
 * Умолчание одностороннее намеренно: попросить подпись можно, опубликовать
 * чужое имя молча — нельзя.
 *
 * Перенос делает `lib/places/user-photo-hero.ts` — та же функция, что и у
 * кнопки. Второй копии здесь нет: два одинаковых переноса разошлись бы при
 * первой правке прав.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { promoteUserPhotoToHero, type PromoteResult } from '@/lib/places/user-photo-hero';

export const dynamic     = 'force-dynamic';
export const maxDuration = 60;

/**
 * Маркер версии — по нему workflow ждёт выкат, а не слепой таймер.
 *
 * v2, а не v1: контракт тела изменился (author стал необязательным, появился
 * no_author). Проба 503 с маркером v1 приняла ПРЕЖНЮЮ сборку — строка была в
 * обоих образах — и получила 400 от старой схемы, где author обязателен.
 * Маркер обязан меняться вместе с тем, что он удостоверяет, иначе ожидание
 * выката удостоверяет прошлое.
 */
const PROBE = 'user_photo_hero_v2';

/** Партия не больше десяти — правило владельца, общее для пишущих разборов. */
const MAX_BATCH = 10;

const BodySchema = z.object({
  photo_ids: z.array(z.string().uuid()).min(1).max(MAX_BATCH),
  /** Чем подписать снимок на карточке. */
  author: z.string().trim().min(1).max(200).optional(),
  /**
   * Подписи не будет: снимок собственный, внешнего автора у него нет.
   *
   * Отдельный ЯВНЫЙ флаг, а не просто отсутствие `author` (владелец 14.09:
   * «мой, ставь без подписи»). Правило защищало от одного — публикации чужого
   * имени МОЛЧА; «подписи нет» его не нарушает, но и умолчанием быть не
   * должно: тогда забытое поле стало бы решением. Решений два, и оба
   * называются вслух.
   */
  no_author: z.literal(true).optional(),
}).and(z.object({ dry_run: z.boolean().optional() }))
  .refine(
    v => (('author' in v && v.author) ? 1 : 0) + (('no_author' in v && v.no_author) ? 1 : 0) === 1,
    { message: 'Укажите ровно одно: author (чем подписать) или no_author: true (подписи нет)' },
  );

function unauthorized(): NextResponse {
  return NextResponse.json({ error: 'Unauthorized', probe: PROBE }, { status: 401 });
}

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) return unauthorized();

  const { rows } = await pool.query(
    `SELECT ph.id::text            AS photo_id,
            ph.status,
            ph.caption,
            ph.created_at::text    AS uploaded_at,
            -- Почта МАСКИРУЕТСЯ и имя не выдаётся вовсе. Узнать «мой ли это
            -- снимок» маска позволяет, а контактом не является; полное имя
            -- здесь не нужно ни для чего: author всё равно задаётся явно.
            -- Возможность pd_direct объявлена в реестре: роут читает колонку
            -- users.email, и прятать это за маской было бы той же полуправдой.
            left(u.email, 1) || '***@' || split_part(u.email, '@', 2)
                                   AS uploader_masked,
            p.id::text             AS place_id,
            p.name                 AS place_name,
            p.ark_id IS NOT NULL   AS place_linkable,
            -- Есть ли у места главное фото ПРЯМО СЕЙЧАС: без этого перенос
            -- вслепую затёр бы чужой снимок, и узналось бы это с экрана.
            EXISTS (
              SELECT 1 FROM ai_route_images ai
               WHERE ai.route_id = p.ark_id
                 AND ai.model IN ('wikimedia', 'manual-upload')
            )                      AS place_has_hero
       FROM user_place_photos ph
       JOIN places p ON p.id = ph.place_id
       LEFT JOIN users u ON u.id = ph.user_id
      ORDER BY ph.created_at DESC
      LIMIT 200`,
  );

  return NextResponse.json({
    ok: true,
    probe: PROBE,
    total: rows.length,
    // Счётчики отдельно от списка: «сколько ждёт проверки» — вопрос к системе,
    // а не к глазам читающего.
    pending: rows.filter(r => r.status === 'pending').length,
    approved: rows.filter(r => r.status === 'approved').length,
    photos: rows,
  });
}

export async function POST(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Тело запроса — не JSON', probe: PROBE }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message, probe: PROBE },
      { status: 400 },
    );
  }

  const { photo_ids: photoIds } = parsed.data;
  // Пустая подпись — законный исход, но только объявленный (no_author).
  const author = 'author' in parsed.data ? (parsed.data.author ?? null) : null;
  const dryRun = parsed.data.dry_run !== false;

  const results: Array<{ photo_id: string } & PromoteResult> = [];

  for (const photoId of photoIds) {
    if (dryRun) {
      // Сухой прогон читает то же самое, но НЕ пишет: показывает, к какому
      // месту снимок привязан и чем будет подписан.
      const { rows } = await pool.query<{ place_name: string | null; ark_id: string | null }>(
        `SELECT p.name AS place_name, p.ark_id::text AS ark_id
           FROM user_place_photos ph JOIN places p ON p.id = ph.place_id
          WHERE ph.id = $1 LIMIT 1`,
        [photoId],
      );
      const row = rows[0];
      results.push({
        photo_id: photoId,
        status: !row ? 'not_found' : !row.ark_id ? 'no_ark_id' : 'applied',
        author: row?.ark_id ? author : null,
        placeName: row?.place_name ?? null,
      });
      continue;
    }

    const res = await promoteUserPhotoToHero(photoId, {
      actorUserId: null,
      authorOverride: author,
      allowNoAuthor: author === null,
    });
    results.push({ photo_id: photoId, ...res });
  }

  return NextResponse.json({
    ok: true,
    probe: PROBE,
    dry_run: dryRun,
    applied: results.filter(r => r.status === 'applied').length,
    results,
  });
}
