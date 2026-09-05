/**
 * scripts/map-tiles/stamp-cache-control.ts — перештамповать Cache-Control у
 * уже лежащих в хранилище файлов пакетов карты.
 *
 * Зачем — lib/map/pack-cache-policy.ts: всё под map-packs/ залито с
 * «год, immutable», а архивам по Range нужен `no-store`, остальному —
 * `no-cache`. Новая заливка это делает сама; здесь — те 2800 объектов, что
 * уже лежат. Тело не перекачивается: копия объекта в себя с заменой
 * метаданных (restampObject).
 *
 * Список ключей — тот же реестр, что у проверки хранилища
 * (packKeysToVerify): чего нет в реестре, того карта не просит, и штамповать
 * это незачем. Три исхода (§4.0): сколько переписано, сколько отказов —
 * поимённо, и «сухой прогон» (--dry-run), который только считает.
 *
 *   S3_ACCESS_KEY=... S3_SECRET_KEY=... S3_BUCKET=... \
 *   npx tsx scripts/map-tiles/stamp-cache-control.ts [--dry-run] [--only pmtiles]
 */

import { restampObject, isS3Configured } from '@/lib/storage/s3';
import { packCacheControl, packContentType } from '@/lib/map/pack-cache-policy';
import { packKeysToVerify } from '@/scripts/map-tiles/verify-packs';

/** Одновременных запросов к хранилищу: перепись 22.08 шла по 8 без отказов. */
const CONCURRENCY = 8;

export interface StampPlan {
  key: string;
  contentType: string;
  cacheControl: string;
}

/** Что и чем штамповать; --only pmtiles сужает до архивов (самый срочный род). */
export function stampPlan(only: 'pmtiles' | null): StampPlan[] {
  return packKeysToVerify()
    .map(({ key }) => key)
    .filter((key) => (only === 'pmtiles' ? key.endsWith('.pmtiles') : true))
    .map((key) => ({ key, contentType: packContentType(key), cacheControl: packCacheControl(key) }));
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 && argv[onlyIdx + 1] === 'pmtiles' ? 'pmtiles' : null;
  const plan = stampPlan(only);
  const byPolicy = plan.reduce<Record<string, number>>((acc, p) => { acc[p.cacheControl] = (acc[p.cacheControl] ?? 0) + 1; return acc; }, {});
  console.log(`объектов к штамповке: ${plan.length} (${Object.entries(byPolicy).map(([k, n]) => `${k}: ${n}`).join(', ')})${only ? `, только ${only}` : ''}`);
  if (dryRun) {
    console.log('сухой прогон — хранилище не трогалось');
    return 0;
  }
  if (!isS3Configured) {
    console.error('S3 не настроен: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.');
    return 2;
  }
  let done = 0;
  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < plan.length) {
      const p = plan[next++];
      try {
        await restampObject(p.key, p.contentType, p.cacheControl);
        done += 1;
        if (done % 200 === 0) console.log(`  переписано ${done}/${plan.length}`);
      } catch (err) {
        failures.push(`${p.key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`переписано ${done}, отказов ${failures.length}`);
  for (const f of failures.slice(0, 20)) console.log(`  отказ: ${f}`);
  if (failures.length > 20) console.log(`  … и ещё ${failures.length - 20}`);
  return failures.length ? 1 : 0;
}

if (process.argv[1] && /stamp-cache-control\.ts$/.test(process.argv[1])) {
  main().then((code) => process.exit(code), (err: unknown) => {
    console.error('штамповка: необработанный отказ', err);
    process.exit(2);
  });
}
