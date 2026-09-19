/**
 * scripts/map-tiles/build-places.ts — слой мест платформы для КАЖДОГО пакета.
 *
 * ── Почему отдельный прогон, а не шаг в map-pack-build.yml ────────────────
 *
 * Пакетов 123 (112 клеток, 10 районов, обзор), и пересобирать их ради одного
 * лёгкого GeoJSON — часы Overpass и рельефа впустую. Слой мест не зависит от
 * DEM и от OSM: один запрос к нашему проду на пакет, один файл в бакет.
 * Значит один прогон на всё — минуты, а не сутки.
 *
 * ── Откуда данные ─────────────────────────────────────────────────────────
 *
 * GET /api/cron/places-export?region=<id> на проде (Bearer CRON_SECRET) —
 * `places` + профиль безопасности внутри bbox пакета, конверт как у слоёв
 * build_osm.py. Раннер до БД не достаёт (файрвол Timeweb), до прода по HTTPS
 * — достаёт; это то же разделение, что у переписей (§8 CLAUDE.md).
 *
 * ── Всё или ничего ────────────────────────────────────────────────────────
 *
 * Сначала ВСЕ запросы, потом ВСЕ заливки. Отказ любого запроса — прогон
 * красный и в бакет не уходит ничего: частично залитый слой выглядел бы
 * готовым на одних клетках и молча отсутствовал бы на других. Пустая
 * коллекция (ноль мест в клетке) — законный файл, он заливается: «мест
 * платформы здесь нет» — ответ, а «файла нет» — не ответ.
 *
 * Запуск:
 *   CRON_SECRET=… S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… \
 *     npx tsx scripts/map-tiles/build-places.ts [--dry-run]
 *   PLACES_EXPORT_BASE переопределяет адрес прода (по умолчанию vedarai.ru).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uploadToS3, isS3Configured } from '@/lib/storage/s3';
import { packCacheControl } from '@/lib/map/pack-cache-policy';
import {
  placesKey, BUILT_PACK_REGIONS, BUILT_GRID_CELLS, OVERVIEW_BUILT, PLACES_LAYER_VERSION,
} from '@/lib/map/pack-source';
import { OVERVIEW_ID, type PackRegionId } from '@/lib/geo/regions';
import { verifyReadback, verifyBeforeUpload, parseExpectAbsent, type ReadbackVerdict } from '@/lib/map/places-readback';

/** Путь эндпоинта — литералом: по нему сторож cron-scheduler-declared видит, кто зовёт роут. */
const ENDPOINT = '/api/cron/places-export';
const BASE = (process.env.PLACES_EXPORT_BASE || 'https://vedarai.ru').replace(/\/+$/, '');
const OUT_DIR = '.cache/places';

interface Fetched {
  region: PackRegionId;
  body: Buffer;
  features: number;
}

/** Все пакеты, у которых есть обещание в реестрах — тот же список, что у карты. */
export function placesTargets(): PackRegionId[] {
  return [...(OVERVIEW_BUILT ? [OVERVIEW_ID] : []), ...BUILT_PACK_REGIONS, ...BUILT_GRID_CELLS];
}

