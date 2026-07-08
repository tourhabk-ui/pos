#!/usr/bin/env tsx
/**
 * map-park-vertices.ts
 *
 * Привязка маршрутов к паркам-согласователям по матрице вершин из
 * issue #367 (Налычево: Ааг/Арик/Корякский/Авачинский; Ключевской:
 * Ключевская/Толбачик; Вачкажец). Заполняет kamchatka_routes.park_name
 * ТОЛЬКО там, где он пуст — существующие привязки не трогаются.
 *
 * Запуск:
 *   DATABASE_URL=... npx tsx scripts/map-park-vertices.ts           # dry-run
 *   DATABASE_URL=... npx tsx scripts/map-park-vertices.ts --apply   # с записью
 *
 * Честность:
 *   - ambiguous («Камень» — слишком общее слово) НЕ привязываются —
 *     только в отчёт на ручную разметку;
 *   - Авачинская бухта/залив исключены из правила «Авачинский»;
 *   - отчёт: matched / ambiguous / already_had_park / no_match.
 */

import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: '.env.local' });

import { Pool } from 'pg';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { matchTitleToPark } from '../lib/parks/permit-matrix';

const APPLY = process.argv.includes('--apply');
const OUT_DIR = resolve(process.cwd(), 'data');
const REPORT_PATH = join(OUT_DIR, 'park-vertices-report.json');

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

  const { rows } = await pool.query<{ id: string; title: string; park_name: string | null }>(
    `SELECT id::text AS id, title, park_name
     FROM kamchatka_routes
     WHERE is_visible = TRUE OR is_visible IS NULL`
  );
  log(`Маршрутов: ${rows.length}`);

  const report = {
    started_at: new Date().toISOString(),
    apply: APPLY,
    total_routes: rows.length,
    already_had_park: 0,
    matched: [] as Array<{ id: string; title: string; park: string; vertex: string }>,
    ambiguous: [] as Array<{ id: string; title: string; park: string; vertex: string }>,
    no_match: 0,
    applied: 0,
  };

  for (const row of rows) {
    if (row.park_name && row.park_name.trim()) {
      report.already_had_park++;
      continue;
    }

    const match = matchTitleToPark(row.title);
    if (!match) {
      report.no_match++;
      continue;
    }

    const entry = { id: row.id, title: row.title, park: match.parkName, vertex: match.vertex };
    if (match.confidence === 'ambiguous') {
      // НЕ привязываем — только в отчёт на ручную разметку
      report.ambiguous.push(entry);
      continue;
    }

    report.matched.push(entry);
    if (APPLY) {
      await pool.query(
        `UPDATE kamchatka_routes SET park_name = $1, updated_at = NOW() WHERE id = $2`,
        [match.parkName, row.id]
      );
      report.applied++;
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log(`Уже с парком: ${report.already_had_park}`);
  log(`Привязано (matched): ${report.matched.length}${APPLY ? ` — записано ${report.applied}` : ' (dry-run, без записи)'}`);
  log(`Ambiguous (в отчёт, без привязки): ${report.ambiguous.length}`);
  log(`Без совпадений: ${report.no_match}`);
  log(`Отчёт: ${REPORT_PATH}`);

  await pool.end();
}

main().catch(err => {
  process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
