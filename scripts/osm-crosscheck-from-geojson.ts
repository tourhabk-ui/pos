/**
 * Объекты OSM края из выгрузки Geofabrik — на раннере GitHub (03.10).
 *
 * Почему не Overpass. Сверка не проходила с 10.09: 03.10 публичные Overpass
 * не отдали краевой запрос ни проду, ни раннеру; квадратами 2° × 2° раннер
 * прошёл 38 из 42 и упал на 39-м — четыре сервера дважды ответили 504
 * (run 10). Выгрузка Geofabrik — файл, а не чужая очередь: раннер скачивает
 * его, `osmium` вырезает край и фильтрует теги, этот скрипт превращает
 * объекты в форму ответа Overpass и разбирает тем же parseOsmFeatures.
 *
 * Запуск: npx tsx scripts/osm-crosscheck-from-geojson.ts <in.geojsonseq> <out.json>
 * Ноль объектов — выход 1: это поломка выгрузки, а не пустой край (§4.0).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  geojsonFeatureToElement, matchesCrosscheckTags, parseOsmFeatures,
  type OverpassElement,
} from '@/lib/geo/osm-crosscheck';

function main(): number {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) {
    process.stderr.write('Нужно: npx tsx scripts/osm-crosscheck-from-geojson.ts <in.geojsonseq> <out.json>\n');
    return 2;
  }
  const elements: OverpassElement[] = [];
  let lines = 0;
  let broken = 0;
  for (const raw of readFileSync(input, 'utf8').split('\n')) {
    // geojsonseq (RFC 8142) начинает запись символом RS.
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    lines += 1;
    try {
      const f = JSON.parse(line) as Parameters<typeof geojsonFeatureToElement>[0];
      const el = geojsonFeatureToElement(f);
      if (el && matchesCrosscheckTags(el.tags)) elements.push(el);
    } catch {
      broken += 1;
    }
  }
  const features = parseOsmFeatures({ elements });
  process.stdout.write(`строк ${lines}, битых ${broken}, по тегам сверки ${elements.length}, объектов ${features.length}\n`);
  if (broken > 0) {
    process.stderr.write(`Выгрузка содержит ${broken} нечитаемых строк — список неполон, сверка по нему врала бы.\n`);
    return 1;
  }
  if (features.length === 0) {
    process.stderr.write('Ноль объектов на весь край — поломка выгрузки, а не пустой край.\n');
    return 1;
  }
  writeFileSync(out, JSON.stringify({ features, source: `geofabrik far-eastern-fed-district, ${new Date().toISOString()}` }));
  return 0;
}

process.exit(main());
