/**
 * lib/media/video-sync.ts — привести хранилище в соответствие манифесту
 * роликов (lib/media/video-manifest.ts): залить то, чего там нет, и прочитать
 * обратно всё. Ввод-вывод передаётся снаружи — логика проверяется тестом без
 * сети, а скрипт (scripts/media/upload-videos.ts) подставляет настоящие.
 *
 * Порядок тот же, что у переезда фото (§4.1, 18.09): залить, прочитать
 * объект обратно ПУБЛИЧНЫМ адресом — тем, по которому пойдёт браузер, — и
 * сверить. Ответ хранилища «записал» не доказывает, что объект читается
 * без ключа.
 *
 * У каждого файла один из четырёх исходов, и «не смог проверить» не равен
 * «на месте» (§4.0): хранилище, ответившее 5xx или не ответившее вовсе, —
 * это отказ прогона, а не тишина.
 */
import { createHash } from 'node:crypto';
import { VIDEO_FILES, videoObjectKey, type VideoFile } from '@/lib/media/video-manifest';
import { mediaProblems } from '@/lib/media/video-hygiene';

export interface PublicRead {
  /** HTTP-статус; 0 — сеть не дошла. */
  status: number;
  type: string | null;
  /** Тело — только при 200. */
  body: Buffer | null;
}

export interface SyncIO {
  /** Файл из репозитория по пути `/video/...`; файла нет — null. */
  readLocal(path: string): Promise<Buffer | null>;
  /** Чтение объекта публичным адресом, без ключей. */
  readPublic(key: string): Promise<PublicRead>;
  /** Статус ответа на `Range: bytes=0-1`: без 206 Safari ролик не играет. */
  rangeStatus(key: string): Promise<number>;
  put(key: string, body: Buffer, type: VideoFile['type']): Promise<void>;
}

export type SyncOutcome =
  | { path: string; status: 'in_place' }
  | { path: string; status: 'uploaded' }
  | { path: string; status: 'would_upload' }
  | { path: string; status: 'failed'; reason: string };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Объект на месте и годен; иначе — почему нет. */
async function checkRemote(io: SyncIO, key: string, file: VideoFile, read: PublicRead): Promise<string | null> {
  if (!read.body || sha256(read.body) !== file.sha256) {
    return 'по ключу лежит другой файл: новый файл — новое имя (объект кэшируется на год)';
  }
  const type = (read.type ?? '').split(';')[0]!.trim();
  if (type !== file.type) return `хранилище отдаёт тип «${type || 'нет'}», нужен ${file.type}`;
  if (file.type === 'video/mp4') {
    const range = await io.rangeStatus(key);
    if (range !== 206) return `докачка кусками не работает (Range → HTTP ${range}): Safari ролик не сыграет`;
  }
  return null;
}

const absent = (status: number) => status === 403 || status === 404;

export async function syncVideos(io: SyncIO, opts: { upload: boolean }): Promise<SyncOutcome[]> {
  const out: SyncOutcome[] = [];
  for (const [path, file] of Object.entries(VIDEO_FILES)) {
    const key = videoObjectKey(path);
    const fail = (reason: string) => out.push({ path, status: 'failed', reason });

    const local = await io.readLocal(path);
    if (local) {
      if (local.length !== file.bytes || sha256(local) !== file.sha256) {
        fail('файл в репозитории не совпадает с манифестом');
        continue;
      }
      const problems = mediaProblems(local, file.type);
      if (problems.length > 0) {
        fail(`файл не годится: ${problems.join('; ')}`);
        continue;
      }
    }

    const read = await io.readPublic(key);
    if (read.status === 200) {
      const bad = await checkRemote(io, key, file, read);
      if (bad) fail(bad); else out.push({ path, status: 'in_place' });
      continue;
    }
    if (!absent(read.status)) {
      fail(`хранилище не ответило как надо: HTTP ${read.status || 'нет ответа'} — проверить не смог`);
      continue;
    }
    if (!local) { fail('нет ни в хранилище, ни в репозитории'); continue; }
    if (!opts.upload) { out.push({ path, status: 'would_upload' }); continue; }

    await io.put(key, local, file.type);
    const back = await io.readPublic(key);
    if (back.status !== 200) {
      fail(`залит, но публично не читается: HTTP ${back.status || 'нет ответа'}`);
      continue;
    }
    const bad = await checkRemote(io, key, file, back);
    if (bad) fail(`залит, но прочитанное обратно не сошлось: ${bad}`); else out.push({ path, status: 'uploaded' });
  }
  return out;
}

/** Прогон удался: файлы были, и каждый на месте, залит или (сухой прогон) готов. */
export function syncSucceeded(outcomes: SyncOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o.status !== 'failed');
}
