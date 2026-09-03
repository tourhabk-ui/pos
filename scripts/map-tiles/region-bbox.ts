/**
 * scripts/map-tiles/region-bbox.ts — bbox района для конвейера тайлов.
 *
 * Питоновские сборщики не читают TypeScript, а вписывать координаты в
 * workflow руками — значит завести ВТОРОЙ источник истины о границах района.
 * Разъехались бы они не сразу и молча: пакет собрался бы на старый bbox, и
 * у края района карта просто кончалась бы, без единой ошибки.
 *
 * Поэтому границы всегда берутся из lib/geo/regions.ts, а этот скрипт —
 * единственный мост между ним и конвейером.
 *
 *   npx tsx scripts/map-tiles/region-bbox.ts avacha-group
 *   -> 158.4,52.8,159.4,53.6
 */

import { REGIONS, packRegionBbox } from '@/lib/geo/regions';

const region = process.argv[2];
// Район реестра или клетка сетки (cell-52n157e) — одна функция на оба.
const bbox = region ? packRegionBbox(region) : null;

if (!bbox) {
  console.error(
    `Нужен район из реестра или клетка сетки (cell-<lat>n<lng>e). Районы: ${Object.keys(REGIONS).join(', ')}`,
  );
  process.exit(2);
}
// Порядок — как у GDAL и у наших сборщиков: west,south,east,north.
process.stdout.write(`${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
