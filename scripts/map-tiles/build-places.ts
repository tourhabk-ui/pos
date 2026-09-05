/**
 * scripts/map-tiles/build-places.ts — слой мест платформы для КАЖДОГО пакета.
 *
 * ── Почему отдельный прогон, а не шаг в map-pack-build.yml ────────────────
 *
 * Пакетов 123 (112 клеток, 10 районов, обзор), и пересобирать их ради одного
 * лёгкого GeoJSON — часы Overpass и рельефа впустую. Слой мест не зависит от
 * DEM и от OSM: один запрос к нашему проду на пакет, один файл в бакет.
 * Значит один прогон на всё — минуты, а не сутки.
 *
 * ── Откуда данные ─────────────────────────────────────────────────────────
 *
 * GET /api/cron/places-export?region=<id> на проде (Bearer CRON_SECRET) —
 * `places` + профиль безопасности внутри bbox пакета, конверт как у слоёв
 * build_osm.py. Раннер до БД не достаёт (файрвол Timeweb), до прода по HTTPS
 * — достаёт; это то же разделение, что у переписей (§8 CLAUDE.md).
 *
 * ── Всё или ничего ────────────────────────────────────────────────────────
 *
 * Сначала ВСЕ запросы, потом ВСЕ заливки. Отказ любого запроса — прогон
 * красный и в бакет не уходит ничего: частично залитый слой выглядел бы
 * готовым на одних клетках и молча отсутствовал бы на других. Пустая
 * коллекция (ноль мест в клетке) — законный файл, он заливается: «мест
 * платформы здесь нет» — ответ, а «файла нет» — не ответ.
 *
 * Запуск:
 *   CRON_SECRET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/map-tiles/build-places.ts [--dry-run]
 *   PLACES_EXPORT_BASE переопределяет адрес прода (по умолчанию vedarai.ru).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import {
  placesKey, BUILT_PACK_REGIONS, BUILT_GRID_CELLS, OVERVIEW_BUILT,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID, type PackRegionId } from '@/lib/geo/regions';

/** Путь эндпоинта — литералом: по нему сторож cron-scheduler-declared видит, кто зовёт роут. */
const ENDPOINT = '/api/cron/places-export';
const BASE = (process.env.PLACES_EXPORT_BASE || 'https://vedarai.ru').replace(/\/+$/, '');
const OUT_DIR = '.cache/places';

interface Fetched {
  region: PackRegionId;
  body: Buffer;
  features: number;
}

/** Все пакеты, у которых есть обещание в реестрах — тот же список, что у карты. */
export function placesTargets(): PackRegionId[] {
  return [...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []), ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS];
}

async function fetchRegion(region: PackRegionId, secret: string): Promise<Fetched> {
  const url = `${BASE}${ENDPOINT}?region=${encodeURIComponent(region)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) {
    throw new Error(`${region}: HTTP ${res.status} — ${body.toString('utf-8').slice(0, 200)}`);
  }
  let parsed: { type?: unknown; features?: unknown };
  try {
    parsed = JSON.parse(body.toString('utf-8')) as { type?: unknown; features?: unknown };
  } catch (err) {
    throw new Error(`${region}: тело не JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`${region}: не FeatureCollection`);
  }
  return { region, body, features: parsed.features.length };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) {
    console.error('CRON_SECRET не задан — эндпоинт мест не спросить.');
    return 2;
  }
  if (!dryRun && !isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (или --dry-run).');
    return 2;
  }

  const targets = placesTargets();
  console.log(`пакетов: ${targets.length}, прод: ${BASE}${ENDPOINT}, ${dryRun ? 'сухой прогон' : 'боевой'}`);

  // Фаза 1 — запросы. Любой отказ останавливает всё до единой заливки.
  const fetched: Fetched[] = [];
  for (const region of targets) {
    try {
      const f = await fetchRegion(region, secret);
      fetched.push(f);
      console.log(`  ${region}: ${f.features} мест, ${(f.body.length / 1024).toFixed(1)} КБ`);
    } catch (err) {
      console.error(`ОТКАЗ на ${region}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Ничего не залито: слой либо целиком, либо никак.');
      return 1;
    }
  }

  const total = fetched.reduce((s, f) => s + f.features, 0);
  const empty = fetched.filter((f) => f.features === 0).length;
  console.log(`итого мест по пакетам (с повторами на стыках): ${total}; пустых пакетов: ${empty} из ${fetched.length}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({
    built_at: new Date().toISOString(),
    dry_run: dryRun,
    packs: fetched.length,
    features_total: total,
    empty_packs: empty,
    per_pack: fetched.map((f) => ({ region: f.region, features: f.features, bytes: f.body.length })),
  }, null, 2));

  if (dryRun) {
    console.log('сухой прогон: в хранилище ничего не записано');
    return 0;
  }

  // Фаза 2 — заливки, только когда все ответы на руках.
  for (const f of fetched) {
    const res = await uploadToS3(placesKey(f.region), f.body, 'application/geo+json');
    console.log(`  залито ${f.region} -> ${res.url}`);
  }
  console.log(`залито пакетов: ${fetched.length}. Дальше — внести их в PLACES_BUILT (lib/map/pack-source.ts).`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('build-places.ts')) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('Сборка слоя мест не состоялась:', err);
    process.exit(2);
  });
}
