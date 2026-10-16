/**
 * Места × контуры охраняемых территорий OSM — на раннере GitHub (15.10).
 *
 * Перепись режима по схеме парков: у 259 видимых мест режим не записан
 * (161 «нет» массовой простановки 170 и 98 «не записано», перепись
 * place-eco-census). Чтобы судить их режим, нужен контур территории. Overpass
 * 15.10 не отдал даже пакет из восьми is_in (проба 961, «at capacity»), и
 * контуры берутся из выгрузки Geofabrik — как у сверки координат
 * (places-osm-crosscheck.yml): `osmium` вырезает край, фильтрует охраняемые
 * территории и строит полигоны, этот скрипт кладёт на них точки мест.
 *
 * Только чтение: ни базы, ни прода скрипт не трогает — места приходят в
 * маркере, ответ печатается в лог.
 *
 * Запуск: npx tsx scripts/oopt-contours.ts <areas.geojsonseq> <marker.json> [<out.json>]
 *
 * Ноль контуров на весь край или ноль мест — выход 1: это поломка выгрузки
 * или маркера, а не «ни одной охраняемой территории» (§4.0).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { containingAreas, geometryArea, isProtectedArea, osmIdOfArea, type Area, type AreaGeometry } from '@/lib/geo/point-in-area';

interface AreaInfo {
  osm: string;
  name: string | null;
  title: string | null;
  protectClass: string | null;
  kind: string;
  /** Площадь порядком, км² (квадратные градусы × 111² × cos широты). */
  km2: number;
}

interface MarkerPlace { id: string; name: string; lat: number | null; lng: number | null; zone?: string | null }

function main(): number {
  const [input, markerPath, out] = process.argv.slice(2);
  if (!input || !markerPath) {
    process.stderr.write('Нужно: npx tsx scripts/oopt-contours.ts <areas.geojsonseq> <marker.json> [<out.json>]\n');
    return 2;
  }

  const areas: Area<AreaInfo>[] = [];
  let lines = 0;
  let broken = 0;
  for (const raw of readFileSync(input, 'utf8').split('\n')) {
    // geojsonseq (RFC 8142) начинает запись символом RS.
    const line = raw.replace(/^\x1e/, '').trim();
    if (!line) continue;
    lines += 1;
    try {
      const f = JSON.parse(line) as { id?: unknown; properties?: Record<string, unknown>; geometry?: AreaGeometry };
      const tags = f.properties ?? {};
      const g = f.geometry;
      if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !isProtectedArea(tags)) continue;
      const str = (k: string) => (typeof tags[k] === 'string' ? (tags[k] as string) : null);
      const first = g.type === 'Polygon' ? g.coordinates[0]?.[0] : g.coordinates[0]?.[0]?.[0];
      const cos = Math.cos(((first?.[1] ?? 55) * Math.PI) / 180);
      areas.push({
        geometry: g,
        info: {
          osm: osmIdOfArea(String(f.id ?? '?')),
          name: str('name'),
          title: str('protection_title'),
          protectClass: str('protect_class'),
          kind: str('boundary') ?? (str('leisure') ? `leisure=${str('leisure')}` : '?'),
          km2: Math.round(geometryArea(g) * 111 * 111 * cos),
        },
      });
    } catch {
      broken += 1;
    }
  }

  const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { places?: MarkerPlace[] };
  const places = (marker.places ?? []).filter((p) => p && typeof p.id === 'string');

  process.stdout.write(`строк выгрузки ${lines}, битых ${broken}, контуров охраняемых территорий ${areas.length}, мест в маркере ${places.length}\n`);
  if (broken > 0) {
    process.stderr.write(`Выгрузка содержит ${broken} нечитаемых строк — список контуров неполон, сверка по нему врала бы.\n`);
    return 1;
  }
  if (areas.length === 0) {
    process.stderr.write('Ноль контуров на весь край — поломка выгрузки, а не край без охраняемых территорий.\n');
    return 1;
  }
  if (places.length === 0) {
    process.stderr.write('В маркере нет мест — сверять нечего.\n');
    return 1;
  }

  // Перечень контуров края — сам по себе перепись: что OSM знает об ООПТ.
  process.stdout.write('\n── Контуры охраняемых территорий в выгрузке (от большего) ──\n');
  for (const a of [...areas].sort((x, y) => y.info.km2 - x.info.km2)) {
    const i = a.info;
    process.stdout.write(`${i.osm}\t${i.km2} км²\t${i.kind}\tкласс ${i.protectClass ?? '—'}\t${i.title ?? '—'}\t${i.name ?? '(без имени)'}\n`);
  }

  process.stdout.write('\n── Места: в каких контурах лежит точка (от тесного к широкому) ──\n');
  const result = places.map((p) => {
    const inside = p.lat == null || p.lng == null ? null : containingAreas(p.lng, p.lat, areas);
    const where = inside === null
      ? 'НЕТ ТОЧКИ'
      : inside.length === 0
        ? '— ни в одном контуре OSM'
        : inside.map((i) => `${i.name ?? '(без имени)'} [${i.title ?? i.kind}${i.protectClass ? `, класс ${i.protectClass}` : ''}; ${i.osm}]`).join(' ⊂ ');
    process.stdout.write(`${p.id.slice(0, 8)}\t${p.zone ?? 'NULL'}\t${p.name}\t${where}\n`);
    return { id: p.id, name: p.name, zone: p.zone ?? null, areas: inside };
  });

  const insideAny = result.filter((r) => r.areas && r.areas.length > 0).length;
  const noPoint = result.filter((r) => r.areas === null).length;
  process.stdout.write(`\nИтог: мест ${result.length}, внутри хотя бы одного контура ${insideAny}, вне всех ${result.length - insideAny - noPoint}, без точки ${noPoint}\n`);

  if (out) writeFileSync(out, JSON.stringify({ areas: areas.map((a) => a.info), places: result }));
  return 0;
}

process.exit(main());
