/**
 * Выборка именованных объектов OSM по краю — на раннере GitHub (03.10).
 *
 * Зачем не с прода: публичные Overpass перестали отдавать край за то время,
 * что живёт запрос роута (сверка не проходила с 10.09; 03.10 — таймаут и 504
 * на всех четырёх серверах даже на один квадрат). Здесь можно ждать минутами,
 * брать квадраты мельче и обходить серверы по кругу. Имена с местами
 * сравнивает прод (POST /api/cron/places-osm-crosscheck): база на раннере
 * закрыта файрволом.
 *
 * Запуск: npx tsx scripts/osm-crosscheck-fetch.ts <out.json>
 * Не прочитан хоть один квадрат — выход 1 с именем квадрата и причинами по
 * каждому серверу: неполный список читался бы как «расхождений нет» (§4.0).
 */
import { writeFileSync } from 'node:fs';
import { fetchOsmFeatures, OVERPASS_ENDPOINTS_WIDE } from '@/lib/geo/osm-overpass-fetch';
import { GEOCODE_ENVELOPE } from '@/lib/geo/krai-envelope';

async function main(): Promise<number> {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write('Нужен путь к файлу: npx tsx scripts/osm-crosscheck-fetch.ts <out.json>\n');
    return 2;
  }
  const started = Date.now();
  try {
    const features = await fetchOsmFeatures(GEOCODE_ENVELOPE, {
      endpoints: OVERPASS_ENDPOINTS_WIDE,
      latStep: 2,
      lngStep: 2,
      queryTimeoutS: 180,
      tileTimeoutMs: 200_000,
      tilePauseMs: 2_000,
      rounds: 2,
      roundPauseMs: 30_000,
      onTile: ({ index, total, tile, features: n, via }) => {
        process.stdout.write(`квадрат ${index + 1}/${total} ${tile.latMin}–${tile.latMax}° × ${tile.lngMin}–${tile.lngMax}°: ${n} объектов (${via})\n`);
      },
    });
    if (features.length === 0) {
      // Ноль на весь край при живом Overpass — не «объектов нет», а поломка
      // запроса (§4.0: ноль результатов при нулевом входе — отказ).
      process.stderr.write('Overpass вернул ноль объектов на весь край — это поломка выборки, а не пустой край.\n');
      return 1;
    }
    writeFileSync(out, JSON.stringify({ features, source: `runner, ${new Date().toISOString()}` }));
    process.stdout.write(`итого ${features.length} объектов за ${Math.round((Date.now() - started) / 1000)} с → ${out}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

main().then((code) => process.exit(code));