async function fetchRegion(region: PackRegionId, secret: string): Promise<Fetched> {
  const url = `${BASE}${ENDPOINT}?region=${encodeURIComponent(region)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
  const body = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) {
    throw new Error(`${region}: HTTP ${res.status} — ${body.toString('utf-8').slice(0, 200)}`);
  }
  let parsed: { type?: unknown; features?: unknown };
  try {
    parsed = JSON.parse(body.toString('utf-8')) as { type?: unknown; features?: unknown };
  } catch (err) {
    throw new Error(`${region}: тело не JSON — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
    throw new Error(`${region}: не FeatureCollection`);
  }
  return { region, body, features: parsed.features.length };
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret) {
    console.error('CRON_SECRET не задан — эндпоинт мест не спросить.');
    return 2;
  }
  if (!dryRun && !isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET (или --dry-run).');
    return 2;
  }

  // Версия слоя в коде обязана равняться run маркера этой заливки (17.09).
  // Клиент просит файл как `?v=<PLACES_LAYER_VERSION>`; заливка под старой
  // версией оставила бы телефоны на старом адресе — а значит, возможно, на
  // старом файле, ради чего версия и заведена. Проверка здесь, а не только в
  // CI: маркер пушится и запускает заливку раньше, чем тест успеет покраснеть.
  const markerRun = process.env.MAP_PLACES_RUN;
  if (!dryRun && markerRun && Number(markerRun) !== PLACES_LAYER_VERSION) {
    console.error(
      `ОТКАЗ: run маркера ${markerRun}, а PLACES_LAYER_VERSION в lib/map/pack-source.ts = ${PLACES_LAYER_VERSION}. ` +
      'Поднимите версию в коде тем же коммитом, что и run маркера, — иначе телефоны останутся на старом адресе.',
    );
    return 2;
  }

  const targets = placesTargets();
  console.log(`пакетов: ${targets.length}, прод: ${BASE}${ENDPOINT}, ${dryRun ? 'сухой прогон' : 'боевой'}, версия слоя v${PLACES_LAYER_VERSION}`);

  // Фаза 1 — запросы. Любой отказ останавливает всё до единой заливки.
  const fetched: Fetched[] = [];
  for (const region of targets) {
    try {
      const f = await fetchRegion(region, secret);
      fetched.push(f);
      console.log(`  ${region}: ${f.features} мест, ${(f.body.length / 1024).toFixed(1)} КБ`);
    } catch (err) {
      console.error(`ОТКАЗ на ${region}: ${err instanceof Error ? err.message : String(err)}`);
      console.error('Ничего не залито: слой либо целиком, либо никак.');
      return 1;
    }
  }

  const total = fetched.reduce((s, f) => s + f.features, 0);
  const empty = fetched.filter((f) => f.features === 0).length;
  console.log(`итого мест по пакетам (с повторами на стыках): ${total}; пустых пакетов: ${empty} из ${fetched.length}`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'summary.json'), JSON.stringify({
    built_at: new Date().toISOString(),
    dry_run: dryRun,
    packs: fetched.length,
    features_total: total,
    empty_packs: empty,
    per_pack: fetched.map((f) => ({ region: f.region, features: f.features, bytes: f.body.length })),
  }, null, 2));

  // Фаза 1.5 — «этого быть не должно» спрашивается ДО заливки (19.09).
  //
  // Прогон 16 залил 123 пакета, три из них со скрытым дублем каньона, и
  // только потом прочитал их обратно и покраснел. Проверка отработала верно
  // и всё равно опоздала: в поле дубль уже уехал. Ответы экспорта лежат в
  // памяти ещё до первой заливки — значит тот же вопрос можно задать раньше,
  // и тогда он не сообщает о вреде, а не даёт его причинить.
  //
  // В сухом прогоне проверка тоже идёт: «спросить и посчитать» с ответом
  // «всё хорошо» при скрытой записи в ответе экспорта — ровно то враньё, от
  // которого §4.0.
  const expectAbsent = parseExpectAbsent(process.env.PLACES_EXPECT_ABSENT);
  if (expectAbsent.length > 0) {
    console.log(`проверяю до заливки, что этих id в ответах экспорта нет: ${expectAbsent.join(', ')}`);
  }
  const pre = verifyBeforeUpload(fetched.map((f) => ({ region: f.region, body: f.body })), expectAbsent);
  if (pre.state === 'present') {
    console.error(`До заливки: в ${pre.hits.length} пакетах ЭКСПОРТ ОТДАЛ записи, которых там быть не должно:`);
    for (const hit of pre.hits) console.error(`  ${hit.region}: ${hit.ids.join(', ')}`);
    if (pre.unreadable.length > 0) console.error(`  (и ещё не разобрались: ${pre.unreadable.join(', ')})`);
    console.error('В хранилище НЕ ЗАЛИТО НИЧЕГО: на полевой карте осталось прежнее.');
    console.error('Смотреть is_visible в базе и фильтр /api/cron/places-export; миграция могла ещё не доехать до прода.');
    return 1;
  }
  if (pre.state === 'unreadable') {
    console.error(`До заливки: ${pre.regions.length} пакетов не разобрать как FeatureCollection: ${pre.regions.join(', ')}`);
    console.error('Это «не знаю», а не «скрытых нет» — в хранилище НЕ ЗАЛИТО НИЧЕГО.');
    return 1;
  }

  if (dryRun) {
    console.log('сухой прогон: в хранилище ничего не записано');
    return 0;
  }

  // Фаза 2 — заливки, только когда все ответы на руках.
  //
  // Фаза 3 — ЧТЕНИЕ ОБРАТНО (17.09). До этого дня «залито» значило одно:
  // PutObject не бросил исключение. Файл после заливки не читал никто, и
  // владелец увидел в поле место, скрытое миграцией неделю назад, при
  // зелёном прогоне и чистом коде на каждом звене, которое можно прочитать
  // из репозитория. Теперь каждый пакет читается по публичному адресу — тому
  // же, что открывает телефон, — и сверяется байт в байт. Расхождение роняет
  // прогон, а не пишет строку в лог (lib/map/places-readback.ts).
  if (expectAbsent.length > 0) {
    console.log(`после заливки проверю то же самое в хранилище: ${expectAbsent.join(', ')}`);
  }
  const bad: string[] = [];
  const stale: Array<{ region: string; ids: string[] }> = [];
  for (const f of fetched) {
    const key = placesKey(f.region);
    const res = await uploadToS3(key, f.body, 'application/geo+json', packCacheControl(key));
    const verdict = await readBack(f.region, f.body, res.url, expectAbsent);
    if (verdict.state === 'ok') {
      console.log(`  залито ${f.region} -> ${res.url} · прочитано обратно, ${verdict.features} мест, sha ${verdict.sha.slice(0, 12)}`);
    } else if (verdict.state === 'stale-content') {
      console.log(`  залито ${f.region} -> ${res.url} · байты совпали, НО в пакете скрытые записи: ${verdict.presentAbsent.join(', ')}`);
      stale.push({ region: f.region, ids: verdict.presentAbsent });
    } else {
      console.error(`  ОТКАЗ чтения обратно: ${verdict.reason}`);
      bad.push(verdict.reason);
    }
  }

  if (bad.length > 0) {
    console.error(`ЗАЛИВКА НЕ ПОДТВЕРЖДЕНА: ${bad.length} из ${fetched.length} пакетов не прочитались обратно тем, что заливали.`);
    console.error('Это не «залито с оговоркой» — это «неизвестно, что лежит в хранилище».');
    return 1;
  }
  if (stale.length > 0) {
    // Байты совпали, значит хранилище честно отдаёт то, что дал ЭКСПОРТ, —
    // и экспорт отдал скрытую запись. Это уже не про заливку, а про базу или
    // про фильтр экспорта, и прятать это за зелёным прогоном нельзя.
    console.error(`В ${stale.length} пакетах ЭКСПОРТ ОТДАЛ записи, которых там быть не должно:`);
    for (const st of stale) console.error(`  ${st.region}: ${st.ids.join(', ')}`);
    console.error('Хранилище тут ни при чём — смотреть is_visible в базе и фильтр /api/cron/places-export.');
    return 1;
  }
  console.log(`залито и прочитано обратно пакетов: ${fetched.length}. Дальше — внести новые в PLACES_BUILT (lib/map/pack-source.ts).`);
  return 0;
}

