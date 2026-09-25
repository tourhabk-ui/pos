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
 *
 * `?list=shown` отвечает на вопрос 20.09: у показываемых снимков ЕСТЬ ли
 * среди них чужие. Владелец прислал карточку с вотермарком фотобанка на
 * «Голыгинских термальных источниках» — снимок рода `real-photo`, которому
 * миграция 978 проставила его же авторство по слову «это мои фото влиты».
 * Пачка залита 28.03 без автора и глазами целиком не пересматривалась.
 * Проверить это статикой нельзя — вотермарк живёт в пикселях, не в SQL — и
 * перепись не пытается: она отдаёт список ссылок на снимки, разбор глазами
 * делает человек. `model=` сужает список до одного рода (например
 * `real-photo`), `limit`/`offset` — те же, что у списка без снимка.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { shownPhotoSql, SHOWN_MODELS, whyNotShown } from '@/lib/images/origin';
import { cardImage, type CardImageKind } from '@/lib/routes/card-image';

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

/**
 * Что карточка покажет ВМЕСТО отсутствующего снимка — словами.
 *
 * Род берётся у `cardImage`, то есть у той же функции, которой пользуется
 * каталог. Своё объяснение здесь уже было, и оно было неверным: «карточка
 * покажет градиент, и это правда» — тогда как у места с подходящей категорией
 * подставляется кадр стороннего оператора.
 */
function cardShows(category: string | null): string {
  // Род спрашивается ВМЕСТЕ с `kind: 'place'`: перепись считает места, а с
  // 20.09 у места подстановки кадром оператора нет (решение владельца по
  // числу этой же переписи — 226 карточек из 378 показывали чужой кадр).
  // Без явного рода ответ совпал бы по случайности — умолчание там тоже
  // «место», — и следующая правка умолчания молча сделала бы перепись
  // неверной. Ровно так она уже ошибалась 20.09.
  const kind = cardImage({ hasShownPhoto: false, id: 'x', category, kind: 'place' }).kind;
  if (kind === 'category_fallback') {
    return 'карточка подставит кадр оператора по категории (/images/partners/kamchatintour), а не снимок этого места';
  }
  if (kind === 'payload_link') {
    return 'карточка подставит адрес из payload — чужой сервер';
  }
  return 'карточка покажет градиент';
}

