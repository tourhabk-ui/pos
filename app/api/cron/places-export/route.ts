/**
 * /api/cron/places-export — места платформы для пакета карты, GeoJSON.
 *
 * ── Зачем ─────────────────────────────────────────────────────────────────
 *
 * Проверка хранилища после сборки всех 112 клеток (05.09): у корякских
 * клеток слои OSM «тропы», «приюты», «посёлки», «перевалы» — по 0.00 МБ.
 * Не потому что там ничего нет, а потому что в OSM это никто не разметил.
 * Клетка «собрана», а карта на ней — рельеф и тень, и больше ничего.
 *
 * Единственный источник, который не зависит от чужой разметки, — наша
 * таблица `places`: 779 мест с координатами, у 763 — профиль безопасности
 * (опасности, до медпомощи, спутниковая связь). На офлайн-карте их не было
 * вовсе — рисовались только OSM-точки. Этот эндпоинт отдаёт их слоем.
 *
 * ── Как читается ──────────────────────────────────────────────────────────
 *
 * Читает раннер GitHub при сборке слоя (scripts/map-tiles/build-places.ts,
 * map-places-build.yml), по одному запросу на пакет; кладёт в хранилище как
 * `<region>.places.geojson` (placesKey). Прод его читает Range-запросами из
 * бакета, как остальные слои. Живого запроса из поля к этому эндпоинту нет
 * по замыслу — офлайн-first (§1).
 *
 * Конверт — тот же, что у слоёв build_osm.py: `type`, `attribution`,
 * `built_at`, `features`. Плюс `v` — номер версии, по которому workflow
 * ждёт СВОЙ код после деплоя (тот же приём, что у route-links-repair:
 * маркер в теле 401, ожидание не требует секрета).
 *
 * ── Третье состояние (§4.0) ───────────────────────────────────────────────
 *
 * Ноль мест в клетке — законный результат: честная пустая коллекция.
 * Отказ БД — 502, файла не будет вовсе: раннер прекращает прогон, ничего
 * не заливая. Пустая коллекция и отсутствующий файл — разные ответы.
 *
 * Числа `DECIMAL` (nearest_medical_km) pg отдаёт СТРОКАМИ — тот же капкан,
 * что записан в route-lay-census; приведение делается в SQL (::float8), а
 * не «где-нибудь потом».
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';
import { packRegionBbox } from '@/lib/geo/regions';
import { PLACES_ATTRIBUTION } from '@/lib/map/pack-source';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Версия ответа. Менять вместе с поведением — workflow ждёт именно её. */
const PLACES_EXPORT_V = 1;

interface PlaceRow {
  id: string;
  name: string;
  location_type: string | null;
  lat: number;
  lng: number;
  has_safety: boolean;
  hazard_types: string[] | null;
  nearest_medical_km: number | null;
  sat_communicator_required: boolean | null;
  difficulty_level: number | null;
  altitude_m: number | null;
}

export async function GET(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    // `v` и в отказе: по нему раннер ждёт деплой, не зная секрета.
    return NextResponse.json({ error: 'Unauthorized', v: PLACES_EXPORT_V }, { status: 401 });
  }

  const region = request.nextUrl.searchParams.get('region') ?? '';
  const bbox = packRegionBbox(region);
  if (!bbox) {
    return NextResponse.json(
      { success: false, v: PLACES_EXPORT_V, error: `Неизвестный пакет «${region}» — район реестра, клетка сетки или обзор.` },
      { status: 400 },
    );
  }

  try {
    // Видимые, не слитые, с координатой, внутри bbox пакета. Профиль
    // безопасности — по ark_id (UUID места), не по id (TEXT): see place-audit.
    const { rows } = await pool.query<PlaceRow>(
      `SELECT p.id::text AS id, p.name, p.location_type,
              p.lat::float8 AS lat, p.lng::float8 AS lng,
              (sp.agent_route_id IS NOT NULL) AS has_safety,
              sp.hazard_types,
              sp.nearest_medical_km::float8 AS nearest_medical_km,
              sp.sat_communicator_required,
              sp.difficulty_level,
              sp.altitude_m
         FROM places p
         LEFT JOIN location_safety_profile sp ON sp.agent_route_id = p.ark_id
        WHERE p.is_visible = true
          AND p.merged_into_id IS NULL
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND p.lat BETWEEN $1 AND $2
          AND p.lng BETWEEN $3 AND $4
        ORDER BY p.name`,
      [bbox.south, bbox.north, bbox.west, bbox.east],
    );

    const features = rows.map((r) => ({
      type: 'Feature' as const,
      // GeoJSON — [lng, lat].
      geometry: { type: 'Point' as const, coordinates: [r.lng, r.lat] },
      properties: {
        id: r.id,
        name: r.name,
        kind: r.location_type,
        has_safety: r.has_safety,
        // Пустой список — «опасностей не записано», а не «их нет»: об этом
        // говорит has_safety, и слой обязан нести оба факта раздельно.
        hazard_types: r.hazard_types ?? [],
        nearest_medical_km: r.nearest_medical_km,
        sat_communicator_required: r.sat_communicator_required,
        difficulty_level: r.difficulty_level,
        altitude_m: r.altitude_m,
      },
    }));

    return NextResponse.json({
      type: 'FeatureCollection',
      attribution: PLACES_ATTRIBUTION,
      built_at: new Date().toISOString(),
      v: PLACES_EXPORT_V,
      region,
      features,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка выборки мест';
    console.error('[places-export] отказ выборки', region, message);
    return NextResponse.json({ success: false, v: PLACES_EXPORT_V, error: message }, { status: 502 });
  }
}