/** Прочитать пакет по публичному адресу и сверить с залитым. */
async function readBack(region: PackRegionId, uploaded: Buffer, url: string, expectAbsent: readonly string[]): Promise<ReadbackVerdict> {
  let status: number | null = null;
  let fetchedBody: Buffer | null = null;
  try {
    // Адрес обязан быть ТЕМ ЖЕ, что откроет телефон, — включая `?v=`
    // (placesUrlFor в lib/map/pack-source.ts), иначе проверяется не то, что
    // видит человек. `no-store` относится к кэшу самого раннера.
    const r = await fetch(`${url}?v=${PLACES_LAYER_VERSION}`, { cache: 'no-store' });
    status = r.status;
    fetchedBody = Buffer.from(await r.arrayBuffer());
    // Заголовки ответа хранилища — то, по чему телефон решает, перечитывать
    // ли файл. Печатаются один раз на прогон (все пакеты идут с одной
    // политикой): 17.09 выяснилось, что «no-cache в PutObject» и «no-cache в
    // ответе» никто не сверял. Адрес не печатается: бакет — секрет прогона.
    if (!headersShown) {
      headersShown = true;
      const pick = ['cache-control', 'etag', 'age', 'x-cache', 'via', 'server', 'content-type', 'last-modified'];
      const seen = pick.map((h) => `${h}: ${r.headers.get(h) ?? '—'}`).join(' · ');
      console.log(`  заголовки ответа хранилища (первый пакет): ${seen}`);
    }
  } catch (err) {
    console.error(`  чтение обратно ${region}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return verifyReadback({ region, uploaded, fetched: fetchedBody, status, expectAbsent });
}
let headersShown = false;

if (process.argv[1] && process.argv[1].endsWith('build-places.ts')) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error('Сборка слоя мест не состоялась:', err);
    process.exit(2);
  });
}
