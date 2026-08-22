/**
 * POST /api/field-check/track — трек из полевого навигатора.
 *
 * Владелец 22.08, показав MAPS.ME: «вот простые варианты», и «для больших
 * файлов есть S3». Оба замечания меняют устройство: своего рекордера мы не
 * строим (нативный навигатор пишет трек в фоне с погашенным экраном — чего
 * браузер не умеет), а файл кладём в хранилище, не в базу.
 *
 * Что происходит с присланным файлом:
 *   1. кладётся в S3 ЦЕЛИКОМ и неизменным — исходник улики не переписывают;
 *   2. разбирается (GPX/KML/KMZ) и меряется: точки, длина, размах, доля
 *      высот, шаг;
 *   3. сличается с нашими живыми маршрутами — какой ближе и на сколько
 *      расходится;
 *   4. ложится в очередь со статусом pending.
 *
 * НИЧЕГО не применяет: ни линии не заменяет, ни записей не правит. Решение
 * за человеком — как и у всей полевой проверки.
 *
 * Публичный: трек приносит тот, кто прошёл маршрут, и требовать от него
 * аккаунта значит не получить трек.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { parseTrackFile } from '@/lib/field/track-import';
import { lineOwnership } from '@/lib/routes/line-ownership';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Потолок файла: дневной трек с секундной записью — сотни килобайт. */
const MAX_BYTES = 8_000_000;
/** Ниже этого числа точек линии нет — это метки или обрывок. */
const MIN_POINTS = 2;

const limiter = createRateLimiter({ windowMs: 60_000, max: 6 });

const BodySchema = z.object({
  /** base64 без префикса data:. */
  data: z.string().min(32).max(11_000_000),
  filename: z.string().max(200).optional(),
  note: z.string().max(600).optional(),
  trip_tag: z.string().max(60).optional(),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json(
      { success: false, error: 'Слишком много файлов подряд — подождите минуту' },
      { status: 429 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch (err) {
    const msg = err instanceof z.ZodError
      ? err.issues[0]?.message ?? 'Некорректный файл'
      : 'Некорректный файл';
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }

  const buf = Buffer.from(body.data, 'base64');
  if (buf.length === 0) {
    return NextResponse.json({ success: false, error: 'Пустой файл' }, { status: 400 });
  }
  if (buf.length > MAX_BYTES) {
    return NextResponse.json(
      { success: false, error: 'Файл больше 8 МБ — пришлите один выход, а не всю папку' },
      { status: 413 },
    );
  }

  const parsed = parseTrackFile(buf, body.filename);
  const track = parsed.tracks.find(t => t.points.length >= MIN_POINTS) ?? null;

  if (track === null && parsed.waypoints.length === 0) {
    // Отказ называется словами: «принято 0» и «разобрать не смог» —
    // разные вещи, и вторая обязана краснеть (§4.0).
    return NextResponse.json(
      {
        success: false,
        error: 'В файле не нашлось ни линии, ни точек',
        problems: parsed.problems,
      },
      { status: 422 },
    );
  }

  if (!isS3Configured) {
    // Класть мегабайты в базу мы больше не будем, а молча выбросить файл
    // тем более нельзя: человек считает, что трек ушёл.
    return NextResponse.json(
      { success: false, error: 'Хранилище файлов не настроено — трек принять некуда' },
      { status: 503 },
    );
  }

  let uploaded: { url: string; key: string };
  try {
    uploaded = await uploadToS3(
      `field-track/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${parsed.format}`,
      buf,
      parsed.format === 'kmz' ? 'application/vnd.google-earth.kmz' : 'application/xml',
    );
  } catch (err) {
    console.error('[field-check/track] S3 отказал:', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Хранилище не приняло файл — попробуйте ещё раз' },
      { status: 502 },
    );
  }

  // Какой из наших маршрутов ближе к присланной линии. Считаем по середине
  // трека: концы могут стоять на дороге заброски, а середина — там, где
  // человек шёл. Расхождение меряется тем же судьёй, что судит наши линии.
  let matchedId: string | null = null;
  let offKm: number | null = null;
  if (track !== null) {
    const mid = track.points[Math.floor(track.points.length / 2)];
    try {
      const { rows } = await pool.query<{ id: string; lat: string; lng: string }>(
        `SELECT id::text AS id, lat::text AS lat, lng::text AS lng
         FROM kamchatka_routes
         WHERE is_visible = true AND merged_into_id IS NULL
           AND lat IS NOT NULL AND lng IS NOT NULL
           AND lat BETWEEN $1 - 0.6 AND $1 + 0.6
           AND lng BETWEEN $2 - 1.0 AND $2 + 1.0`,
        [mid.lat, mid.lng],
      );
      let best = Infinity;
      for (const r of rows) {
        const lat = parseFloat(r.lat), lng = parseFloat(r.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const own = lineOwnership({
          routePoint: { lat, lng },
          coords: track.points.map(p => [p.lng, p.lat]),
        });
        const d = own.nearestKm ?? Infinity;
        if (d < best) { best = d; matchedId = r.id; }
      }
      offKm = Number.isFinite(best) ? Math.round(best * 100) / 100 : null;
      // Ближайшая запись за десятки километров — это не совпадение, а его
      // отсутствие. Пусть в очереди стоит «не нашли», а не ложная привязка.
      if (offKm !== null && offKm > 15) { matchedId = null; }
    } catch (err) {
      // Сличать не смогли — это третий исход, и он не равен «совпадения нет».
      console.error('[field-check/track] сличение не выполнено:',
        err instanceof Error ? err.message : err);
      matchedId = null;
      offKm = null;
    }
  }

  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO route_track_imports
         (source_name, format, s3_url, s3_key, byte_size,
          points, length_km, span_km, ele_share,
          step_min_m, step_median_m, step_max_m, timespan_min, waypoints,
          matched_route_id, off_by_km, problems, note, trip_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING id::text AS id`,
      [
        body.filename ?? null, parsed.format, uploaded.url, uploaded.key, buf.length,
        track?.points.length ?? null, track?.lengthKm ?? null, track?.spanKm ?? null,
        track?.eleShare ?? null,
        track?.stepM?.min ?? null, track?.stepM?.median ?? null, track?.stepM?.max ?? null,
        track?.timespanMin ?? null,
        parsed.waypoints.length,
        matchedId, offKm,
        parsed.problems.length > 0 ? parsed.problems : null,
        body.note ?? null, body.trip_tag ?? null,
      ],
    );

    return NextResponse.json({
      success: true,
      id: rows[0]?.id ?? null,
      format: parsed.format,
      track: track === null ? null : {
        points: track.points.length,
        length_km: track.lengthKm,
        span_km: track.spanKm,
        // Доля высот, а не «есть/нет»: ею §12 отличает запись прибора от
        // перерисовки, и округлять её до булева значит терять улику.
        ele_share: track.eleShare,
        step_m: track.stepM,
        // Сколько длилась запись. null — меток времени в файле нет (KML без
        // gx:Track их не несёт вовсе), и это состояние, а не ноль.
        timespan_min: track.timespanMin,
      },
      waypoints: parsed.waypoints.length,
      matched_route_id: matchedId,
      off_by_km: offKm,
      problems: parsed.problems,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка записи трека';
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
