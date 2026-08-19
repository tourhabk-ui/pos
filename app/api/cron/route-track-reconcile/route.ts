/**
 * GET /api/cron/route-track-reconcile?secret=<CRON_SECRET>&mode=split|compare&limit=N
 *
 * Сверка нашей линии с сегодняшней страницей источника.
 *
 * Владелец 18.08: «если у иди лесом живые треки, надо спарсить заново по новым
 * правилам и сравнить — может, не спарсило правильно».
 *
 * Это единственная проверка, которую нельзя заменить измерением базы. Перепись
 * считает по тому, что В базе, и потому слепа к потерям: если разбор взял не
 * тот блок, обрезал трек или выкинул высоты, оставшееся выглядит безупречно.
 * Потерю видно только рядом с оригиналом.
 *
 * Два режима, намеренно разделённые:
 *
 *   mode=split   — только база, без сети. Сколько записей вообще можно сверить
 *                  ПОИМЁННО (у них сохранён адрес страницы-донора), а сколько
 *                  нельзя — тем трек привинтили по близости, не записав, откуда
 *                  он взят. Второе число само по себе ответ: это мера того,
 *                  насколько мы вообще знаем происхождение своих линий.
 *   mode=compare — сеть. Берёт партию сверяемых, скачивает страницу, разбирает
 *                  ОБЩИМ правилом (lib/services/ingest/track-parse) и сравнивает
 *                  с тем, что лежит у нас.
 *
 * READ-ONLY: не пишет ничего. Решение по каждому классу принимает человек —
 * перезаписывать чужими данными то, что уже показано людям, вслепую нельзя.
 *
 * Запускать только с прода: источник доступен с IP Timeweb.
 */

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { getCronSecret } from '@/lib/auth/cron';
import { pool } from '@/lib/db-pool';
import { fetchTextWithFallback } from '@/lib/services/ingest/idilesom-importer';
import { parseTrackBlocks } from '@/lib/services/ingest/track-parse';
import {
  reconcileTrack, titlesAgree, geometryFingerprint, type ReconcileVerdict,
} from '@/lib/routes/track-reconcile';
import { extractStopLinks, looksLikeStopList } from '@/lib/routes/source-stops';
import { stripSourceAttribution } from '@/lib/text/source-attribution';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Версия формы ответа. Отдаётся и в теле 401 — прогон ждёт СВОЙ код, а не
 * просто живой эндпоинт (перепись 18.08 дважды ответила цифрами старого
 * контейнера, и внешне это выглядело как ответ).
 *
 *   1 — раскладка сверяемых и сверка партии поимённо
 *   2 — режим stops: есть ли на странице источника ЭТАПЫ маршрута, которых
 *       мы никогда не забирали (264 маршрута без описанного пути)
 *   3 — Ф1 плана: результат сверки сохраняется в route_source_checks вместе с
 *       датой, донором и отпечатком проверенной линии (`save=true`)
 */
export const RECONCILE_VERSION = 3;

/** Пауза между страницами: источник чужой, и молотить его нельзя. */
const DELAY_MS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RouteRow {
  id: string;
  title: string | null;
  source_url: string | null;
  dedupe_key: string | null;
  points: string | null;
  geometry: unknown;
}

