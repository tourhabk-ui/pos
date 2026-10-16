/**
 * Места × муниципальные округа OSM — на раннере GitHub (16.10, #83).
 *
 * Перепись районов: `places.zone` — адрес тревоги без своей координаты, и
 * тревога МЧС об округе находит место, только если район назван той же
 * зоной, что получает она (lib/places/district-census.ts). Контуры округов
 * (admin_level=6) — из выгрузки Geofabrik, как у сверки охраняемых
 * территорий (place-oopt-contours.yml); точки и районы мест — из прод-
 * переписи охвата (`GET /api/cron/place-zone-census?rows=places`), которую
 * workflow скачивает перед запуском. Зона округа — разбором приёма
 * (mchs_zones), а не своей картой.
 *
 * Только чтение: ни базы, ни прода скрипт не трогает — ответ печатается в лог.
 *
 * Запуск: npx tsx scripts/place-districts.ts <districts.geojsonseq> <census.json> [<out.json>]
 *
 * Ноль округов или ноль мест — выход 1: это поломка выгрузки или переписи, а
 * не «расхождений нет» (§4.0).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { osmIdOfArea, type Area, type AreaGeometry } from '@/lib/geo/point-in-area';
import { districtCensus, type DistrictInfo, type DistrictPlace, type DistrictRow } from '@/lib/places/district-census';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';

function main(): number {
  const [input, censusPath, out] = process.argv.slice(2);
  if (!input || !censusPath) {
    process.stderr.write('Нужно: npx tsx scripts/place-districts.ts <districts.geojsonseq> <census.json> [<out.json>]\n');
    return 2;
  }

  const districts: Area<DistrictInfo>[] = [];
  for (const raw of readFileSync(input, 'utf8').split('\n')) {
    // geojsonseq (RFC 8142) начинает запись символом RS.
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    const f = JSON.parse(line) as { id?: unknown; properties?: Record<string, unknown>; geometry?: AreaGeometry };
    const tags = f.properties ?? {};
    const g = f.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    if (tags.boundary !== 'administrative' || String(tags.admin_level ?? '') !== '6') continue;
    const name = typeof tags.name === 'string' ? tags.name : null;
    if (!name) continue;
    districts.push({ geometry: g, info: { name, osm: osmIdOfArea(String(f.id ?? '?')) } });
  }

  const census = JSON.parse(readFileSync(censusPath, 'utf8')) as { ok?: boolean; place_rows?: DistrictPlace[] };
  const places = Array.isArray(census.place_rows) ? census.place_rows : [];

  if (districts.length === 0 || places.length === 0) {
    process.stdout.write(`ПЕРЕПИСЬ НЕ УДАЛАСЬ: округов ${districts.length}, мест ${places.length} — выгрузка или перепись пуста\n`);
    return 1;
  }

  const r = districtCensus(places, districts, (name) => mchs_zones(name));
  const line = (p: DistrictRow) =>
    `  ${p.id}  ${p.name}  ${p.lat ?? '—'}/${p.lng ?? '—'}  район ${p.zone ?? '—'}${p.district ? `  округ «${p.district}» (${p.district_osm})` : ''}`;

  const outLines: string[] = [];
  const say = (s: string) => outLines.push(s);
  say(`Округов в выгрузке: ${r.districts}; мест: ${r.places}`);
  say(`Совпало ${r.counts.match}, расходится ${r.counts.mismatch}, дальние округа ${r.counts.far}, `
    + `округ вне карты МЧС ${r.counts.district_unmapped}, вне округов ${r.counts.no_district}, без точки ${r.counts.no_point}`);
  say('');
  say('РАСХОЖДЕНИЯ (район места → зона тревоги его округа):');
  for (const b of r.mismatch_blocks) {
    say(`— ${b.from ?? 'без района'} → ${b.to} (${b.district}): ${b.count}`);
    for (const p of b.places) say(line(p));
  }
  say('');
  say('ДАЛЬНИЕ ОКРУГА (тревоги по координате):');
  for (const p of r.far) say(line(p));
  say('');
  say('ОКРУГ НЕ ЗНАЕТ КАРТА МЧС (тревога о нём зоны не получит):');
  for (const p of r.district_unmapped) say(line(p));
  say('');
  say('ВНЕ ОКРУГОВ (вода или край выгрузки):');
  for (const p of r.no_district) say(line(p));
  say('');
  say('БЕЗ ТОЧКИ:');
  for (const p of r.no_point) say(line(p));

  process.stdout.write(outLines.join('\n') + '\n');
  if (out) writeFileSync(out, JSON.stringify(r, null, 2));
  return 0;
}

process.exitCode = main();
