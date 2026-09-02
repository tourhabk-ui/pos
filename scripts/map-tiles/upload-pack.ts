/**
 * scripts/map-tiles/upload-pack.ts — кладёт собранный пакет района в хранилище.
 *
 * Разделение труда намеренное и повторяет §8 («два ключа: какой откуда»):
 *   - СОБИРАЕТ пакет раннер — там есть Python, rasterio и сеть до Copernicus;
 *   - ХРАНИТ объектное хранилище Timeweb — то же, куда платформа уже кладёт
 *     фото и видео (lib/storage/s3.ts);
 *   - ЧИТАЕТ прод, Range-запросами через pmtiles.
 *
 * В репозиторий пакет не кладётся никогда: §6.1, лимит standalone 50 МБ.
 * Один район — ~11.3 МБ (замер 31.08 на «Авачинской группе»), десять районов
 * реестра уронили бы деплой, причём не сразу и молча.
 *
 * Запуск:
 *   S3_ACCESS_KEY=... S3_SECRET_KEY=... S3_BUCKET=... \
 *   npx tsx scripts/map-tiles/upload-pack.ts avacha-group \
 *     .cache/packs/avacha-group.terrain.pmtiles \
 *     .cache/packs/avacha-group.contours.geojson
 */

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { packKey, glyphKey, osmKey, PACK_GLYPHS, OSM_LAYERS } from '@/lib/map/pack-source';
import { REGIONS, type RegionId } from '@/lib/geo/regions';

async function main(): Promise<number> {
  const [region, terrainPath, contoursPath, glyphsDir, osmPrefix] = process.argv.slice(2);

  if (!region || !terrainPath || !contoursPath) {
    console.error('Нужно: <region-id> <terrain.pmtiles> <contours.geojson> [<glyphs-dir>] [<osm-prefix>]');
    return 2;
  }
  if (!(region in REGIONS)) {
    console.error(`Неизвестный район «${region}». Есть: ${Object.keys(REGIONS).join(', ')}`);
    return 2;
  }
  if (!isS3Configured) {
    // Отказ называет причину. Тихий выход с нулём означал бы «залито».
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.');
    return 1;
  }

  const items: Array<{ kind: 'terrain' | 'contours'; path: string; type: string }> = [
    { kind: 'terrain', path: terrainPath, type: 'application/octet-stream' },
    { kind: 'contours', path: contoursPath, type: 'application/geo+json' },
  ];

  for (const it of items) {
    const size = statSync(it.path).size;
    if (size === 0) {
      // Пустой файл заливать нельзя: на клиенте он выглядел бы как «пакет
      // есть», а карта осталась бы пустой — худший из исходов (§4.0).
      console.error(`ПУСТОЙ файл ${it.path} — прекращаю, ничего не залито.`);
      return 1;
    }
    const key = packKey(region as RegionId, it.kind);
    const res = await uploadToS3(key, readFileSync(it.path), it.type);
    console.log(`${it.kind}: ${(size / 1024 / 1024).toFixed(2)} МБ -> ${res.url}`);
  }

  // Глифы — общие для всех районов, потому не под ключом района. Каталог
  // <glyphs-dir>/<fontstack>/<range>.pbf; заливаются ВСЕ ожидаемые диапазоны
  // или ни одного: подписи с дырой в кириллице выглядели бы как «шрифт
  // сломан», а не как «половину не залили».
  if (glyphsDir) {
    const dir = join(glyphsDir, PACK_GLYPHS.fontstack);
    if (!existsSync(dir)) {
      console.error(`Каталога глифов ${dir} нет — прекращаю, глифы не залиты.`);
      return 1;
    }
    const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.pbf')).map((f) => f.replace(/\.pbf$/, '')));
    const missing = PACK_GLYPHS.ranges.filter((r) => !present.has(r));
    if (missing.length > 0) {
      console.error(`Не хватает диапазонов глифов: ${missing.join(', ')} — прекращаю, глифы не залиты.`);
      return 1;
    }
    for (const range of PACK_GLYPHS.ranges) {
      const p = join(dir, `${range}.pbf`);
      const size = statSync(p).size;
      if (size === 0) {
        console.error(`ПУСТОЙ файл глифов ${p} — прекращаю.`);
        return 1;
      }
      const res = await uploadToS3(glyphKey(PACK_GLYPHS.fontstack, range), readFileSync(p), 'application/x-protobuf');
      console.log(`глифы ${range}: ${(size / 1024).toFixed(0)} КБ -> ${res.url}`);
    }
  }

  // OSM-слои — все из списка или ни одного: карта просит адреса по списку
  // OSM_LAYERS, и дыра в списке выглядела бы как ошибка загрузки поверх
  // живого рельефа. Пустой слой (нет ледников) — законная пустая коллекция,
  // не пустой файл: размер у неё ненулевой.
  if (osmPrefix) {
    const files = OSM_LAYERS.map((l) => ({ layer: l, path: `${osmPrefix}.osm.${l}.geojson` }));
    const missing = files.filter((f) => !existsSync(f.path) || statSync(f.path).size === 0);
    if (missing.length > 0) {
      console.error(`Нет OSM-слоёв: ${missing.map((m) => m.layer).join(', ')} — прекращаю, OSM не залит.`);
      return 1;
    }
    for (const f of files) {
      const size = statSync(f.path).size;
      const res = await uploadToS3(osmKey(region as RegionId, f.layer), readFileSync(f.path), 'application/geo+json');
      console.log(`osm ${f.layer}: ${(size / 1024).toFixed(0)} КБ -> ${res.url}`);
    }
    console.log(`  3. внести '${region}' в OSM_BUILT_REGIONS (lib/map/pack-source.ts)`);
  }

  console.log('');
  console.log('Осталось два шага, оба руками и намеренно:');
  console.log(`  1. внести '${region}' в BUILT_PACK_REGIONS (lib/map/pack-source.ts)`);
  console.log('  2. задать NEXT_PUBLIC_MAP_PACK_BASE_URL в переменных Timeweb');
  console.log('Список собранных пакетов — обещание, что файл на месте; опрос');
  console.log('бакета ради этого ответа не прошёл бы именно в офлайне.');
  return 0;
}

main().then(code => process.exit(code)).catch(err => {
  console.error('Заливка не удалась:', err);
  process.exit(1);
});
