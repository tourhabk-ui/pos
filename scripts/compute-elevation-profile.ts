#!/usr/bin/env tsx
/**
 * compute-elevation-profile.ts
 *
 * Считает высотный профиль (gain/loss/min/max) для всех kamchatka_routes
 * с geometry LineString из 3-й компоненты координат (задача L).
 *
 * Запуск:
 *   DATABASE_URL=... npx tsx scripts/compute-elevation-profile.ts           # dry-run
 *   DATABASE_URL=... npx tsx scripts/compute-elevation-profile.ts --apply   # с записью
 *
 * Честность:
 *   - в треке нет высот (синтетические LineString из waypoints, migration 168)
 *     -> поля остаются NULL, счётчик no_elevation; внешние elevation-API
 *     НЕ дёргаются (отдельная задача, если понадобится);
 *   - геометрия битая -> счётчик invalid_geometry с причиной в отчёте —
 *     это сигнал невалидной геометрии для аудита данных.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { Pool } from 'pg';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { computeElevationProfile } from '../lib/import/elevation-profile';

const APPLY = process.argv.includes('--apply');
const OUT_DIR = resolve(process.cwd(), 'data');
const REPORT_PATH = join(OUT_DIR, 'elevation-profile-report.json');

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write('ERROR: DATABASE_URL not set\n');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  const { rows } = await pool.query<{ id: string; title: string; geometry: unknown }>(
    `SELECT id::text AS id, title, geometry
     FROM kamchatka_routes
     WHERE geometry IS NOT NULL`
  );
  log(`Маршрутов с geometry: ${rows.length}`);

  const report = {
    started_at: new Date().toISOString(),
    routes_with_geometry: rows.length,
    computed: 0,
    no_elevation: 0,
    invalid_geometry: [] as Array<{ id: string; title: string; detail: string }>,
    applied: 0,
  };

  for (const row of rows) {
    const result = computeElevationProfile(row.geometry);

    if (result.kind === 'invalid_geometry') {
      report.invalid_geometry.push({ id: row.id, title: row.title, detail: result.detail });
      continue;
    }
    if (result.kind === 'no_elevation') {
      report.no_elevation++;
      continue;
    }

    report.computed++;
    if (APPLY) {
      const p = result.profile;
      await pool.query(
        `UPDATE kamchatka_routes
         SET elevation_gain_m = $2,
             elevation_loss_m = $3,
             elevation_min_m  = $4,
             elevation_max_m  = $5,
             updated_at       = NOW()
         WHERE id = $1`,
        [row.id, p.gainM, p.lossM, p.minM, p.maxM]
      );
      report.applied++;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log('');
  log('── ОТЧЁТ ─────────────────────────────────');
  log(`с geometry:          ${report.routes_with_geometry}`);
  log(`посчитано:           ${report.computed}${APPLY ? ` (записано: ${report.applied})` : ' (dry-run, без --apply)'}`);
  log(`без elevation:       ${report.no_elevation} (синтетические треки без высот — честный NULL)`);
  log(`битая геометрия:     ${report.invalid_geometry.length}`);
  for (const g of report.invalid_geometry) {
    log(`  ! ${g.title}: ${g.detail}`);
  }

  await pool.end();
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
