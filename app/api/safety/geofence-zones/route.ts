/**
 * GET /api/safety/geofence-zones
 * Публичный. Возвращает опасные географические зоны для клиентского геофенсинга.
 *
 * Вулканы: зона «вулканической опасности» строится ТОЛЬКО для вулканов с
 * повышенным авиационным цветовым кодом KVERT (yellow/orange/red) из таблицы
 * volcano_status. Потухшие/спокойные сопки (Мишенная и т.п. — green/unassigned)
 * НЕ порождают красный алерт: ложная тревога на потухший вулкан обесценивает
 * настоящие KVERT-оповещения (trust-first). Термальные источники и гейзеры —
 * физическая опасность независимо от активности, остаются как были. Цунами —
 * из safety-профиля. При сбое БД — пустой массив + флаг fallback, не синтетика.
 *
 * Медведи (род `wildlife`, 19.09, #1957): из подтверждённых наблюдений
 * туристов, окно и правила — в `lib/safety/bear-sightings.ts`. До этого дня
 * род был объявлен в `ZoneHazard` и не производился ничем — объявленный исход
 * без источника (§4). Такие зоны скоропортящиеся и несут `expiresAt`.
 */
import { NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import type { GeofenceZone, ZoneHazard, ZoneLevel } from '@/lib/safety/geofence';
import {
  bearSightingZone,
  FRESH_APPROVED_SQL,
  SIGHTING_WINDOW_DAYS,
} from '@/lib/safety/bear-sightings';

export const dynamic = 'force-dynamic';

// Кеш 10 минут — зоны не меняются часто
export const revalidate = 600;

interface ThermalRow {
  id: string;
  name: string;
  lat: string | number;
  lng: string | number;
  location_type: string;
}

interface VolcanoRow {
  id: string;
  name: string;
  lat: string | number;
  lng: string | number;
  acc: 'yellow' | 'orange' | 'red';
}

interface TsunamiRow {
  id: string;
  name: string;
  lat: string | number;
  lng: string | number;
}

interface BearRow {
  id: string;
  text: string;
  lat: string | number;
  lng: string | number;
  hours_ago: string | number;
}

// ── Активные вулканы: уровень/радиус/подпись по коду KVERT ────────────────
const ACC_LABEL: Record<VolcanoRow['acc'], string> = {
  yellow: 'жёлтый',
  orange: 'оранжевый',
  red:    'красный',
};

function accToLevel(acc: VolcanoRow['acc']): ZoneLevel {
  return acc === 'yellow' ? 'danger' : 'critical'; // orange/red — критично
}

function accToRadius(acc: VolcanoRow['acc']): number {
  if (acc === 'red')    return 5_000;
  if (acc === 'orange') return 4_000;
  return 3_000; // yellow
}

// ── Термальные источники и гейзеры (физическая опасность) ─────────────────
function thermalHazard(type: string): ZoneHazard {
  return type === 'geyser' ? 'geyser' : 'thermal';
}

function thermalLevel(type: string): ZoneLevel {
  return type === 'hot_spring' ? 'danger' : 'warning';
}

function thermalRadius(type: string): number {
  return type === 'hot_spring' ? 500 : 300;
}

function thermalMessage(type: string, name: string): string {
  if (type === 'hot_spring') return `Рядом термальные источники (${name}). Температура воды до 95°C — не заходить без проверки.`;
  return `Зона гейзеров (${name}). Держитесь на маркированных тропах, не приближайтесь к выходам пара.`;
}

export async function GET() {
  const zones: GeofenceZone[] = [];
  let fallback = false;

  try {
    const [volcanoRes, thermalRes, tsunamiRes, bearRes] = await Promise.all([
      // Только вулканы с повышенным кодом KVERT (реально активные). Потухшие
      // сопки без повышенного ACC красной зоны не получают.
      pool.query<VolcanoRow>(`
        SELECT p.id::text, p.name, p.lat, p.lng, vs.aviation_color_code AS acc
        FROM places p
        JOIN volcano_status vs ON vs.place_ark_id = p.ark_id
        WHERE p.location_type = 'volcano'
          AND p.is_visible = TRUE
          AND p.lat IS NOT NULL AND p.lng IS NOT NULL
          AND vs.aviation_color_code IN ('yellow','orange','red')
        LIMIT 200
      `),
      pool.query<ThermalRow>(`
        SELECT id::text, name, lat, lng, location_type
        FROM places
        WHERE location_type IN ('hot_spring', 'geyser')
          AND is_visible = TRUE
          AND lat IS NOT NULL AND lng IS NOT NULL
        LIMIT 500
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
      // Медведи: только подтверждённые модерацией наблюдения с координатами и
      // только свежие. Предикат и окно — общие с радаром главной, чтобы карта
      // и геофенс говорили об одной Камчатке.
      pool.query<BearRow>(`
        SELECT id::text, text, lat, lng,
               EXTRACT(EPOCH FROM (NOW() - created_at))::float8 / 3600 AS hours_ago
          FROM trail_reports
         WHERE report_type = 'bear'
           AND lat IS NOT NULL AND lng IS NOT NULL
           AND ${FRESH_APPROVED_SQL}
         ORDER BY created_at DESC
         LIMIT 50
      `, [SIGHTING_WINDOW_DAYS]),
    ]);

    for (const row of volcanoRes.rows) {
      zones.push({
        id:      `volcano_${row.id}`,
        name:    row.name,
        lat:     Number(row.lat),
        lng:     Number(row.lng),
        radiusM: accToRadius(row.acc),
        hazard:  'volcano',
        level:   accToLevel(row.acc),
        message: `Активный вулкан «${row.name}» — код KVERT ${ACC_LABEL[row.acc]}. Следите за оповещениями KVERT, избегайте кратера.`,
      });
    }

    for (const row of thermalRes.rows) {
      zones.push({
        id:      `place_${row.id}`,
        name:    row.name,
        lat:     Number(row.lat),
        lng:     Number(row.lng),
        radiusM: thermalRadius(row.location_type),
        hazard:  thermalHazard(row.location_type),
        level:   thermalLevel(row.location_type),
        message: thermalMessage(row.location_type, row.name),
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

    for (const row of bearRes.rows) {
      zones.push(bearSightingZone({
        id:       row.id,
        lat:      Number(row.lat),
        lng:      Number(row.lng),
        text:     row.text,
        hoursAgo: Number(row.hours_ago),
      }));
    }
  } catch (e) {
    fallback = true;
    // Отказ не глушится (§4.0): без этой строки «зон нет» и «не смогли
    // спросить» снаружи неразличимы, а второе — это пустой геофенс в поле.
    const why = e instanceof Error ? e.message : String(e);
    const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '—';
    console.error('[geofence-zones] зоны не собраны:', code, why);
  }

  return NextResponse.json({ success: true, zones, fallback });
}
