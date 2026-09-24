/**
 * Закачка своих пакетов карты в телефон (24.09) — со страницы, а не из
 * service worker'а.
 *
 * Почему со страницы: клетка рельефа весит до 80 МБ, на мобильной связи это
 * минуты, а браузер снимает service worker, чьё событие тянется дольше
 * нескольких минут. Страница, на которой человек стоит и смотрит прогресс,
 * живёт столько, сколько нужно. Service worker'у остаётся одно — отдать
 * сохранённое по запросу карты (public/sw.js, ветка пакетов).
 *
 * Три исхода у каждого файла (§4.0): лёг в кэш, отказ с причиной, и «не
 * знаю» у веса до закачки (сервер не назвал размер). Ни один отказ не
 * прячется: итог несёт список неудач поимённо.
 */
import { PACK_CACHE_NAME, type PackFile } from '@/lib/offline/pack-files';

export interface SizedPackFile extends PackFile {
  /** Байты по Content-Range; null — сервер не назвал, вес неизвестен. */
  bytes: number | null;
  /** Код ответа замера; null — сеть не ответила. */
  status: number | null;
}

/** Размер из заголовка `Content-Range: bytes 0-0/12345`. */
export function totalFromContentRange(h: string | null): number | null {
  const m = h?.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * Вес файлов — одним байтом с каждого (Range 0-0), до закачки: человек
 * решает, качать ли 100 МБ по мобильной связи, ДО того, как их потратит.
 */
export async function measurePackFiles(
  files: readonly PackFile[],
  fetchFn: typeof fetch = fetch,
): Promise<SizedPackFile[]> {
  return Promise.all(files.map(async (f) => {
    try {
      const res = await fetchFn(f.url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      const bytes = res.status === 206
        ? totalFromContentRange(res.headers.get('Content-Range'))
        : res.ok ? Number(res.headers.get('Content-Length')) || null : null;
      // Тело одного байта дочитываем, чтобы соединение не висело.
      await res.arrayBuffer().catch(() => undefined);
      return { ...f, bytes, status: res.status };
    } catch {
      return { ...f, bytes: null, status: null };
    }
  }));
}

export interface PackDownloadProgress {
  done: number;
  total: number;
  bytesDone: number;
  /** Файл, который качается сейчас, — чтобы долгая клетка не выглядела зависшей. */
  current: string | null;
}

export interface PackDownloadResult {
  saved: number;
  bytes: number;
  failed: Array<{ url: string; kind: string; why: string }>;
}

/**
 * Файлы по очереди: полный GET без Range → Cache Storage под ТОЧНЫМ адресом.
 * По очереди, а не разом: восемь параллельных закачек по 80 МБ на мобильной
 * связи не быстрее, зато прогресс перестаёт что-либо значить.
 */
export async function downloadPackFiles(
  files: readonly PackFile[],
  onProgress: (p: PackDownloadProgress) => void,
  deps: { fetchFn?: typeof fetch; cachesApi?: CacheStorage } = {},
): Promise<PackDownloadResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const cachesApi = deps.cachesApi ?? (typeof caches !== 'undefined' ? caches : undefined);
  if (!cachesApi) {
    return { saved: 0, bytes: 0, failed: files.map(f => ({ url: f.url, kind: f.kind, why: 'нет Cache Storage' })) };
  }
  const cache = await cachesApi.open(PACK_CACHE_NAME);
  const failed: PackDownloadResult['failed'] = [];
  let saved = 0;
  let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress({ done: i, total: files.length, bytesDone: bytes, current: f.kind });
    try {
      const res = await fetchFn(f.url, { cache: 'no-store' });
      // Только целый файл: частичный ответ (206) Cache Storage не примет, а
      // ответ без тела отдал бы карте пустоту под видом пакета.
      if (res.status !== 200) {
        failed.push({ url: f.url, kind: f.kind, why: `HTTP ${res.status}` });
        await res.arrayBuffer().catch(() => undefined);
        continue;
      }
      const len = Number(res.headers.get('Content-Length')) || 0;
      // Байты считаются по ходу потока, а не по готовому файлу: клетка
      // рельефа — до 80 МБ, и прогресс «1 из 12» минутами выглядел бы
      // зависанием. Поток идёт в кэш напрямую, в памяти файл целиком не
      // собирается.
      const base = bytes;
      let seen = 0;
      let lastMb = -1;
      const counted = res.body && typeof TransformStream !== 'undefined'
        ? new Response(res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, ctl) {
              seen += chunk.byteLength;
              // Раз в мегабайт, а не на каждый кусок: кусков на клетку —
              // тысячи, и каждый перерисовывал бы экран.
              const mb = Math.floor((base + seen) / 1e6);
              if (mb !== lastMb) {
                lastMb = mb;
                onProgress({ done: i, total: files.length, bytesDone: base + seen, current: f.kind });
              }
              ctl.enqueue(chunk);
            },
          })), { status: 200, headers: res.headers })
        : res;
      await cache.put(f.url, counted);
      // Проверка делом: файл читается обратно. Запись в кэш может молча не
      // состояться при нехватке места — тогда put отказывает, но и
      // «положили» без чтения — лишь заявление.
      const back = await cache.match(f.url);
      if (!back) {
        failed.push({ url: f.url, kind: f.kind, why: 'в кэше не оказалось после записи' });
        continue;
      }
      saved++;
      bytes += len || seen;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      failed.push({ url: f.url, kind: f.kind, why: /quota/i.test(why) ? 'не хватило места в телефоне' : why });
    }
  }
  onProgress({ done: files.length, total: files.length, bytesDone: bytes, current: null });
  return { saved, bytes, failed };
}

/** Сколько мегабайт — одной цифрой для человека. null — вес неизвестен. */
export function totalMb(files: readonly SizedPackFile[]): { mb: number; unknown: number } {
  let b = 0;
  let unknown = 0;
  for (const f of files) {
    if (f.bytes === null) unknown++;
    else b += f.bytes;
  }
  return { mb: Math.round(b / 1e6), unknown };
}
