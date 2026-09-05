/**
 * scripts/map-tiles/build-manifests.ts — паспорта для УЖЕ залитых пакетов.
 *
 * Заливка пакета (upload-pack.ts) с 05.09 пишет паспорт сама. Но 122 пакета
 * с OSM (112 клеток + 10 районов) залиты раньше, и пересобирать их ради
 * маленького JSON — сутки Overpass и рельефа впустую. Здесь паспорт снимается
 * с тех файлов, что УЖЕ лежат в бакете: скачать каждый слой OSM пакета,
 * посчитать объекты, записать `<region>.manifest.json` рядом. Числа — с
 * залитого, не с локального: паспорт обязан описывать то, что читает карта.
 *
 * Всё или ничего — как у слоя мест: сначала все чтения, потом все записи.
 * Слой, который не скачался или не разобрался, делает пакет отказом:
 * паспорт с дырой сказал бы «не знаю» там, где надо было сказать «файл
 * испорчен», и это уже задача verify-packs, не наша.
 *
 *   MAP_PACK_BASE_URL=… S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/map-tiles/build-manifests.ts [--dry-run]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { packCacheControl } from '@/lib/map/pack-cache-policy';
import {
  osmKey, manifestKey, OSM_LAYERS, OSM_BUILT_REGIONS, BUILT_PACK_REGIONS, BUILT_GRID_CELLS,
  type OsmLayer,
} from '@/lib/map/pack-source';
import { buildPackManifest, countGeoJsonFeatures, coverageNotice, type PackManifest } from '@/lib/map/pack-manifest';
import type { PackRegionId } from '@/lib/geo/regions';
import { packUrl } from '@/scripts/map-tiles/verify-packs';

const OUT_DIR = '.cache/manifests';

/** Пакеты, у которых есть слои OSM в хранилище: районы из OSM_BUILT_REGIONS и все клетки. */
export function manifestTargets(): PackRegionId[] {
  return [
    ...BUILT_PACK_REGIONS.filter((r) => OSM_BUILT_REGIONS.includes(r)),
    ...BUILT_GRID_CELLS,
  ];
}

async function readCounts(base: string, region: PackRegionId): Promise<Partial<Record<OsmLayer, number>>> {
  const counts: Partial<Record<OsmLayer, number>> = {};
  for (const layer of OSM_LAYERS) {
    const url = packUrl(base, osmKey(region, layer));
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status !== 200) throw new Error(`${layer}: HTTP ${res.status}`);
    const n = countGeoJsonFeatures(await res.text());
    if (n === null) throw new Error(`${layer}: не FeatureCollection`);
    counts[layer] = n;
  }
  return counts;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const base = process.env.MAP_PACK_BASE_URL
    || (process.env.S3_BUCKET
      ? `${process.env.S3_ENDPOINT || 'https://s3.twcstorage.ru'}/${process.env.S3_BUCKET}`
      : '');
  if (!base) {
    console.error('Не задан адрес хранилища: нужен MAP_PACK_BASE_URL либо S3_BUCKET (+ S3_ENDPOINT).');
    return 2;
  }
  if (!dryRun && !isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (или --dry-run).');
    return 2;
  }

  const targets = manifestTargets();
  console.log(`пакетов: ${targets.length}, слоёв на пакет: ${OSM_LAYERS.length}, ${dryRun ? 'сухой прогон' : 'боевой'}`);

  // Фаза 1 — чтения. Любой отказ останавливает всё до единой записи.
  const manifests: PackManifest[] = [];
  for (const region of targets) {
    try {
      const counts = await readCounts(base, region);
      const m = buildPackManifest(region, counts);
      manifests.push(m);
      const notice = coverageNotice(m);
      console.log(`  ${region}: тропы ${counts.paths}, дороги ${counts.roads}, вода ${counts.water}, посёлки ${counts.places}${notice ? ' — ' + notice.split('.')[0] : ''}`);
    } catch (err) {
      console.error(`ОТКАЗ на ${region}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Ничего не записано: паспорта либо целиком, либо никак.');
      return 1;
    }
  }

  const noTrails = manifests.filter((m) => m.osm.paths === 0 && m.osm.roads === 0).length;
  const noPaths = manifests.filter((m) => m.osm.paths === 0).length;
  console.log(`итого: без троп ${noPaths} из ${manifests.length}, без троп и дорог ${noTrails}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({
    built_at: new Date().toISOString(),
    dry_run: dryRun,
    packs: manifests.length,
    no_paths: noPaths,
    no_trails_no_roads: noTrails,
    manifests,
  }, null, 2));

  if (dryRun) {
    console.log('сухой прогон: в хранилище ничего не записано');
    return 0;
  }

  // Фаза 2 — записи, только когда все числа на руках.
  for (const m of manifests) {
    const mk = manifestKey(m.region as PackRegionId);
    const res = await uploadToS3(mk, Buffer.from(JSON.stringify(m)), 'application/json', packCacheControl(mk));
    console.log(`  записан ${m.region} -> ${res.url}`);
  }
  console.log(`записано паспортов: ${manifests.length}. Дальше — внести их в MANIFEST_BUILT (lib/map/pack-source.ts).`);
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('build-manifests.ts')) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('Перепись паспортов не состоялась:', err);
    process.exit(2);
  });
}
