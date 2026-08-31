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

import { readFileSync, statSync } from 'node:fs';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { packKey } from '@/lib/map/pack-source';
import { REGIONS, type RegionId } from '@/lib/geo/regions';

async function main(): Promise<number> {
  const [region, terrainPath, contoursPath] = process.argv.slice(2);

  if (!region || !terrainPath || !contoursPath) {
    console.error('Нужно: <region-id> <terrain.pmtiles> <contours.geojson>');
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
