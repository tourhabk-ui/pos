#!/usr/bin/env npx tsx
/**
 * scripts/enrich-ideablocks.ts
 *
 * Прогоняет все места (places) и маршруты (kamchatka_routes) через Blockify,
 * сохраняет IdeaBlocks в таблицу ideablocks для RAG Кузьмича.
 *
 * Запуск:
 *   npx tsx scripts/enrich-ideablocks.ts                    -- всё
 *   npx tsx scripts/enrich-ideablocks.ts --source=places    -- только места
 *   npx tsx scripts/enrich-ideablocks.ts --source=routes    -- только маршруты
 *   npx tsx scripts/enrich-ideablocks.ts --limit=10         -- первые N записей
 *   npx tsx scripts/enrich-ideablocks.ts --dry-run          -- без записи в БД
 *   npx tsx scripts/enrich-ideablocks.ts --stats            -- статистика
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { ingestText, parseIdeaBlocks, type IdeaBlock } from '../lib/services/blockify';

// ── Env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  }
}
loadEnv();

const DB_URL     = process.env.DATABASE_URL ?? '';
const DRY_RUN    = process.argv.includes('--dry-run');
const STATS_ONLY = process.argv.includes('--stats');
const SOURCE     = process.argv.find(a => a.startsWith('--source='))?.split('=')[1] ?? 'all';
const LIMIT      = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '9999', 10);
const DELAY_MS   = 2500; // между запросами — rate limit free tier 10 req/min

if (!process.env.BLOCKIFY_API_KEY) { console.error('BLOCKIFY_API_KEY not set'); process.exit(1); }
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('sslmode') ? { rejectUnauthorized: false } : undefined,
  max: 3,
});

// ── Статистика ────────────────────────────────────────────────────────────────

async function showStats() {
  const r = await pool.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE source_type = 'place') AS places,
      COUNT(*) FILTER (WHERE source_type = 'route') AS routes,
      COUNT(DISTINCT source_id) AS sources
    FROM ideablocks
  `);
  const t = r.rows[0];
  console.log(`\n  ideablocks: ${t.total} блоков (${t.places} мест, ${t.routes} маршрутов, ${t.sources} источников)`);

  const sources = await pool.query(`
    SELECT source_type, COUNT(*) FROM ideablocks GROUP BY source_type ORDER BY source_type
  `);
  sources.rows.forEach(row => console.log(`  ${row.source_type}: ${row.count} блоков`));
}

// ── Сохранение блоков в БД ────────────────────────────────────────────────────

async function saveBlocks(blocks: IdeaBlock[], sourceType: 'place' | 'route', sourceId: string) {
  for (const b of blocks) {
    await pool.query(
      `INSERT INTO ideablocks
         (id, source_type, source_id, name, critical_question, trusted_answer, tags, keywords, entity_name, entity_type)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         trusted_answer = EXCLUDED.trusted_answer,
         tags           = EXCLUDED.tags,
         keywords       = EXCLUDED.keywords,
         updated_at     = NOW()`,
      [
        b.id, sourceType, sourceId, b.name,
        b.criticalQuestion, b.trustedAnswer,
        b.tags, b.keywords, b.entityName, b.entityType,
      ],
    );
  }
}

// ── Текст для места (places) ──────────────────────────────────────────────────

function buildPlaceText(row: Record<string, unknown>): string {
  const parts: string[] = [];

  const locType = (row.location_type as string | null) ?? '';
  const typeLabel: Record<string, string> = {
    volcano: 'Вулкан', lake: 'Озеро', hot_spring: 'Термальный источник',
    geyser: 'Гейзер', mountain: 'Гора', river: 'Река', beach: 'Пляж',
  };
  if (locType) parts.push(`Тип: ${typeLabel[locType] ?? locType}`);
  parts.push(`Название: ${row.name as string}`);
  if (row.description) parts.push(row.description as string);
  if (row.altitude_m) parts.push(`Высота: ${row.altitude_m} м`);
  if (row.difficulty_level) parts.push(`Сложность: ${row.difficulty_level}`);
  if (row.nearest_medical_km) parts.push(`До медпомощи: ${row.nearest_medical_km} км`);
  if (row.hazard_types) parts.push(`Опасности: ${(row.hazard_types as string[]).join(', ')}`);
  if (row.sat_communicator_required) parts.push('Требуется спутниковый коммуникатор');
  if (row.capacity_per_day) parts.push(`Вместимость: до ${row.capacity_per_day} чел/день`);

  return parts.join('\n');
}

// ── Текст для маршрута (kamchatka_routes) ────────────────────────────────────

function buildRouteText(row: Record<string, unknown>): string {
  const parts: string[] = [];

  parts.push(`Маршрут: ${row.title as string}`);
  if (row.zone) parts.push(`Зона: ${row.zone}`);
  if (row.description) parts.push(row.description as string);
  if (row.distance_km) parts.push(`Дистанция: ${row.distance_km} км`);
  if (row.duration_hours) parts.push(`Длительность: ${row.duration_hours} ч`);
  if (row.difficulty) parts.push(`Сложность: ${row.difficulty}`);
  if (row.season) parts.push(`Сезон: ${row.season}`);
  if (row.activity_type) parts.push(`Тип активности: ${row.activity_type}`);
  if (row.equipment && (row.equipment as string[]).length) {
    parts.push(`Снаряжение: ${(row.equipment as string[]).join(', ')}`);
  }
  if (row.hazards && (row.hazards as string[]).length) {
    parts.push(`Опасности: ${(row.hazards as string[]).join(', ')}`);
  }
  if (row.mchs_registration_required) {
    parts.push('Регистрация в МЧС обязательна');
    if (row.mchs_phone) parts.push(`Телефон МЧС: ${row.mchs_phone}`);
  }

  return parts.join('\n');
}

// ── Обработка одной записи ────────────────────────────────────────────────────

async function processOne(
  id: string,
  sourceType: 'place' | 'route',
  text: string,
  label: string,
  idx: number,
  total: number,
): Promise<number> {
  const prefix = `[${String(idx).padStart(3)}/${total}]`;

  if (text.length < 50) {
    console.log(`${prefix} SKIP (мало текста): ${label}`);
    return 0;
  }

  // Уже обработан?
  const existing = await pool.query(
    `SELECT COUNT(*) FROM ideablocks WHERE source_type = $1 AND source_id = $2::uuid`,
    [sourceType, id],
  );
  if (parseInt(existing.rows[0].count as string) > 0 && !DRY_RUN) {
    console.log(`${prefix} SKIP (уже есть): ${label}`);
    return 0;
  }

  process.stdout.write(`${prefix} ${label} ... `);

  try {
    const blocks = await ingestText(text, { chunkSize: 2000, delayMs: DELAY_MS });
    process.stdout.write(`${blocks.length} блоков\n`);

    if (!DRY_RUN) await saveBlocks(blocks, sourceType, id);
    else blocks.forEach(b => console.log(`   > ${b.criticalQuestion.slice(0, 80)}`));

    return blocks.length;
  } catch (e) {
    process.stdout.write(`ОШИБКА: ${e}\n`);
    return 0;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (STATS_ONLY) { await showStats(); await pool.end(); return; }

  console.log(`\nBlockify enrichment | source=${SOURCE} | limit=${LIMIT} | dry=${DRY_RUN}\n`);

  let totalBlocks = 0;

  // ── Места ──────────────────────────────────────────────────────────────────
  if (SOURCE === 'all' || SOURCE === 'places') {
    const rows = await pool.query(`
      SELECT p.id, p.name, p.description, p.location_type,
             lsp.altitude_m, lsp.difficulty_level, lsp.nearest_medical_km,
             lsp.hazard_types, lsp.sat_communicator_required, lsp.capacity_per_day
      FROM places p
      LEFT JOIN location_safety_profile lsp ON lsp.agent_route_id = p.ark_id
      WHERE p.description IS NOT NULL AND length(p.description) > 100
      ORDER BY p.name
      LIMIT $1
    `, [LIMIT]);

    console.log(`Места: ${rows.rows.length} записей\n`);

    for (let i = 0; i < rows.rows.length; i++) {
      const row = rows.rows[i] as Record<string, unknown>;
      const text = buildPlaceText(row);
      totalBlocks += await processOne(
        row.id as string, 'place', text, row.name as string, i + 1, rows.rows.length,
      );
    }
  }

  // ── Маршруты ───────────────────────────────────────────────────────────────
  if (SOURCE === 'all' || SOURCE === 'routes') {
    const rows = await pool.query(`
      SELECT id, title, description, zone, distance_km, duration_hours,
             difficulty, season, activity_type, equipment, hazards,
             mchs_registration_required, mchs_phone
      FROM kamchatka_routes
      WHERE description IS NOT NULL AND length(description) > 100
      ORDER BY title
      LIMIT $1
    `, [LIMIT]);

    console.log(`\nМаршруты: ${rows.rows.length} записей\n`);

    for (let i = 0; i < rows.rows.length; i++) {
      const row = rows.rows[i] as Record<string, unknown>;
      const text = buildRouteText(row);
      totalBlocks += await processOne(
        row.id as string, 'route', text, row.title as string, i + 1, rows.rows.length,
      );
    }
  }

  console.log(`\nИтого: ${totalBlocks} блоков создано`);
  if (!DRY_RUN) { console.log('\nСтатистика:'); await showStats(); }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
