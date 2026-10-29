import { NextResponse } from 'next/server';
import { s3PublicUrl } from '@/lib/storage/s3';
import { photoKeyOf } from '@/lib/images/photo-key';

export const dynamic = 'force-dynamic';

interface Props { params: Promise<{ key: string[] }> }

/** Сколько ждать хранилище: дольше — туристу проще увидеть пустую рамку, чем висящую страницу. */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Сутки в браузере, неделя «устаревшим, пока освежается»: снимок по ключу меняется редко. */
const CACHE = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * GET /api/images/s3/photos/<…>.jpg — снимок из хранилища по ключу.
 *
 * Зачем адрес на нашем домене (14.10). Статья «Летописи Камчатки» — константа
 * в коде и собирается при сборке образа (generateStaticParams), а адрес объекта
 * хранилища собирается из S3_BUCKET, которого на сборке может не быть.
 *
 * Байты — с нашего домена, а не редиректом (29.10). До этого дня сервер
 * отвечал 302 на s3.twcstorage.ru, и снимок грузил браузер туриста со второго
 * домена. Владелец 29.10 с телефона: «лагуна экспедиция фото до сих пор нет» —
 * страница vedarai.ru открылась, а 133 снимка «Лагуны Экспедиции», которые из
 * песочницы и браузера разработки отвечали 200, на его телефоне остались
 * пустыми рамками. Второй домен — вторая точка отказа для того, кто в крае:
 * мобильная сеть или VPN, пропускающие сайт и не пропускающие хранилище,
 * оставляют страницу без снимков. Теперь сервер сам читает объект и отдаёт
 * его телом ответа; браузер видит один домен.
 *
 * Только ключи под `photos/` — снимки, залитые media-to-s3 (scripts/
 * media-to-s3.ts) вместе с автором и лицензией в миграции; только `.jpg`,
 * строчная латиница, без `..`. Чужой префикс (`places/<uuid>/` уборки сирот,
 * пакеты карты) этим путём не открывается: адресуемо ровно то, что
 * публикуется. Бакета нет — 404. Хранилище ответило «нет объекта» — 404;
 * не ответило или ответило ошибкой — 502 и строка в лог (§4.0: «не смог» не
 * выдаётся за «нет»).
 */
export async function GET(request: Request, { params }: Props): Promise<Response> {
  const { key: parts } = await params;
  const key = photoKeyOf(parts ?? []);
  if (!key) return NextResponse.json({ error: 'Снимок не найден' }, { status: 404 });
  const url = s3PublicUrl(key);
  if (!url) return NextResponse.json({ error: 'Хранилище не настроено' }, { status: 404 });

  // Условный запрос браузера доходит до хранилища: повторный показ — 304 без тела.
  const conditional: Record<string, string> = {};
  const inm = request.headers.get('if-none-match');
  const ims = request.headers.get('if-modified-since');
  if (inm) conditional['If-None-Match'] = inm;
  if (ims) conditional['If-Modified-Since'] = ims;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: conditional,
      cache: 'no-store',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[images/s3] хранилище не ответило', { key, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Снимок временно недоступен' }, { status: 502 });
  }

  const passthrough: Record<string, string> = { 'Cache-Control': CACHE, 'X-Content-Type-Options': 'nosniff' };
  const etag = upstream.headers.get('etag');
  const lastModified = upstream.headers.get('last-modified');
  if (etag) passthrough.ETag = etag;
  if (lastModified) passthrough['Last-Modified'] = lastModified;

  if (upstream.status === 304) return new Response(null, { status: 304, headers: passthrough });

  if (upstream.status === 404 || upstream.status === 403) {
    // Публичный бакет на отсутствующий ключ отвечает 403 или 404 — для туриста это одно: снимка нет.
    console.error('[images/s3] объекта нет в хранилище', { key, status: upstream.status });
    return NextResponse.json({ error: 'Снимок не найден' }, { status: 404 });
  }
  if (!upstream.ok || !upstream.body) {
    console.error('[images/s3] хранилище ответило ошибкой', { key, status: upstream.status });
    return NextResponse.json({ error: 'Снимок временно недоступен' }, { status: 502 });
  }

  const type = upstream.headers.get('content-type');
  const length = upstream.headers.get('content-length');
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...passthrough,
      // Ключ — только .jpg (photoKeyOf); чужой тип хранилища не пробрасываем.
      'Content-Type': type && type.startsWith('image/') ? type : 'image/jpeg',
      ...(length ? { 'Content-Length': length } : {}),
    },
  });
}
