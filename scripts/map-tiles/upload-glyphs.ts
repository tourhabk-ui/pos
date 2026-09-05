/**
 * scripts/map-tiles/upload-glyphs.ts — глифы подписей: скачать все диапазоны
 * из PACK_GLYPHS и залить в хранилище.
 *
 * Зачем отдельно (05.09). Глифы качает и заливает шаг «Глифы» сборки пакета
 * (map-pack-build.yml) — то есть только вместе с часами рельефа и Overpass.
 * Снимки пакетов на раннере (прогон 5, 33954876250) показали через прокси
 * три отказа HTTP 403 — и все три на диапазоны 8192-8447 и 8448-8703,
 * которых в PACK_GLYPHS не было: MapLibre просит их для длинного тире
 * (U+2014, «Пиначево — Центральный», стандарт имени §13) и знака номера
 * (U+2116). В поле эти знаки в подписях выпадали, и никакой сторож этого
 * не видел: MapLibre не считает отсутствующий диапазон ошибкой карты.
 *
 * Здесь — только глифы: все диапазоны реестра, из того же источника, что и
 * сборка пакета; отказ на любом — ничего не залито (карта просит ВСЕ
 * диапазоны одного шрифта, дыра выглядела бы как поломка).
 *
 *   S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/map-tiles/upload-glyphs.ts [--dry-run]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { glyphKey, PACK_GLYPHS } from '@/lib/map/pack-source';

/** Тот же источник, что у шага «Глифы» в map-pack-build.yml. */
export const GLYPH_SOURCE_BASE = 'https://protomaps.github.io/basemaps-assets/fonts';
/** Файл диапазона меньше килобайта — не глифы, а страница ошибки. */
const MIN_BYTES = 1000;

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  if (!dryRun && !isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (или --dry-run).');
    return 2;
  }
  const font = PACK_GLYPHS.fontstack;
  const enc = encodeURIComponent(font);
  console.log(`шрифт ${font}, диапазонов: ${PACK_GLYPHS.ranges.length}, ${dryRun ? 'сухой прогон' : 'боевой'}`);

  // Фаза 1 — скачать всё. Отказ на любом диапазоне — ничего не заливать.
  const files: Array<{ range: string; body: Buffer }> = [];
  for (const range of PACK_GLYPHS.ranges) {
    const url = `${GLYPH_SOURCE_BASE}/${enc}/${range}.pbf`;
    const res = await fetch(url);
    if (res.status !== 200) {
      console.error(`ОТКАЗ: ${range}: HTTP ${res.status} (${url}). Ничего не залито.`);
      return 1;
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < MIN_BYTES) {
      console.error(`ОТКАЗ: ${range}: файл подозрительно мал (${body.length} байт). Ничего не залито.`);
      return 1;
    }
    files.push({ range, body });
    console.log(`  ${range}: ${body.length} байт`);
  }

  const outDir = '.cache/glyphs';
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({
    font, dry_run: dryRun, ranges: files.map((f) => ({ range: f.range, bytes: f.body.length })),
  }, null, 2));
  if (dryRun) {
    console.log('сухой прогон: в хранилище ничего не записано');
    return 0;
  }

  // Фаза 2 — заливка, когда все файлы на руках.
  for (const f of files) {
    const res = await uploadToS3(glyphKey(font, f.range), f.body, 'application/x-protobuf');
    console.log(`  залит ${f.range} -> ${res.url}`);
  }
  console.log(`залито диапазонов: ${files.length}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('Заливка глифов не состоялась:', err);
  process.exit(2);
});