/** Линии, чьё происхождение — скрейп с чужого сайта (см. lib/map/line-standard). */
const SCRAPED_SOURCES = ['idilesom', 'external'];

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized', v: RECONCILE_VERSION }, { status: 401 });
  }

  const rawMode = request.nextUrl.searchParams.get('mode');
  const mode: 'split' | 'compare' | 'stops' =
    rawMode === 'compare' ? 'compare' : rawMode === 'stops' ? 'stops' : 'split';
  const rawLimit = parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 20, 1), 60);
  const rawOffset = parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10);
  const offset = Math.max(Number.isFinite(rawOffset) ? rawOffset : 0, 0);
  /**
   * Запись результата — только по явной просьбе.
   *
   * Сверка была read-only с рождения, и умолчание остаётся прежним: прогон,
   * который случайно записал бы в базу, — это не инструмент разбора, а
   * побочный эффект. Ф1 плана зовёт её с `save=true` осознанно.
   */
  const save = request.nextUrl.searchParams.get('save') === 'true';
  const startedAt = Date.now();

  try {
    const { rows } = await pool.query<RouteRow>(
      `SELECT id::text, title, source_url, dedupe_key,
              jsonb_array_length(geometry->'coordinates')::text AS points,
              geometry
         FROM kamchatka_routes
        WHERE geometry->>'source' = ANY($1)
        ORDER BY title`,
      [SCRAPED_SOURCES],
    );

    /** Адрес страницы-донора известен — сверять можно поимённо. */
    const identified = rows.filter(
      (r) => (r.dedupe_key ?? '').startsWith('idilesom:') || (r.source_url ?? '').includes('idilesom'),
    );
    /**
     * Донор неизвестен: трек привинтили по близости старта к центру записи
     * (scripts/import-idilesom-tracks.ts матчил в радиусе 5 км и не сохранял
     * ни имени страницы, ни её адреса). Такую линию не с чем сверять — и
     * именно она может говорить не о том маршруте, к которому прицеплена.
     */
    const anonymous = rows.filter((r) => !identified.includes(r));

    const split = {
      scraped_lines: rows.length,
      identified: identified.length,
      anonymous: anonymous.length,
      anonymous_samples: anonymous.slice(0, 15).map((r) => ({
        id: r.id,
        title: r.title ?? '(без названия)',
        points: Number(r.points ?? 0),
      })),
    };

    if (mode === 'split') {
      return NextResponse.json({
        success: true, v: RECONCILE_VERSION, mode, split,
        duration_ms: Date.now() - startedAt,
      });
    }

    // ── Этапы на странице источника ─────────────────────────────────────
    //
    // Владелец: «264 маршрута без точек — мы их просто не забрали, это ошибка
    // разбора». Проверяется чтением: какие ссылки на другие места есть на
    // странице и похоже ли, что это этапы пути.
    //
    // Ничего не импортирует. Взять всё подряд — это ровно миграция 167,
    // последствия которой мы разгребали весь вечер.
    if (mode === 'stops') {
      const batch = identified.slice(offset, offset + limit);
      let withList = 0, unreachable = 0;
      let linksTotal = 0, inRouteContext = 0;
      const pages: Array<Record<string, unknown>> = [];

      for (const r of batch) {
        const key = (r.dedupe_key ?? '').split(':')[1] ?? '';
        const url = r.source_url ?? `https://idilesom.com/kam/places/${key}`;
        const fetched = await fetchTextWithFallback(url);
        if (fetched.text === null) { unreachable += 1; await sleep(DELAY_MS); continue; }

        const links = extractStopLinks(fetched.text, key);
        const stops = links.filter((l) => l.routeContext && !l.nearbyContext);
        linksTotal += links.length;
        inRouteContext += stops.length;
        const isList = looksLikeStopList(links);
        if (isList) withList += 1;

        pages.push({
          id: r.id,
          title: r.title ?? '(без названия)',
          links: links.length,
          stops: stops.length,
          looks_like_list: isList,
          sample: stops.slice(0, 8).map((l) => ({ id: l.id, text: l.text })),
        });
        await sleep(DELAY_MS);
      }

      return NextResponse.json({
        success: true, v: RECONCILE_VERSION, mode, split,
        checked: batch.length,
        offset,
        remaining: Math.max(identified.length - offset - batch.length, 0),
        pages_with_stop_list: withList,
        links_total: linksTotal,
        links_in_route_context: inRouteContext,
        unreachable,
        pages,
        duration_ms: Date.now() - startedAt,
      });
    }

    const batch = identified.slice(offset, offset + limit);
    const verdicts: Record<ReconcileVerdict, number> = {
      same: 0, ours_truncated: 0, ours_extra: 0, elevation_lost: 0,
      line_moved: 0, source_has_no_track: 0, ours_empty: 0,
    };
    let unreachable = 0;
    let titleMismatch = 0;
    let saved = 0;
    const cases: Array<Record<string, unknown>> = [];

    for (const r of batch) {
      const url = r.source_url ?? `https://idilesom.com/kam/places/${(r.dedupe_key ?? '').split(':')[1]}`;
      const ours = Array.isArray((r.geometry as { coordinates?: unknown })?.coordinates)
        ? ((r.geometry as { coordinates: number[][] }).coordinates)
        : [];

      const fetched = await fetchTextWithFallback(url);
      if (fetched.text === null) {
        // Недоступная страница — это НЕ «трека нет»: молчание источника не
        // говорит о наших данных ничего, и смешивать его с вердиктами нельзя.
        unreachable += 1;
        cases.push({ id: r.id, title: r.title, verdict: 'unreachable', url });
        await sleep(DELAY_MS);
        continue;
      }

      const parsed = parseTrackBlocks(fetched.text);
      const theirTitle = stripSourceAttribution(
        fetched.text.match(/property="og:title"\s+content="([^"]+)"/)?.[1]?.trim() ?? '',
      );
      const res = reconcileTrack(ours, parsed.coordinates);
      verdicts[res.verdict] += 1;

      const sameName = theirTitle ? titlesAgree(r.title ?? '', theirTitle) : true;
      if (!sameName) titleMismatch += 1;

      // Ф1: улика сохраняется вместе с тем, что делает её проверяемой —
      // датой, донором и отпечатком ТОЙ линии, которую сравнивали. Без
      // отпечатка вердикт после переимпорта относился бы к другой геометрии,
      // молча продолжая давать право вести.
      if (save) {
        await pool.query(
          `INSERT INTO route_source_checks (
             route_id, verdict, donor_url, geometry_hash,
             our_points, their_points, our_elevation, their_elevation,
             start_shift_m, end_shift_m, titles_agree, method_version, checked_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
           ON CONFLICT (route_id) DO UPDATE SET
             verdict = EXCLUDED.verdict,
             donor_url = EXCLUDED.donor_url,
             geometry_hash = EXCLUDED.geometry_hash,
             our_points = EXCLUDED.our_points,
             their_points = EXCLUDED.their_points,
             our_elevation = EXCLUDED.our_elevation,
             their_elevation = EXCLUDED.their_elevation,
             start_shift_m = EXCLUDED.start_shift_m,
             end_shift_m = EXCLUDED.end_shift_m,
             titles_agree = EXCLUDED.titles_agree,
             method_version = EXCLUDED.method_version,
             checked_at = NOW()`,
          [
            r.id, res.verdict, url, geometryFingerprint(ours),
            res.ourPoints, res.theirPoints, res.ourElevation, res.theirElevation,
            res.startShiftM, res.endShiftM, sameName, RECONCILE_VERSION,
          ],
        );
        saved += 1;
      }

      if (res.verdict !== 'same' || !sameName) {
        cases.push({
          id: r.id,
          title: r.title ?? '(без названия)',
          source_title: theirTitle || null,
          verdict: res.verdict,
          titles_agree: sameName,
          our_points: res.ourPoints,
          their_points: res.theirPoints,
          start_shift_m: res.startShiftM,
          end_shift_m: res.endShiftM,
          our_elevation: res.ourElevation,
          their_elevation: res.theirElevation,
          blocks_seen: parsed.blocksSeen,
          url,
        });
      }
      await sleep(DELAY_MS);
    }

    return NextResponse.json({
      success: true,
      v: RECONCILE_VERSION,
      mode,
      split,
      checked: batch.length,
      offset,
      remaining: Math.max(identified.length - offset - batch.length, 0),
      verdicts,
      unreachable,
      title_mismatch: titleMismatch,
      saved,
      // Сколько записей в реестре улик всего — чтобы видеть, растёт ли он от
      // прогона к прогону, а не только сколько записал этот.
      stored_total: save ? (await pool.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM route_source_checks',
      )).rows[0]?.n ?? '0' : undefined,
      cases,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    // Пустой ответ читался бы как «расхождений нет» — то есть как «всё хорошо».
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Сверка не выполнена' },
      { status: 500 },
    );
  }
}
