/**
 * Отдать объект хранилища телом ответа с нашего домена — общий путь раздачи
 * снимков (29.10 для `/api/images/s3`, 11.11 для снимков мест).
 *
 * Зачем не редирект. До 29.10 раздача отвечала 302 на s3.twcstorage.ru, и
 * снимок грузил браузер туриста со второго домена. Владелец с телефона:
 * «лагуна экспедиция фото до сих пор нет» — сайт открывался, снимки нет.
 * После #2841 те же снимки с нашего домена у него видны (подтвердил 11.11).
 * Второй домен — вторая точка отказа для того, кто в крае: мобильная сеть или
 * VPN, пропускающие сайт и не пропускающие хранилище, оставляют страницу
 * без снимков. Снимки мест (`/api/images/route`, `/api/images/place-gallery`)
 * до 11.11 шли редиректом — теперь тем же путём.
 *
 * Условный запрос (If-None-Match / If-Modified-Since) доходит до хранилища:
 * повторный показ — 304 без тела. Тип — только из трёх снимочных, иначе
 * `fallbackType`. Объекта нет (403/404 публичного бакета) — 404; хранилище
 * не ответило или ответило ошибкой — 502 и строка в лог (§4.0: «не смог» не
 * выдаётся за «нет»).
 */
import { NextResponse } from 'next/server';
import { s3PublicBase } from '@/lib/storage/s3';

/** Сколько ждать хранилище: дольше — туристу проще увидеть пустую рамку, чем висящую страницу. */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Типы, которые раздача берёт у хранилища как есть. */
const SERVED_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Адрес — объект НАШЕГО бакета: тот же источник (схема, хост, порт), что у
 * публичной базы хранилища, и путь внутри бакета. Только такой отдаётся с
 * нашего домена: строка в базе — не доказательство происхождения, и чужой
 * адрес (у части снимков `s3_url` — адрес источника) сервер скачивать не
 * станет — его отдаёт браузер по редиректу, как раньше.
 *
 * Сравнивается адрес ПОСЛЕ разбора по WHATWG — тем же разбором, что делает
 * fetch, — и возвращается он же (ревью безопасности #3238): строковая проверка
 * префикса и `..` пропускала `%2e%2e` и `.%2E`, которые разбор превращает в
 * `..` и уводит путь из бакета. Логин и пароль в адресе — не наш адрес.
 */
export function ourStoredUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || !url) return null;
  const base = s3PublicBase();
  // Бакета нет — база кончается на «/», своим не считается ничего.
  if (base.endsWith('/') || !URL.canParse(url) || !URL.canParse(base)) return null;
  const u = new URL(url);
  const b = new URL(`${base}/`);
  if (u.origin !== b.origin || u.username || u.password) return null;
  if (!u.pathname.startsWith(b.pathname) || u.pathname.length <= b.pathname.length) return null;
  return u.href;
}

export function isOurStoredUrl(url: string | null | undefined): url is string {
  return ourStoredUrl(url) !== null;
}

/** Тип по расширению адреса — когда хранилище своего не назвало. */
export function imageTypeByPath(url: string): string {
  const path = url.split(/[?#]/, 1)[0]!.toLowerCase();
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export async function serveStoredObject(
  url: string,
  request: Request,
  opts: { cache: string; fallbackType: string; logScope: string; source?: string },
): Promise<Response> {
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
      // По переадресации хранилища сервер не идёт (ревью безопасности #3238):
      // иначе запрос с адреса приложения ушёл бы на любой хост, куда укажет ответ.
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[${opts.logScope}] хранилище не ответило`, { url, message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: 'Снимок временно недоступен' }, { status: 502 });
  }

  const passthrough: Record<string, string> = { 'Cache-Control': opts.cache, 'X-Content-Type-Options': 'nosniff' };
  if (opts.source) passthrough['X-Source'] = opts.source;
  const etag = upstream.headers.get('etag');
  const lastModified = upstream.headers.get('last-modified');
  if (etag) passthrough.ETag = etag;
  if (lastModified) passthrough['Last-Modified'] = lastModified;

  if (upstream.status === 304) return new Response(null, { status: 304, headers: passthrough });

  if (upstream.status === 404 || upstream.status === 403) {
    // Публичный бакет на отсутствующий ключ отвечает 403 или 404 — для туриста это одно: снимка нет.
    console.error(`[${opts.logScope}] объекта нет в хранилище`, { url, status: upstream.status });
    return NextResponse.json({ error: 'Снимок не найден' }, { status: 404 });
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    console.error(`[${opts.logScope}] хранилище ответило переадресацией — не иду`, { url, status: upstream.status });
    return NextResponse.json({ error: 'Снимок временно недоступен' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    console.error(`[${opts.logScope}] хранилище ответило ошибкой`, { url, status: upstream.status });
    return NextResponse.json({ error: 'Снимок временно недоступен' }, { status: 502 });
  }

  const type = upstream.headers.get('content-type');
  const length = upstream.headers.get('content-length');
  return new Response(upstream.body, {
    status: 200,
    headers: {
      ...passthrough,
      // Пробрасываются только три типа снимков: `image/svg+xml` или иной тип
      // хранилища на нашем домене не отдаётся (ревью безопасности #3150).
      'Content-Type': type && SERVED_TYPES.has(type.split(';')[0]!.trim().toLowerCase()) ? type : opts.fallbackType,
      ...(length ? { 'Content-Length': length } : {}),
    },
  });
}