export async function GET(req: NextRequest) {
  if (!timingSafeCompare(getCronSecret(req), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const name = (url.searchParams.get('name') ?? '').trim().slice(0, 120);
  const list = (url.searchParams.get('list') ?? '').trim();
  const modelFilter = (url.searchParams.get('model') ?? '').trim().slice(0, 100);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get('limit')) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    // ── Вопрос про ОДНО место ────────────────────────────────────────────
    if (name) {
      const { rows } = await pool.query<{
        id: string; place: string; category: string | null;
        model: string | null; shown: boolean; has_bytes: boolean; in_s3: boolean;
      }>(
        `SELECT p.id::text,
                p.name AS place,
                p.category,
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
          verdict: r.shown
            ? 'показываемый снимок есть'
            : r.model === null
              ? `снимка нет вовсе — ${cardShows(r.category)}`
              : `снимок ЕСТЬ, но скрыт: ${whyHidden(r.model)}; вместо него ${cardShows(r.category)}`,
          model: r.model,
          // Что увидит турист, а не что лежит в таблице. До 20.09 перепись
          // отвечала «покажет градиент, и это правда» всем без снимка —
          // и это была неправда у каждого места, чья категория попадает в
          // подстановку.
          card_shows: cardImage({ hasShownPhoto: r.shown, id: r.id, category: r.category, kind: 'place' }).kind,
          storage: r.model === null ? null : (r.in_s3 ? 's3' : r.has_bytes ? 'байты в базе' : 'ни байтов, ни ссылки'),
        })),
      });
    }

    // ── Список ПОКАЗЫВАЕМЫХ снимков — разбор глазами ─────────────────────
    //
    // Отвечает не «сколько», а «какие именно»: у показываемого снимка нет
    // признака «чужой» в базе — вотермарк живёт в пикселях, SQL его не
    // видит. Единственный способ найти чужой кадр в пачке `real-photo` —
    // пройти список глазами по ссылке на сам снимок.
    if (list === 'shown') {
      const params: unknown[] = [];
      let modelClause = '';
      if (modelFilter) {
        params.push(modelFilter);
        modelClause = `AND i.model = $${params.length}`;
      }
      params.push(limit, offset);

      const { rows: shownList } = await pool.query<{
        place: string; ark_id: string; model: string | null;
        source_url: string | null; author: string | null; license: string | null;
        in_s3: boolean; has_bytes: boolean;
      }>(
        `SELECT p.name AS place,
                p.ark_id::text AS ark_id,
                i.model, i.source_url, i.author, i.license,
                (i.s3_url IS NOT NULL AND btrim(i.s3_url) <> '') AS in_s3,
                (i.image_data IS NOT NULL) AS has_bytes
           FROM places p
           JOIN ai_route_images i ON i.route_id = p.ark_id
          WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
            AND ${shownPhotoSql('i.model')}
            ${modelClause}
          ORDER BY p.name
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      const { rows: countRows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM places p
           JOIN ai_route_images i ON i.route_id = p.ark_id
          WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
            AND ${shownPhotoSql('i.model')}
            ${modelFilter ? 'AND i.model = $1' : ''}`,
        modelFilter ? [modelFilter] : [],
      );

      return NextResponse.json({
        ok: true, probe: 'place_photo_coverage_v1', list: 'shown',
        model_filter: modelFilter || null,
        total: Number(countRows[0]?.n ?? 0),
        page: { limit, offset, returned: shownList.length },
        // Ноль строк при ненулевом total — отказ выборки, а не «нечего
        // разбирать» (§4.0).
        meaningful: Number(countRows[0]?.n ?? 0) === 0 || shownList.length > 0,
        photos: shownList.map(r => ({
          place: r.place,
          model: r.model,
          // Адрес, по которому снимок реально открывается — тот же, что
          // отдаёт карточка (route_id = places.ark_id, не places.id).
          image_url: `/api/images/route/${r.ark_id}`,
          source_url: r.source_url,
          author: r.author,
          license: r.license,
          storage: r.in_s3 ? 's3' : r.has_bytes ? 'байты в базе' : 'ни байтов, ни ссылки',
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

    // ── Что увидит турист у мест БЕЗ показываемого снимка ────────────────
    //
    // Считается не по своему условию, а по `cardImage` — той же функции, что
    // выбирает картинку в каталоге. Иначе перепись отвечала бы про своё
    // представление о карточке, а не про карточку (так и было до 20.09).
    const { rows: noPhotoCats } = await pool.query<{ category: string | null; n: string }>(
      `SELECT p.category, count(*)::text AS n
         FROM places p
         LEFT JOIN ai_route_images i ON i.route_id = p.ark_id
        WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
          AND (i.model IS NULL OR NOT ${shownPhotoSql('i.model')})
        GROUP BY p.category`,
    );

    const byCardKind: Record<CardImageKind, number> = {
      own: 0, payload_link: 0, waypoint_place: 0, category_fallback: 0, gradient: 0,
    };
    for (const row of noPhotoCats) {
      const kind = cardImage({ hasShownPhoto: false, id: 'x', category: row.category, kind: 'place' }).kind;
      byCardKind[kind] += Number(row.n);
    }
    byCardKind.own = Number(totals[0]?.with_shown ?? 0);

    // ── Происхождение ПОКАЗЫВАЕМЫХ снимков ───────────────────────────────
    //
    // Повод 20.09: на карточках источников стоят кадры с вотермарком «alamy».
    // Раз они показаны, их род в SHOWN_MODELS — то есть правило показа их
    // пропустило, а чьи они, не знает никто. Вотермарк лежит в пикселях, SQL
    // его не видит; единственная записанная улика происхождения —
    // `source_url`, и перепись отдаёт её хост как есть.
    //
    // Пустой источник не объявляется чужим и не объявляется своим: это
    // «не знаю» (§4.0), и разбирать его человеку.
    const { rows: shownRows } = await pool.query<{
      model: string | null; source_url: string | null; author: string | null; license: string | null;
    }>(
      `SELECT i.model, i.source_url, i.author, i.license
         FROM places p
         JOIN ai_route_images i ON i.route_id = p.ark_id
        WHERE p.is_visible IS NOT FALSE AND p.merged_into_id IS NULL
          AND ${shownPhotoSql('i.model')}`,
    );

    const hostOf = (u: string | null): string => {
      if (!u || !u.trim()) return '(источник не записан)';
      try { return new URL(u.trim()).hostname.replace(/^www\./, ''); }
      catch { return '(адрес не разобран)'; }
    };

    const shownByHost: Record<string, number> = {};
    const shownByModel: Record<string, number> = {};
    for (const r of shownRows) {
      const h = hostOf(r.source_url);
      shownByHost[h] = (shownByHost[h] ?? 0) + 1;
      const m = r.model ?? '(род не записан)';
      shownByModel[m] = (shownByModel[m] ?? 0) + 1;
    }

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
      // Что стоит на карточке у каждого живого места. `own` — собственный
      // снимок; остальные три означают, что места на картинке нет.
      card_image_kind: byCardKind,
      shown_photos: {
        total: shownRows.length,
        by_model: shownByModel,
        by_source_host: shownByHost,
        without_author: shownRows.filter(r => !r.author || !r.author.trim()).length,
        without_license: shownRows.filter(r => !r.license || !r.license.trim()).length,
        note: 'вотермарк живёт в пикселях и в SQL не виден: перепись отдаёт записанный источник, приговор о правах — человеку',
      },
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
