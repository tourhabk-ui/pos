/**
 * scripts/map-tiles/upload-ocean.ts — заливка слоя океана обзорного яруса.
 *
 * Отдельно от upload-pack.ts: у того позиционный контракт «рельеф +
 * горизонтали + …», а океан — один файл к уже залитому обзору, и гонять
 * ради него пересборку рельефа (два часа чтения DEM) незачем.
 *
 * Перед заливкой файл читается: FeatureCollection с одним объектом-океаном
 * и ненулевой геометрией. Пустой или чужой файл не заливается — карта
 * покрасила бы им край.
 *
 *   S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/map-tiles/upload-ocean.ts .cache/packs/krai-overview.ocean.geojson
 */

import { readFileSync, statSync } from 'node:fs';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { packCacheControl } from '@/lib/map/pack-cache-policy';
import { oceanKey } from '@/lib/map/pack-source';
import { OVERVIEW_ID } from '@/lib/geo/regions';

async function main(): Promise<number> {
  const [path] = process.argv.slice(2);
  if (!path) {
    console.error('Нужно: <ocean.geojson>');
    return 2;
  }
  if (!isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.');
    return 1;
  }
  const size = statSync(path).size;
  const body = readFileSync(path);
  let parsed: { type?: unknown; features?: Array<{ properties?: { kind?: unknown }; geometry?: { type?: unknown } }> };
  try {
    parsed = JSON.parse(body.toString('utf-8')) as typeof parsed;
  } catch (err) {
    console.error(`Файл не JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const f = Array.isArray(parsed.features) ? parsed.features[0] : undefined;
  if (parsed.type !== 'FeatureCollection' || !f || f.properties?.kind !== 'ocean'
    || (f.geometry?.type !== 'Polygon' && f.geometry?.type !== 'MultiPolygon')) {
    console.error('Это не слой океана (ждём FeatureCollection с одним Polygon/MultiPolygon kind=ocean) — не заливаю.');
    return 1;
  }
  const res = await uploadToS3(oceanKey(OVERVIEW_ID), body, 'application/geo+json', packCacheControl(oceanKey(OVERVIEW_ID)));
  console.log(`океан: ${(size / 1024).toFixed(0)} КБ -> ${res.url}`);
  console.log('Осталось одно, руками и намеренно: OVERVIEW_OCEAN_BUILT = true (lib/map/pack-source.ts).');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('Заливка океана не состоялась:', err);
  process.exit(2);
});
