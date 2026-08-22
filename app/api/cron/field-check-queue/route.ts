/**
 * Очередь полевых проверок — ЧТЕНИЕ.
 *
 * Владелец 22.08: «а как будут сниматься данные?». Ответ на момент вопроса
 * был — никак: `route_field_checks` писалась двумя роутами и не читалась
 * НИ ОДНИМ. Человек в поле отправлял проверку, она ложилась в базу и
 * становилась невидимой. Форма, чей результат нельзя посмотреть, — это не
 * форма, а способ потерять чужой труд.
 *
 * Здесь очередь наконец видна, и видна вместе с тем, ради чего собиралась:
 * рядом с каждой проверкой стоит НАША запись — её имя и координата, — и
 * посчитанное расхождение. Проверка сама по себе говорит «точка стоит не
 * там»; расхождение в километрах говорит, насколько.
 *
 * READ-ONLY: ничего не применяет и не помечает. Решение — за человеком.
 * Байты снимков не отдаются (очередь была бы мегабайтной): отдаётся их
 * число и вес, а сами снимки — отдельным роутом по id.
 *
 * Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const R_KM = 6371;

function distanceKm(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Row {
  id: string;
  target_kind: 'route' | 'place' | 'new';
  target_id: string | null;
  proposed_name: string | null;
  verdict: string;
  note: string | null;
  trip_tag: string | null;
  status: string;
  created_at: string;
  reported_lat: string | null;
  reported_lng: string | null;
  accuracy_m: number | null;
  object_lat: string | null;
  object_lng: string | null;
  object_source: string | null;
  photos: number;
  photo_bytes: string | null;
  photo_urls: string[] | null;
  target_title: string | null;
  target_lat: string | null;
  target_lng: string | null;
}

const num = (v: string | null): number | null => {
  if (v === null) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export async function GET(request: NextRequest) {
  if (!timingSafeCompare(getCronSecret(request), process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ success: false, error: 'Не авторизован' }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const statusRaw = (sp.get('status') ?? 'pending').trim();
  const status = ['pending', 'applied', 'rejected', 'all'].includes(statusRaw)
    ? statusRaw : 'pending';
  const rawLimit = parseInt(sp.get('limit') ?? '40', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 40;

  try {
    const { rows } = await pool.query<Row>(
      `SELECT c.id::text AS id, c.target_kind, c.target_id, c.proposed_name, c.verdict,
              c.note, c.trip_tag, c.status, c.created_at::text AS created_at,
              c.reported_lat::text AS reported_lat, c.reported_lng::text AS reported_lng,
              c.accuracy_m,
              c.object_lat::text AS object_lat, c.object_lng::text AS object_lng,
              c.object_source,
              COALESCE(p.n, 0)::int AS photos,
              p.total_bytes::text AS photo_bytes,
              p.urls AS photo_urls,
              -- Наша запись рядом с проверкой: без неё «точка не там» нечем
              -- сверить. Маршрут и место лежат в разных таблицах, поэтому
              -- обе подтягиваются и склеиваются по роду цели.
              COALESCE(r.title, pl.name) AS target_title,
              COALESCE(r.lat, pl.lat)::text AS target_lat,
              COALESCE(r.lng, pl.lng)::text AS target_lng
       FROM route_field_checks c
       LEFT JOIN (
         SELECT check_id, COUNT(*) AS n, SUM(byte_size) AS total_bytes,
                ARRAY_REMOVE(ARRAY_AGG(s3_url), NULL) AS urls
         FROM route_field_check_photos GROUP BY check_id
       ) p ON p.check_id = c.id
       LEFT JOIN kamchatka_routes r
         ON c.target_kind = 'route' AND r.id::text = c.target_id
       LEFT JOIN places pl
         ON c.target_kind = 'place' AND pl.id::text = c.target_id
       WHERE ($1 = 'all' OR c.status = $1)
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [status, limit],
    );

    const items = rows.map(r => {
      const rLat = num(r.reported_lat), rLng = num(r.reported_lng);
      const oLat = num(r.object_lat), oLng = num(r.object_lng);
      const tLat = num(r.target_lat), tLng = num(r.target_lng);
      // Расхождение считается от координаты ОБЪЕКТА, если человек её дал;
      // иначе от того места, где он стоял. Разные числа: первое говорит
      // «объект вот здесь», второе — «я был вот здесь и его не увидел».
      const fromLat = oLat ?? rLat, fromLng = oLng ?? rLng;
      const offKm = fromLat !== null && fromLng !== null && tLat !== null && tLng !== null
        ? Math.round(distanceKm(fromLat, fromLng, tLat, tLng) * 100) / 100
        : null;
      return {
        id: r.id,
        created_at: r.created_at,
        status: r.status,
        trip_tag: r.trip_tag,
        verdict: r.verdict,
        note: r.note,
        target: {
          kind: r.target_kind,
          id: r.target_id,
          // У находки (`new`) записи ещё НЕТ — здесь стоит имя, которое дал
          // человек. У проверки нашей записи null значит другое: цель не
          // нашлась, её могли скрыть или слить между выходом и разбором.
          // Два разных «нет», и путать их нельзя.
          title: r.target_kind === 'new' ? r.proposed_name : r.target_title,
          lat: tLat, lng: tLng,
        },
        stood_at: rLat !== null && rLng !== null
          ? { lat: rLat, lng: rLng, accuracy_m: r.accuracy_m } : null,
        object_at: oLat !== null && oLng !== null
          ? { lat: oLat, lng: oLng, source: r.object_source } : null,
        off_by_km: offKm,
        photos: r.photos,
        photo_kb: r.photo_bytes === null ? 0 : Math.round(parseInt(r.photo_bytes, 10) / 1024),
        // Ссылки есть только у снимков, доехавших до хранилища. Разница
        // между числом снимков и числом ссылок — это те, что легли в базу
        // запасным путём, и её видно, а не сглажено.
        photo_urls: Array.isArray(r.photo_urls) ? r.photo_urls : [],
      };
    });

    const byVerdict: Record<string, number> = {};
    for (const i of items) byVerdict[i.verdict] = (byVerdict[i.verdict] ?? 0) + 1;

    return NextResponse.json({
      success: true,
      probe: 'field_check_queue_v1',
      status,
      total: items.length,
      with_photos: items.filter(i => i.photos > 0).length,
      // Находки: по ним ЗАВОДЯТ записи, а не правят существующие — это
      // отдельная куча работы, и её размер надо видеть отдельно.
      findings: items.filter(i => i.target.kind === 'new').length,
      // Проверки, где НАША цель не нашлась: их нельзя молча считать
      // обычными. Находки сюда не попадают — у них цели нет по замыслу.
      orphaned: items.filter(i => i.target.kind !== 'new' && i.target.title === null).length,
      by_verdict: byVerdict,
      items,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка чтения очереди';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
