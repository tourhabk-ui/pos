/**
 * GET /api/cron/place-photo-coverage — у каких мест есть ПОКАЗЫВАЕМОЕ фото.
 * Bearer CRON_SECRET, только чтение: ни одной правки ни при каком аргументе.
 *
 * ── Повод ─────────────────────────────────────────────────────────────────
 *
 * 19.09 владелец трижды за вечер спросил одно и то же разными словами: «где
 * фото», «почему было и куда делось», «почему на Козельском нет фото». Каждый
 * раз ответ приходилось СОБИРАТЬ заново, и каждый раз он оказывался другим:
 * порядок выбора адреса, отсутствие запасного пути, недоступный объект в
 * хранилище.
 *
 * Общее у всех трёх — не причина, а то, что причину нельзя было СПРОСИТЬ.
 * Переписи «у каких мест есть показываемое фото» не существовало, хотя
 * снимков в базе шесть с лишним сотен, а показывается меньше пятой части:
 *
 *   idilesom-photo    149 — скрейп с чужого сайта, не показывается
 *   pollinations-flux  75 — генерация, не показывается (решение 17.07)
 *   wikimedia-commons  23 — чужие, автор не записан, показывать нельзя
 *   manual-upload      33 — показывается
 *   real-photo         81 — показывается с 18.09
 *   wikimedia           1 — показывается
 *
 * (числа из шапки lib/images/origin.ts, перепись 18.09)
 *
 * Каждое сокрытие обосновано по отдельности. Но вместе они дают состояние, в
 * котором место «со снимком» выглядит как место без снимка, и отличить одно
 * от другого нельзя ни с экрана, ни из кода.
 *
 * ── Что отвечает проба ────────────────────────────────────────────────────
 *
 * Не «сколько фотографий в базе» — это уже умеют db-size-census и
 * images-oversize. А: у скольких живых мест есть снимок, который КАРТОЧКА
 * ПОКАЖЕТ, и что лежит у остальных вместо него.
 *
 * Разница принципиальная. «У места есть фото» и «турист увидит фото» — разные
 * утверждения, и до сих пор первое выдавалось за второе: крон
 * `backfill-place-images` считает место обеспеченным, как только запишет ему
 * генерацию, а генерацию карточка не показывает с 17.07.
 *
 * `?name=` отвечает про ОДНО место словами: есть ли показываемый снимок, а
 * если нет — что у него есть вместо и почему это не показывается. Ровно тот
 * вопрос, который задавали про Козельский.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { shownPhotoSql, SHOWN_MODELS, whyNotShown } from '@/lib/images/origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_LIMIT = 300;
const DEFAULT_LIMIT = 100;

/**
 * Почему снимок не показывается — словами, по роду.
 *
 * Своего объяснения перепись не держит: знание о родах живёт в
 * `lib/images/origin.ts` вместе со списком показываемых, и написать его здесь
 * значило бы завести четырнадцатую копию ровно того, что этот файл и сводил
 * в одно место.
 */
