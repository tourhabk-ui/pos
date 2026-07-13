/**
 * GET /api/safety/geofence-zones
 * Публичный. Возвращает опасные географические зоны для клиентского геофенсинга.
 * Данные из places (volcano/hot_spring/geyser) + kamchatka_routes (vulkani).
 * При сбое БД — пустой массив + флаг fallback, не синтетические данные.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import type { GeofenceZone, ZoneHazard, ZoneLevel } from '@/lib/safety/geofence';

export const dynamic = 'force-dynamic';

// Кеш 10 минут — зоны не меняются часто
export const revalidate = 600;

interface PlaceRow {
  id: string;
  name: string;
  lat: string | number;
  lng: string | number;
  location_type: string;
}

interface TsunamiRow {
  id: string;
  name: string;
  lat: string | number;
  lng: string | number;
}

interface RouteRow {
  id: string;
  title: string;
  lat: string | number;
  lng: string | number;
  metadata: { height_m?: number; status?: string } | null;
}

function locationTypeToHazard(type: string): ZoneHazard {
  if (type === 'hot_spring') return 'thermal';
  if (type === 'geyser')     return 'geyser';
  return 'volcano';
}

function locationTypeToLevel(type: string): ZoneLevel {
  if (type === 'volcano') return 'danger';
  if (type === 'hot_spring') return 'danger';
  return 'warning';
}

function locationTypeToRadius(type: string): number {
  if (type === 'volcano')    return 3_000;
  if (type === 'hot_spring') return 500;
  if (type === 'geyser')     return 300;
  return 1_000;
}

function locationTypeToMessage(type: string, name: string): string {
  if (type === 'volcano')    return `Вы в зоне вулканической опасности (${name}). Следите за оповещениями KVERT, избегайте кратера.`;
  if (type === 'hot_spring') return `Рядом термальные источники (${name}). Температура воды до 95°C — не заходить без проверки.`;
  if (type === 'geyser')     return `Зона гейзеров (${name}). Держитесь на маркированных тропах, не приближайтесь к выходам пара.`;
  return `Опасная зона: ${name}`;
}

export async function GET() {
  const zones: GeofenceZone[] = [];
  let fallback = false;

  try {
    const [placesRes, routesRes, tsunamiRes] = await Promise.all([
      pool.query<PlaceRow>(`
        SELECT id::text, name, lat, lng, location_type
        FROM places
        WHERE location_type IN ('volcano', 'hot_spring', 'geyser')
          AND is_visible = TRUE
          AND lat IS NOT NULL AND lng IS NOT NULL
        -- Вулканы (высший класс опасности, радиус 3 км) — первыми, чтобы их
        -- зоны никогда не срезал LIMIT. Лимит с запасом на рост каталога.
        ORDER BY (location_type <> 'volcano'), location_type, name
        LIMIT 500
      `),
      pool.query<RouteRow>(`
        SELECT id::text, title, lat, lng, metadata
        FROM kamchatka_routes
        WHERE category = 'vulkani'
          AND is_visible = TRUE
          AND lat IS NOT NULL AND lng IS NOT NULL
        LIMIT 100
      `),
      pool.query<TsunamiRow>(`
        SELECT p.id::text, p.name, p.lat, p.lng
        FROM places p
        JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
        WHERE lsp.tsunami_risk = TRUE
          AND p.is_visible = TRUE
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL
        LIMIT 100
      `),
    ]);

    for (const row of placesRes.rows) {
      zones.push({
        id:       `place_${row.id}`,
        name:     row.name,
        lat:      Number(row.lat),
        lng:      Number(row.lng),
        radiusM:  locationTypeToRadius(row.location_type),
        hazard:   locationTypeToHazard(row.location_type),
        level:    locationTypeToLevel(row.location_type),
        message:  locationTypeToMessage(row.location_type, row.name),
      });
    }

    for (const row of routesRes.rows) {
      // Не дублируем если уже есть из places
      const dupKey = `${Number(row.lat).toFixed(3)}_${Number(row.lng).toFixed(3)}`;
      const alreadyIn = zones.some(
        z => z.hazard === 'volcano' &&
          `${z.lat.toFixed(3)}_${z.lng.toFixed(3)}` === dupKey,
      );
      if (alreadyIn) continue;

      zones.push({
        id:      `route_${row.id}`,
        name:    row.title,
        lat:     Number(row.lat),
        lng:     Number(row.lng),
        radiusM: 3_000,
        hazard:  'volcano',
        level:   'danger',
        message: `Вы в зоне вулканической опасности (${row.title}). Следите за оповещениями KVERT.`,
      });
    }
    for (const row of tsunamiRes.rows) {
      zones.push({
        id:      `tsunami_${row.id}`,
        name:    row.name,
        lat:     Number(row.lat),
        lng:     Number(row.lng),
        radiusM: 300,
        hazard:  'tsunami',
        level:   'critical',
        message: `ЦУНАМИ-ЗОНА (${row.name}). При землетрясении — немедленно уходите вверх ≥30 м от уровня моря.`,
      });
    }
  } catch {
    fallback = true;
  }

  return NextResponse.json({ success: true, zones, fallback });
}
