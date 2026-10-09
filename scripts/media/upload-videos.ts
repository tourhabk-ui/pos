/**
 * scripts/media/upload-videos.ts — ролики из lib/media/video-manifest.ts в
 * хранилище: залить недостающие и прочитать обратно все.
 *
 * Где исполняется (§8): раннер GitHub (video-to-s3.yml, ключи S3 в
 * секретах). Файл берётся из public/ того коммита, с которого идёт прогон;
 * после переезда файлов в репозитории нет, и прогон только сверяет
 * хранилище с манифестом. Логика — lib/media/video-sync.ts.
 *
 *   S3_ACCESS_KEY=… S3_SECRET_KEY=… S3_BUCKET=… S3_ENDPOINT=… \
 *     npx tsx scripts/media/upload-videos.ts [--upload]
 *
 * Без --upload ничего не пишется. Код выхода 0 — каждый файл на месте,
 * залит или (без --upload) готов к заливке; 1 — хоть один отказ; 2 — не
 * настроено.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isS3Configured, s3PublicUrl, uploadToS3 } from '@/lib/storage/s3';
import { syncSucceeded, syncVideos, type PublicRead, type SyncIO } from '@/lib/media/video-sync';

const WORDS = { in_place: 'на месте', uploaded: 'залит и прочитан обратно', would_upload: 'к заливке (сухой прогон)' } as const;

function urlOf(key: string): string {
  const url = s3PublicUrl(key);
  if (!url) throw new Error('S3_BUCKET не задан');
  return url;
}

const io: SyncIO = {
  async readLocal(path) {
    try {
      return await readFile(join(process.cwd(), 'public', path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  async readPublic(key): Promise<PublicRead> {
    try {
      const res = await fetch(urlOf(key));
      const body = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null;
      return { status: res.status, type: res.headers.get('content-type'), body };
    } catch (err) {
      console.error(`  сеть: ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 0, type: null, body: null };
    }
  },
  async rangeStatus(key) {
    try {
      const res = await fetch(urlOf(key), { headers: { Range: 'bytes=0-1' } });
      await res.arrayBuffer();
      return res.status;
    } catch (err) {
      console.error(`  сеть (Range): ${key}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  },
  async put(key, body, type) {
    await uploadToS3(key, body, type);
  },
};

async function main(): Promise<number> {
  const upload = process.argv.includes('--upload');
  if (!s3PublicUrl('x')) {
    console.error('S3_BUCKET не задан: публичный адрес объекта не построить.');
    return 2;
  }
  if (upload && !isS3Configured) {
    console.error('Заливка без ключей: нужны S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET.');
    return 2;
  }
  console.log(upload ? 'боевой прогон: недостающее заливается' : 'сухой прогон: только сверка');
  const outcomes = await syncVideos(io, { upload });
  for (const o of outcomes) {
    console.log(`  ${o.path}: ${o.status === 'failed' ? `ОТКАЗ — ${o.reason}` : WORDS[o.status]}`);
  }
  const count = (s: string) => outcomes.filter((o) => o.status === s).length;
  console.log(`файлов ${outcomes.length}: на месте ${count('in_place')}, залито ${count('uploaded')}, `
    + `к заливке ${count('would_upload')}, отказов ${count('failed')}`);
  if (outcomes.length === 0) console.error('манифест пуст — проверять нечего, это отказ, а не успех');
  return syncSucceeded(outcomes) ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('прогон упал:', err instanceof Error ? err.message : err);
  process.exit(1);
});