const whyHidden = whyNotShown;

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 120);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    // ── Вопрос про ОДНО место ────────────────────────────────────────────
    if (name) {
      const { rows } = await pool.query<{
        id: string; place: string; model: string | null; shown: boolean; has_bytes: boolean; in_s3: boolean;
      }>(
        `SELECT p.id::text,
                p.name AS place,
                i.model,
                ${shownPhotoSql('i.model')} AS shown,
                (i.image_data IS NOT NULL)  AS has_bytes,
                (i.s3_url IS NOT NULL AND btrim(i.s3_url) <> '') AS in_s3
           FROM places p
           LEFT JOIN ai_route_images i ON i.route_id = p.ark_id
          WHERE p.name ILIKE '%' || $1 || '%'
            AND p.is_visible IS NOT FALSE
            AND p.merged_into_id IS NULL
          ORDER BY p.name
          LIMIT 50`,
        [name],
      );

      if (rows.length === 0) {
        // Пусто — это «такого живого места нет», а не «у него нет снимка».
        return NextResponse.json({
          ok: true, probe: 'place_photo_coverage_v1', asked: name,
          found: 0,
          verdict: 'живого места с таким именем не нашлось — проверьте написание или оно скрыто/слито',
        });
      }

      return NextResponse.json({
        ok: true, probe: 'place_photo_coverage_v1', asked: name,
        found: rows.length,
        places: rows.map(r => ({
          place: r.place,
          id: r.id,
          // Три разных состояния, а не два: снимка нет вовсе / есть, но не
          // показывается / показывается.
          verdict: r.model === null
            ? 'снимка нет вовсе — карточка покажет градиент, и это правда'
            : r.shown
              ? 'показываемый снимок есть'
              : `снимок ЕСТЬ, но скрыт: ${whyHidden(r.model)}`,
          model: r.model,
          storage: r.model === null ? null : (r.in_s3 ? 's3' : r.has_bytes ? 'байты в базе' : 'ни байтов, ни ссылки'),
        })),
      });
    }

    // ── Перепись по всем живым местам ────────────────────────────────────
    const { rows: totals } = await pool.query<{
      live: string; with_shown: string; with_hidden: string; with_none: string;
    }>(
      `SELECT count(*)::text AS live,
              count(*) FILTER (WHERE i.model IS NOT NULL AND ${shownPhotoSql('i.model')})::text  AS with_shown,
              count(*) FILTER (WHERE i.model IS NOT NULL AND NOT ${shownPhotoSql('i.model')})::text AS with_hidden,
              count(*) FILTER (WHERE i.model IS NULL)::text AS with_none
         FROM places p
         LEFT JOIN ai_route_images i ON i.route_id = p.ark_id
        WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL`,
    );

    const { rows: byModel } = await pool.query<{ model: string | null; n: string }>(
      `SELECT i.model, count(*)::text AS n
         FROM places p
         JOIN ai_route_images i ON i.route_id = p.ark_id
        WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
          AND NOT ${shownPhotoSql('i.model')}
        GROUP BY i.model
        ORDER BY count(*) DESC`,
    );

    const { rows: items } = await pool.query<{ place: string; model: string | null }>(
      `SELECT p.name AS place, i.model
         FROM places p
         LEFT JOIN ai_route_images i ON i.route_id = p.ark_id
        WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
          AND (i.model IS NULL OR NOT ${shownPhotoSql('i.model')})
        ORDER BY p.name
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const t = totals[0];
    const live = Number(t?.live ?? 0);
    const withShown = Number(t?.with_shown ?? 0);

    return NextResponse.json({
      ok: true,
      probe: 'place_photo_coverage_v1',
      live_places: live,
      with_shown_photo: withShown,
      with_hidden_photo_only: Number(t?.with_hidden ?? 0),
      with_no_photo_at_all: Number(t?.with_none ?? 0),
      shown_models: SHOWN_MODELS,
      hidden_by_model: byModel.map(r => ({
        model: r.model ?? '(род не записан)',
        count: Number(r.n),
        why: whyHidden(r.model),
      })),
      page: { limit, offset, returned: items.length },
      // Одной строкой на место: список читает человек.
      without_shown_photo: items.map(r =>
        `${r.place} · ${r.model === null ? 'снимка нет' : `скрыт (${r.model})`}`),
      // Ноль строк при ненулевом числе мест без снимка — отказ выборки, а не
      // «все обеспечены» (§4.0).
      meaningful: live > 0,
      note: '«есть фото в базе» и «турист увидит фото» — разные утверждения; здесь считается второе',
    });
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'нет SQLSTATE';
    console.error(`[place-photo-coverage] перепись не выполнена, SQLSTATE ${code}:`, err);
    return NextResponse.json(
      { ok: false, probe: 'place_photo_coverage_v1', error: 'перепись не выполнена', sqlstate: code },
      { status: 503 },
    );
  }
}
